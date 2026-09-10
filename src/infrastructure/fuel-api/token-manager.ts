import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { oauthTokenCache } from "../db/schema";
import { err, ok, type Result } from "../../domain/result";
import { performRequest } from "./http-client";
import type { FuelApiError } from "./types";

const TOKEN_CACHE_ID = "singleton"; // one row — see oauth-token-cache.ts's module comment.

/** Arbitrary fixed key for the single-flight advisory lock — only ever one lock in this
 * codebase for now, so a single literal is clearer than a hash-of-a-string scheme nothing else
 * needs yet. */
const TOKEN_REFRESH_LOCK_KEY = 727_272;

/** §7.5: refresh at 80% of the token's life, not at literal expiry — clock skew makes
 * expiry-time refresh a source of intermittent 401s. */
const REFRESH_AT_FRACTION_OF_LIFE = 0.8;

type TokenManagerDb = Pick<PostgresJsDatabase, "select" | "insert" | "update" | "execute">;

function isFresh(cached: { updatedAt: Date; expiresAt: Date }, now: Date): boolean {
  const lifespanMs = cached.expiresAt.getTime() - cached.updatedAt.getTime();
  const refreshAt = cached.updatedAt.getTime() + lifespanMs * REFRESH_AT_FRACTION_OF_LIFE;
  return now.getTime() < refreshAt;
}

async function readCachedToken(
  db: Pick<PostgresJsDatabase, "select">,
): Promise<{ accessToken: string; updatedAt: Date; expiresAt: Date } | undefined> {
  const rows = await db
    .select({
      accessToken: oauthTokenCache.accessToken,
      updatedAt: oauthTokenCache.updatedAt,
      expiresAt: oauthTokenCache.expiresAt,
    })
    .from(oauthTokenCache)
    .where(eq(oauthTokenCache.id, TOKEN_CACHE_ID))
    .limit(1);
  return rows[0];
}

async function requestNewToken(
  baseUrl: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<Result<{ accessToken: string; expiresInSeconds: number }, FuelApiError>> {
  const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const url = `${baseUrl}/oauth/client_credential/accesstoken?grant_type=client_credentials`;

  // Method is GET, not POST — §7.1/§21.2's confirmed, undocumented, hard-won finding.
  const outcome = await performRequest(url, {
    accept: "application/json",
    Authorization: `Basic ${basic}`,
  });

  if (outcome.kind === "timeout") {
    return err({ type: "timeout", message: "OAuth token request timed out" });
  }
  if (outcome.kind === "network_error") {
    return err({ type: "auth_failed", message: outcome.message });
  }
  if (outcome.status !== 200) {
    return err({
      type: "auth_failed",
      message: `Token request returned ${outcome.status}: ${outcome.bodyText.slice(0, 500)}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.bodyText);
  } catch {
    return err({ type: "malformed_response", message: "OAuth response was not valid JSON" });
  }

  const body = parsed as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    return err({ type: "auth_failed", message: "OAuth response had no access_token" });
  }

  return ok({
    accessToken: body.access_token,
    expiresInSeconds: Number(body.expires_in ?? 43_199),
  });
}

/**
 * Returns a valid access token — from the DB cache if it's still within its 80%-of-life
 * window, or by fetching a fresh one otherwise. Single-flight via a Postgres advisory lock: if
 * two callers race to refresh, the second one blocks, then re-checks the cache once it gets the
 * lock (another process may have just refreshed it), rather than making a second redundant
 * OAuth call.
 */
export async function getAccessToken(
  db: TokenManagerDb,
  params: { baseUrl: string; consumerKey: string; consumerSecret: string; now: Date },
): Promise<Result<string, FuelApiError>> {
  const cached = await readCachedToken(db);
  if (cached && isFresh(cached, params.now)) {
    return ok(cached.accessToken);
  }

  await db.execute(sql`select pg_advisory_lock(${TOKEN_REFRESH_LOCK_KEY})`);
  try {
    // Re-check: another process may have refreshed while we waited for the lock.
    const recheck = await readCachedToken(db);
    if (recheck && isFresh(recheck, params.now)) {
      return ok(recheck.accessToken);
    }

    const result = await requestNewToken(params.baseUrl, params.consumerKey, params.consumerSecret);
    if (!result.ok) {
      return result;
    }

    const expiresAt = new Date(params.now.getTime() + result.value.expiresInSeconds * 1000);
    await db
      .insert(oauthTokenCache)
      .values({
        id: TOKEN_CACHE_ID,
        accessToken: result.value.accessToken,
        expiresAt,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: oauthTokenCache.id,
        set: { accessToken: result.value.accessToken, expiresAt, updatedAt: params.now },
      });

    return ok(result.value.accessToken);
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${TOKEN_REFRESH_LOCK_KEY})`);
  }
}

/** Forces the cache empty so the next `getAccessToken()` call re-authenticates — used after a
 * `401` per §7.8's "one reactive retry on 401, then fail loudly. Never a loop." */
export async function invalidateCachedToken(db: Pick<PostgresJsDatabase, "delete">): Promise<void> {
  await db.delete(oauthTokenCache).where(eq(oauthTokenCache.id, TOKEN_CACHE_ID));
}
