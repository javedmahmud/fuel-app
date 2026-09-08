import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  releaseJobLock,
  tryAcquireJobLock,
  type LockableJobType,
} from "../infrastructure/db/advisory-lock";
import type { SydneyDateString } from "../domain/rollup/day-boundary";
import type { FuelDataSource } from "../infrastructure/fuel-api";
import type { FuelApiError } from "../infrastructure/fuel-api/types";
import { runFullSyncJob } from "./ingestion/full-sync-job";
import { runNewPricesJob } from "./ingestion/new-prices-job";
import { runRefDataJob } from "./ingestion/ref-data-job";
import { runRollupJob } from "./rollup/rollup-job";

type FuelDataSourceLike = Pick<
  FuelDataSource,
  "fetchNewPrices" | "fetchAllPrices" | "fetchReferenceData"
>;

export interface WorkerJobDeps {
  /** Needs full table access now — the ingestion jobs read reference data and write
   * observations/station state, and rollup deletes stale rows for a recomputed-as-skipped
   * pair, not just the advisory lock's `execute`. */
  db: Pick<
    PostgresJsDatabase,
    "select" | "selectDistinctOn" | "insert" | "update" | "delete" | "execute"
  >;
  /**
   * A factory, not an already-built instance — `rollup`/`retention` never call this, so they
   * don't require Fuel API credentials to be set at all (rollup makes zero Fuel API calls per
   * `08_INGESTION_ARCHITECTURE.md`'s cron table). Narrowed to just the three methods this
   * module calls, which also makes it trivially fakeable in tests without a real
   * `FuelDataSource` (real DB, real HTTP).
   */
  getFuelDataSource: () => FuelDataSourceLike;
  now?: Date;
  /** `rollup` only — the Sydney calendar date to roll up. Omitted means "yesterday" (§10.8:
   * "runs nightly for the previous day"); an explicit value is how backfill/recompute for an
   * arbitrary date is driven, threaded from `worker/index.ts`'s argv. */
  rollupDate?: SydneyDateString;
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
 * (`08_INGESTION_ARCHITECTURE.md` §8.7) around the actual ingestion jobs
 * (`src/worker/ingestion/`) and the rollup job (`src/worker/rollup/`).
 *
 * `retention` is a recognised job name (matching `14_DEPLOYMENT.md` §14.3's cron table) but not
 * implemented here — it needs the pruning logic from `06_DATA_ARCHITECTURE.md` §6.8, which
 * doesn't exist yet and is out of this branch's scope.
 */
export async function runWorkerJob(
  jobName: "new-prices" | "full-sync" | "ref-data" | "rollup" | "retention",
  deps: WorkerJobDeps,
): Promise<WorkerJobOutcome> {
  const now = deps.now ?? new Date();

  if (jobName === "retention") {
    return { exitCode: 0, message: `"${jobName}" is not yet implemented — no-op.` };
  }

  const jobType: LockableJobType =
    jobName === "new-prices"
      ? "new_prices"
      : jobName === "full-sync"
        ? "full_sync"
        : jobName === "ref-data"
          ? "ref_data"
          : "rollup";

  const acquired = await tryAcquireJobLock(deps.db, jobType);
  if (!acquired) {
    // §8.7: try_, not a blocking acquire — a stuck previous run, a double-fired cron, or a
    // manual trigger mid-cycle exits cleanly at zero cost rather than queueing and doubling up.
    return { exitCode: 0, message: `"${jobName}" is already running elsewhere — exiting cleanly.` };
  }

  try {
    if (jobType === "rollup") {
      const result = await runRollupJob(deps.db, now, deps.rollupDate);

      // Same "counted and logged" reasoning as the ingestion jobs' rejection breakdown below —
      // a bare skipped count gives an operator nothing to act on.
      const skippedBreakdown = Object.entries(result.skippedByReason)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ");

      return {
        exitCode: 0,
        message:
          `"${jobName}" completed for ${result.priceDate} — ${result.rowsWritten}/` +
          `${result.pairsProcessed} pair(s) rolled up, ${result.rowsSkipped} skipped` +
          (skippedBreakdown ? ` (${skippedBreakdown})` : "") +
          ".",
      };
    }

    const fuelDataSource = deps.getFuelDataSource();

    if (jobType === "ref_data") {
      const result = await runRefDataJob(deps.db, fuelDataSource, now);
      if (!result.ok) {
        return {
          exitCode: exitCodeFor(result.error),
          message: `"${jobName}" did not complete: ${JSON.stringify(result.error)}`,
        };
      }
      return {
        exitCode: 0,
        message:
          `"${jobName}" completed — ${result.value.stationsUpserted} station(s), ` +
          `${result.value.fuelTypesUpserted} fuel type(s) upserted ` +
          `(${result.value.stationsDeactivated} station(s), ${result.value.fuelTypesDeactivated} ` +
          `fuel type(s) deactivated).`,
      };
    }

    const result =
      jobType === "new_prices"
        ? await runNewPricesJob(deps.db, fuelDataSource, now)
        : await runFullSyncJob(deps.db, fuelDataSource, now);

    if (!result.ok) {
      return {
        exitCode: exitCodeFor(result.error),
        message: `"${jobName}" did not complete: ${JSON.stringify(result.error)}`,
      };
    }

    // §8.10: rejected records must be "counted and logged," not just silently reflected in a
    // total — the reason breakdown is what makes "910 rejected" actionable instead of a number
    // an operator has no way to investigate after the process exits.
    const reasonBreakdown = Object.entries(result.value.rejectedByReason)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");

    // skippedNonPriced (e.g. "EV" placeholder rows, quality-gates.ts's isNonPricedFuelType) is
    // reported alongside but deliberately kept out of the "rejected" figure itself — it was
    // never price data to begin with, not price data that failed a check.
    const skippedSuffix =
      result.value.skippedNonPricedCount > 0
        ? `, ${result.value.skippedNonPricedCount} skipped (non-priced fuel type)`
        : "";

    return {
      exitCode: 0,
      message:
        `"${jobName}" completed — ${result.value.insertedCount} inserted, ` +
        `${result.value.duplicateCount} duplicate, ${result.value.rejectedCount} rejected` +
        (reasonBreakdown ? ` (${reasonBreakdown})` : "") +
        skippedSuffix +
        ".",
    };
  } finally {
    await releaseJobLock(deps.db, jobType);
  }
}
