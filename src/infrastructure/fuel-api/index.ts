import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { ingestionRun } from "../db/schema";
import { err, ok, type Result } from "../../domain/result";
import { checkBudget, ledgerCallBeforeRequest, recordCallOutcome } from "./budget-guard";
import { checkCircuitBreaker } from "./circuit-breaker";
import { buildAuthedHeaders, calculateBackoffDelayMs, performRequest } from "./http-client";
import { journalRawResponse, markJournalOutcome } from "./journal";
import { checkKeyEnvironmentConsistency, computeKeyFingerprint } from "./key-fingerprint";
import { normaliseFuelType, normalisePrice, normaliseStation } from "./normalise";
import { getAccessToken, invalidateCachedToken } from "./token-manager";
import {
  PricesResponseSchema,
  ReferenceDataResponseSchema,
  type FuelApiError,
  type FuelType,
  type PriceObservation,
  type ReferenceData,
  type Station,
} from "./types";

export type FuelDataSourceDb = Pick<
  PostgresJsDatabase,
  "select" | "insert" | "update" | "delete" | "execute"
>;

export interface FuelDataSourceConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  environmentName: string;
}

type JobType = "new_prices" | "full_sync" | "ref_data";

const MAX_RETRIES_5XX = 2; // §7.8 — "Retry up to 2× with exponential backoff + full jitter"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Everything `07_FUEL_API_INTEGRATION.md` §7.4's boundary diagram groups under "Adapter":
 * budget guard, key fingerprint, circuit breaker, token manager, HTTP client with
 * retry/backoff, and the response journal — composed into the three-method interface §7.4
 * specifies, each returning `Result` and never throwing.
 *
 * Deliberately stops at returning normalised `PriceObservation[]`/`Station[]`/`FuelType[]` —
 * per-record quality gates (§6.9) and the actual `fuel_price_observation` insert require
 * cross-referencing other repository tables and are the ingestion job's concern, not this
 * adapter's (that orchestration is Sprint 2 work, not this branch).
 */
export class FuelDataSource {
  constructor(
    private readonly db: FuelDataSourceDb,
    private readonly config: FuelDataSourceConfig,
  ) {}

  async fetchNewPrices(now: Date = new Date()): Promise<Result<PriceObservation[], FuelApiError>> {
    return this.runJob("new_prices", "/FuelPriceCheck/v2/fuel/prices/new", now, true, (json) => {
      const parsed = PricesResponseSchema.safeParse(json);
      if (!parsed.success) return err(parsed.error.message);
      const observations = parsed.data.prices.map(normalisePrice);
      return ok({ data: observations, recordCount: observations.length });
    });
  }

  async fetchAllPrices(now: Date = new Date()): Promise<Result<PriceObservation[], FuelApiError>> {
    return this.runJob("full_sync", "/FuelPriceCheck/v2/fuel/prices", now, true, (json) => {
      const parsed = PricesResponseSchema.safeParse(json);
      if (!parsed.success) return err(parsed.error.message);
      const observations = parsed.data.prices.map(normalisePrice);
      return ok({ data: observations, recordCount: observations.length });
    });
  }

  async fetchReferenceData(now: Date = new Date()): Promise<Result<ReferenceData, FuelApiError>> {
    return this.runJob("ref_data", "/FuelCheckRefData/v2/fuel/lovs", now, false, (json) => {
      const parsed = ReferenceDataResponseSchema.safeParse(json);
      if (!parsed.success) return err(parsed.error.message);
      const stations: Station[] = parsed.data.stations.items.map(normaliseStation);
      const fuelTypes: FuelType[] = parsed.data.fueltypes.items.map(normaliseFuelType);
      return ok({ data: { stations, fuelTypes }, recordCount: stations.length + fuelTypes.length });
    });
  }

  /**
   * The shared sequence from `08_INGESTION_ARCHITECTURE.md` §8.4's flowchart — fingerprint,
   * budget, circuit breaker, ledger-before-call, token, request with retries, journal, then
   * `parseResponse` (each public method's own Zod validation + normalisation) — common to all
   * three public methods above, including the final `ingestion_run` update with the real
   * record count (§6.3 — the whole reason that column exists is to answer "why is this price 6
   * hours old," which an always-0 count would defeat).
   *
   * Advisory-lock acquisition (the "is a run already in progress" guard, the flowchart's first
   * diamond) is deliberately NOT here — that belongs to the worker entrypoint that calls this
   * class (feature/worker-scaffolding), which can hold the lock across everything this method
   * does, not just one HTTP call.
   */
  private async runJob<T>(
    jobType: JobType,
    path: string,
    now: Date,
    essential: boolean,
    parseResponse: (json: unknown) => Result<{ data: T; recordCount: number }, string>,
  ): Promise<Result<T, FuelApiError>> {
    const keyFingerprint = computeKeyFingerprint(this.config.consumerKey);

    const fingerprintCheck = await checkKeyEnvironmentConsistency(
      this.db,
      keyFingerprint,
      this.config.environmentName,
    );
    if (!fingerprintCheck.ok) return fingerprintCheck;

    const budgetCheck = await checkBudget(this.db, now, essential);
    if (!budgetCheck.ok) return budgetCheck;

    const circuitCheck = await checkCircuitBreaker(this.db, jobType, now);
    if (!circuitCheck.ok) return circuitCheck;

    const [run] = await this.db
      .insert(ingestionRun)
      .values({
        jobType,
        status: "running",
        startedAt: now,
        keyFingerprint,
        environmentName: this.config.environmentName,
      })
      .returning({ id: ingestionRun.id });
    const runId = String(run.id);

    const requestOutcome = await this.requestWithRetries(path, runId, now);
    if (!requestOutcome.ok) {
      await this.db
        .update(ingestionRun)
        .set({
          status: "failed",
          finishedAt: now,
          failureReason: JSON.stringify(requestOutcome.error),
        })
        .where(eq(ingestionRun.id, runId));
      return requestOutcome;
    }
    const { json, journalId, apiCallsUsed } = requestOutcome.value;

    const parsed = parseResponse(json);
    if (!parsed.ok) {
      await markJournalOutcome(this.db, journalId, {
        status: "unparsed",
        failureReason: parsed.error,
        now,
      });
      await this.db
        .update(ingestionRun)
        .set({ status: "failed", finishedAt: now, apiCallsUsed, failureReason: parsed.error })
        .where(eq(ingestionRun.id, runId));
      return err({ type: "malformed_response", message: parsed.error });
    }

    await markJournalOutcome(this.db, journalId, { status: "processed", now });
    await this.db
      .update(ingestionRun)
      .set({
        status: "success",
        finishedAt: now,
        apiCallsUsed,
        recordsReceived: parsed.value.recordCount,
      })
      .where(eq(ingestionRun.id, runId));

    return ok(parsed.value.data);
  }

