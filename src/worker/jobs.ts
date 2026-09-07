import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  releaseJobLock,
  tryAcquireJobLock,
  type LockableJobType,
} from "../infrastructure/db/advisory-lock";
import type { FuelDataSource } from "../infrastructure/fuel-api";
import type { FuelApiError } from "../infrastructure/fuel-api/types";

type FuelDataSourceLike = Pick<
  FuelDataSource,
  "fetchNewPrices" | "fetchAllPrices" | "fetchReferenceData"
>;

export interface WorkerJobDeps {
  /** Only needs `execute`, for the advisory lock — never touches application tables directly. */
  db: Pick<PostgresJsDatabase, "execute">;
  /**
   * A factory, not an already-built instance — `rollup`/`retention` short-circuit below before
   * this is ever called, so they don't require Fuel API credentials to be set at all. Narrowed
   * to just the three methods this module calls, which also makes it trivially fakeable in
   * tests without a real `FuelDataSource` (real DB, real HTTP).
   */
  getFuelDataSource: () => FuelDataSourceLike;
  now?: Date;
}

export interface WorkerJobOutcome {
  exitCode: 0 | 1;
  message: string;
}

/**
 * Error categories that are expected, routine operating states — §7.7/§8.4's flowchart routes
 * `skipped_budget`/`skipped_circuit` to a normal release, not a failure. `key_environment_mismatch`
 * is deliberately NOT in this list: ADR-016 treats it as alarm-worthy (a misconfiguration that
 * risks silent data loss), not routine throttling.
 */
const EXPECTED_THROTTLING_ERRORS: FuelApiError["type"][] = ["budget_exceeded", "circuit_open"];

function exitCodeFor(error: FuelApiError): 0 | 1 {
  return EXPECTED_THROTTLING_ERRORS.includes(error.type) ? 0 : 1;
}

/**
 * The testable core of what `src/worker/index.ts` runs — advisory-lock guard
 * (`08_INGESTION_ARCHITECTURE.md` §8.7) around a call into the already-built Fuel API adapter.
 *
 * `rollup` and `retention` are recognised job names (matching `14_DEPLOYMENT.md` §14.3's cron
 * table) but not implemented here — `rollup` needs `10_PRICE_HISTORY_METHOD.md`'s interval-
 * reconstruction algorithm and `retention` needs the pruning logic from §6.8, neither of which
 * exists yet. Both are Sprint 2 ("Ingestion Complete"), per `20_SPRINT_PLAN.md` — this branch's
 * scope is deliberately just the lock and the entrypoint wiring for the three jobs the adapter
 * already supports.
 */
export async function runWorkerJob(
  jobName: "new-prices" | "full-sync" | "ref-data" | "rollup" | "retention",
  deps: WorkerJobDeps,
): Promise<WorkerJobOutcome> {
  const now = deps.now ?? new Date();

  if (jobName === "rollup" || jobName === "retention") {
    return { exitCode: 0, message: `"${jobName}" is not yet implemented (Sprint 2) — no-op.` };
  }

  const jobType: LockableJobType =
    jobName === "new-prices" ? "new_prices" : jobName === "full-sync" ? "full_sync" : "ref_data";

  const acquired = await tryAcquireJobLock(deps.db, jobType);
  if (!acquired) {
    // §8.7: try_, not a blocking acquire — a stuck previous run, a double-fired cron, or a
    // manual trigger mid-cycle exits cleanly at zero cost rather than queueing and doubling up.
    return { exitCode: 0, message: `"${jobName}" is already running elsewhere — exiting cleanly.` };
  }

  try {
    const fuelDataSource = deps.getFuelDataSource();
    const result =
      jobType === "new_prices"
        ? await fuelDataSource.fetchNewPrices(now)
        : jobType === "full_sync"
          ? await fuelDataSource.fetchAllPrices(now)
          : await fuelDataSource.fetchReferenceData(now);

    if (!result.ok) {
      return {
        exitCode: exitCodeFor(result.error),
        message: `"${jobName}" did not complete: ${JSON.stringify(result.error)}`,
      };
    }

    const count = Array.isArray(result.value)
      ? result.value.length
      : result.value.stations.length + result.value.fuelTypes.length;
    return { exitCode: 0, message: `"${jobName}" completed — ${count} record(s).` };
  } finally {
    await releaseJobLock(deps.db, jobType);
  }
}
