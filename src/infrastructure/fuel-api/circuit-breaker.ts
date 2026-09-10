import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { ingestionRun } from "../db/schema";
import { err, ok, type Result } from "../../domain/result";
import type { FuelApiError } from "./types";

const CONSECUTIVE_FAILURES_TO_OPEN = 3;
const HALF_OPEN_AFTER_MS = 60 * 60 * 1000; // 60 minutes, §7.8

type JobType = "new_prices" | "full_sync" | "ref_data" | "rollup";

/**
 * `07_FUEL_API_INTEGRATION.md` §7.8: "opens after 3 consecutive failed runs, half-opens after
 * 60 minutes with a single trial call, closes on success." Note "runs," not "retries" — the
 * worker is a short-lived process per cron invocation (§7.5), so this state can't live in
 * memory. It's derived by reading `ingestion_run` history instead: the most recent 3 rows for
 * this job type must ALL be `status='failed'`, back-to-back, for the circuit to be open. A
 * `skipped_budget`/`skipped_circuit`/`success`/`partial` row anywhere in that window means the
 * API itself wasn't in a confirmed failure streak, so the circuit stays closed.
 *
 * Returns `ok(undefined)` to mean "proceed" — either the circuit is closed, or it's open but
 * the 60-minute half-open window has arrived and this call is the single trial. Returns
 * `err({ type: "circuit_open" })` to mean "skip this cycle, no call."
 */
export async function checkCircuitBreaker(
  db: Pick<PostgresJsDatabase, "select">,
  jobType: JobType,
  now: Date,
): Promise<Result<void, FuelApiError>> {
  const recent = await db
    .select({ status: ingestionRun.status, startedAt: ingestionRun.startedAt })
    .from(ingestionRun)
    .where(and(eq(ingestionRun.jobType, jobType)))
    .orderBy(desc(ingestionRun.startedAt))
    .limit(CONSECUTIVE_FAILURES_TO_OPEN);

  const isOpen =
    recent.length === CONSECUTIVE_FAILURES_TO_OPEN &&
    recent.every((run) => run.status === "failed");

  if (!isOpen) {
    return ok(undefined);
  }

  const mostRecentFailureAt = recent[0].startedAt;
  const msSinceMostRecentFailure = now.getTime() - mostRecentFailureAt.getTime();

  if (msSinceMostRecentFailure >= HALF_OPEN_AFTER_MS) {
    // Half-open: let exactly one trial call through. If it succeeds, the next check sees a
    // non-all-failed window (this run's own success row breaks the streak) and closes normally.
    // If it fails, the streak is still 3 (this run replaces the oldest in the window), so the
    // circuit stays open for another 60 minutes from this new failure.
    return ok(undefined);
  }

  return err({ type: "circuit_open" });
}
