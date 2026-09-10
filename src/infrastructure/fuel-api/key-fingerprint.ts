import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { ingestionRun } from "../db/schema";
import { err, ok, type Result } from "../../domain/result";
import type { FuelApiError } from "./types";

/**
 * ADR-016 / `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.8.1: never the key itself, only a hash —
 * this value is safe to store, log, and compare, but not to reverse.
 */
export function computeKeyFingerprint(consumerKey: string): string {
  return createHash("sha256").update(consumerKey).digest("hex");
}

/**
 * The shared-key detection check itself — `08_INGESTION_ARCHITECTURE.md` §8.4's flowchart runs
 * this immediately after the advisory lock, before the budget guard, on every single worker
 * startup. "Has this exact key fingerprint EVER been recorded under a different environment
 * name?" A yes is ADR-016's "silent data-integrity failure" made loud instead: refuse to start.
 *
 * Deliberately takes a Drizzle instance as a parameter rather than importing `getDb()` directly
 * — keeps this testable against an injected fake without a real database.
 */
export async function checkKeyEnvironmentConsistency(
  db: Pick<PostgresJsDatabase, "select">,
  fingerprint: string,
  currentEnvironment: string,
): Promise<Result<void, FuelApiError>> {
  const conflicting = await db
    .select({ environmentName: ingestionRun.environmentName })
    .from(ingestionRun)
    .where(
      and(
        eq(ingestionRun.keyFingerprint, fingerprint),
        ne(ingestionRun.environmentName, currentEnvironment),
      ),
    )
    .limit(1);

  const previous = conflicting[0];
  if (previous?.environmentName) {
    return err({
      type: "key_environment_mismatch",
      recordedEnvironment: previous.environmentName,
      currentEnvironment,
    });
  }

  return ok(undefined);
}