  /**
   * §7.8's per-failure-category table, condensed: `429` never retries this cycle; `401` gets
   * one forced token refresh + one retry, never a loop; `5xx` retries up to 2× with full-jitter
   * backoff; a timeout is NOT retried — per §21.2, the window may already be consumed
   * server-side even though the client saw nothing, so a blind retry against `/prices/new`
   * could return an empty window rather than the lost one. (This overrides §7.8's own table,
   * which says to retry a timeout — §21.2's reasoning is the more specific and more recently
   * confirmed of the two, and matches the at-most-once philosophy the rest of the design is
   * built around; treated as the authoritative rule here.)
   */
  private async requestWithRetries(
    path: string,
    ingestionRunId: string,
    now: Date,
  ): Promise<Result<{ json: unknown; journalId: string; apiCallsUsed: number }, FuelApiError>> {
    let apiCallsUsed = 0;
    let forcedTokenRefresh = false;

    for (let attempt = 0; ; attempt++) {
      const tokenResult = await getAccessToken(this.db, {
        baseUrl: this.config.baseUrl,
        consumerKey: this.config.consumerKey,
        consumerSecret: this.config.consumerSecret,
        now,
      });
      if (!tokenResult.ok) return tokenResult;

      const url = `${this.config.baseUrl}${path}`;
      const headers = buildAuthedHeaders(tokenResult.value, this.config.consumerKey, now);

      const ledgerId = await ledgerCallBeforeRequest(this.db, {
        ingestionRunId,
        endpoint: path,
        now,
      });
      apiCallsUsed++;

      const requestStartedAt = Date.now();
      const raw = await performRequest(url, headers);
      const durationMs = Date.now() - requestStartedAt;

      if (raw.kind === "timeout") {
        // No real httpStatus — the request never completed. durationMs is still useful
        // (confirms it ran the full configured timeout rather than failing fast).
        await recordCallOutcome(this.db, ledgerId, { durationMs });
        // Deliberately no retry — see this method's doc comment.
        return err({ type: "timeout", message: `${path} timed out` });
      }
      if (raw.kind === "network_error") {
        await recordCallOutcome(this.db, ledgerId, { durationMs });
        return err({ type: "server_error", status: 0, message: raw.message });
      }
      await recordCallOutcome(this.db, ledgerId, { httpStatus: raw.status, durationMs });

      if (raw.status === 429) {
        const retryAfter = raw.headers.get("retry-after");
        return err({
          type: "rate_limited",
          retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined,
        });
      }

      if ((raw.status === 401 || raw.status === 403) && !forcedTokenRefresh) {
        forcedTokenRefresh = true;
        await invalidateCachedToken(this.db);
        continue; // the one reactive retry §7.8 allows for a credential problem
      }
      if (raw.status === 401 || raw.status === 403) {
        return err({
          type: "auth_failed",
          message: `${path} returned ${raw.status} after token refresh`,
        });
      }

      if (raw.status >= 500 && attempt < MAX_RETRIES_5XX) {
        await delay(calculateBackoffDelayMs(attempt));
        continue;
      }
      if (raw.status >= 500) {
        return err({
          type: "server_error",
          status: raw.status,
          message: raw.bodyText.slice(0, 500),
        });
      }

      // 2xx (or anything else not handled above): journal raw body before parsing, per §21.2 —
      // the watermark advances regardless of what we do with the response, so this write must
      // happen before any JSON.parse that could throw.
      const journalId = await journalRawResponse(this.db, {
        ingestionRunId,
        endpoint: path,
        httpStatus: raw.status,
        rawBody: raw.bodyText,
        now,
      });

      let json: unknown;
      try {
        json = JSON.parse(raw.bodyText);
      } catch {
        await markJournalOutcome(this.db, journalId, {
          status: "unparsed",
          failureReason: "Response body was not valid JSON",
          now,
        });
        return err({ type: "malformed_response", message: "Response body was not valid JSON" });
      }

      return ok({ json, journalId, apiCallsUsed });
    }
  }
}
