import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  computeDailyRollup,
  type ComputeDailyRollupResult,
  type RollupObservation,
} from "../../domain/rollup/compute-daily-rollup";
import {
  previousSydneyDate,
  sydneyDateOf,
  sydneyDayBoundary,
  type SydneyDateString,
} from "../../domain/rollup/day-boundary";
import {
  deleteDailyRollupsForDate,
  loadDayEvents,
  loadOpeningPrices,
  loadStationsDeactivatedDuring,
  upsertDailyRollups,
  type DailyRollupRow,
  type ObservationPair,
} from "../../infrastructure/repositories/rollup-repository";

type Db = Pick<PostgresJsDatabase, "select" | "selectDistinctOn" | "insert" | "delete">;

/** The analogue of `engine_version` in the calculation engine (`10_PRICE_HISTORY_METHOD.md`
 * §10.5) — bump this and every affected day gets a genuinely different, recomputed row the next
 * time this job runs for it, never a stale one silently left under an old method. */
export const ROLLUP_METHOD_VERSION = "v1";

type SkipReason = Extract<ComputeDailyRollupResult, { skipped: true }>["reason"];

export interface RunRollupJobResult {
  priceDate: SydneyDateString;
  pairsProcessed: number;
  rowsWritten: number;
  rowsSkipped: number;
  skippedByReason: Partial<Record<SkipReason, number>>;
}

function pairKey(pair: ObservationPair): string {
  return `${pair.stationId}::${pair.fuelTypeId}`;
}

/**
 * `rollup` — daily, after `full_sync` (`08_INGESTION_ARCHITECTURE.md` §8.11's cron table). Zero
 * Fuel API calls: this only reads `fuel_price_observation` and writes `daily_price_rollup`, so
 * unlike the ingestion jobs it has no `Result<T, FuelApiError>` failure modes of its own — a
 * genuine DB failure just throws and is handled the same way any other unexpected worker error
 * is (`worker/index.ts`'s outer catch), rather than needing a bespoke error type here.
 *
 * `priceDate` defaults to "yesterday" in Sydney relative to `now` — §10.8: "runs nightly for the
 * previous day." Passing an explicit date is how §10.8's other requirement (recompute/backfill
 * for an arbitrary date, e.g. after a recovered journal replay or a `method_version` bump) is
 * satisfied — one date per invocation; a range is a caller-side loop over this.
 */
export async function runRollupJob(
  db: Db,
  now: Date,
  priceDate?: SydneyDateString,
): Promise<RunRollupJobResult> {
  const targetDate = priceDate ?? previousSydneyDate(sydneyDateOf(now));
  const { dayStart, dayEnd } = sydneyDayBoundary(targetDate);

  // Three independent reads, one round trip each rather than one per (station, fuel type) pair
  // — see rollup-repository.ts's own comments on why each is a single bulk query.
  const [dayEvents, openingPrices, deactivations] = await Promise.all([
    loadDayEvents(db, dayStart, dayEnd),
    loadOpeningPrices(db, dayStart),
    loadStationsDeactivatedDuring(db, dayStart, dayEnd),
  ]);

  // Group both observation sources by pair — this union is exactly "every pair that needs a
  // rollup row today": anything with an opening-price candidate (history from before today) or
  // an event today (including a pair whose very first-ever observation is today, which
  // computeDailyRollup will correctly skip under case C).
  const observationsByPair = new Map<string, RollupObservation[]>();
  const pairsByKey = new Map<string, ObservationPair>();
  for (const row of [...openingPrices, ...dayEvents]) {
    const pair: ObservationPair = { stationId: row.stationId, fuelTypeId: row.fuelTypeId };
    const key = pairKey(pair);
    pairsByKey.set(key, pair);
    const list = observationsByPair.get(key) ?? [];
    list.push({
      priceTenthsCpl: row.priceTenthsCpl,
      sourceReportedAt: row.sourceReportedAt,
      retrievedAt: row.retrievedAt,
    });
    observationsByPair.set(key, list);
  }

  const rowsToWrite: DailyRollupRow[] = [];
  const skippedPairs: ObservationPair[] = [];
  const skippedByReason: Partial<Record<SkipReason, number>> = {};

  for (const [key, pair] of pairsByKey) {
    const observations = observationsByPair.get(key) ?? [];
    const deactivatedAt = deactivations.get(pair.stationId);

    const result = computeDailyRollup({ observations, dayStart, dayEnd, deactivatedAt });

    if (result.skipped) {
      skippedPairs.push(pair);
      skippedByReason[result.reason] = (skippedByReason[result.reason] ?? 0) + 1;
      continue;
    }

    rowsToWrite.push({
      stationId: pair.stationId,
      fuelTypeId: pair.fuelTypeId,
      priceDate: targetDate,
      timeWeightedAvgTenths: result.timeWeightedAvgTenths,
      minTenthsCpl: result.minTenthsCpl,
      maxTenthsCpl: result.maxTenthsCpl,
      openTenthsCpl: result.openTenthsCpl,
      closeTenthsCpl: result.closeTenthsCpl,
      observationCount: result.observationCount,
      carriedForward: result.carriedForward,
      openingPriceAgeDays: result.openingPriceAgeDays,
      partialDay: result.partialDay,
      methodVersion: ROLLUP_METHOD_VERSION,
      computedAt: now,
    });
  }

  // §10.8: idempotent full replace — write the computed rows, and clear out any stale row a
  // previous run left for a pair that recomputed as skipped this time.
  const [{ written }] = await Promise.all([
    upsertDailyRollups(db, rowsToWrite),
    deleteDailyRollupsForDate(db, skippedPairs, targetDate),
  ]);

  return {
    priceDate: targetDate,
    pairsProcessed: pairsByKey.size,
    rowsWritten: written,
    rowsSkipped: skippedPairs.length,
    skippedByReason,
  };
}
