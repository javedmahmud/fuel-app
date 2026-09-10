/**
 * `21_DETAILED_DESIGN.md` §21.1: "`GET /api/v1/stations/{stationId}/history` — UC-06. Query
 * params: `fuelType` (required), `days` (default 30, max 90 per retention policy §6.8). Returns
 * the `daily_price_rollup` series... `404` with a structured 'insufficient history' body, not an
 * empty array, when `daily_price_rollup` has fewer than the confidence-threshold days (§9.7)."
 *
 * **The window ends yesterday, not today.** `rollup-job.ts` runs nightly for the *previous*
 * Sydney day (`10_PRICE_HISTORY_METHOD.md` §10.8) — today's row essentially never exists yet at
 * request time. Treating "today" as part of the requested window would make every single
 * request register today as a coverage gap, every day, which is a manufactured false alarm, not
 * a real one — so the `days`-sized window is the `days` Sydney calendar dates ending yesterday.
 *
 * **historyDays is `daily_price_rollup`'s row count** (`confidence.ts`'s own `historyDays` doc
 * comment: "from `daily_price_rollup`'s row count, not raw observations") — a raw count,
 * unfiltered by `partialDay`, reused here as the §9.7 "confidence-threshold days" gate via the
 * same `MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS` constant `computeConfidence`'s `medium` tier uses.
 *
 * **`stats`/`trend` exclude `partial_day` rows** — the schema's own comment on that column:
 * "Excluded from multi-day aggregates." `current` is the live price from
 * `fuel_price_observation`, not the rollup — the rollup is a derived cache of history, never the
 * source for "right now" (`06_DATA_ARCHITECTURE.md` §6.1).
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS } from "../domain/calculation/confidence";
import { rankPercentile, timeWeightedAverage, trend } from "../domain/calculation/history";
import {
  previousSydneyDate,
  sydneyDateOf,
  sydneyDateRangeEndingAt,
  sydneyDayBoundary,
} from "../domain/rollup/day-boundary";
import { COVERAGE_NOTE_TEXT, hasCoverageGap } from "../domain/rollup/coverage-note";
import { loadActiveFuelTypeCodeToId } from "../infrastructure/repositories/fuel-type-repository";
import { loadDegradedIngestionDates } from "../infrastructure/repositories/observability-repository";
import { loadRollupSeries } from "../infrastructure/repositories/rollup-repository";
import {
  loadCurrentPricesForStation,
  loadStationById,
} from "../infrastructure/repositories/station-detail-repository";
import type { HandlerResult } from "./http-handler-result";

type Db = Pick<PostgresJsDatabase, "select" | "selectDistinctOn">;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90; // §6.8's retention policy — nothing older is guaranteed to still exist

const stationIdSchema = z.string().uuid();

const querySchema = z.object({
  fuelType: z.string().trim().min(1),
  days: z.coerce.number().int().positive().max(MAX_DAYS).optional(),
});

function errorResult(status: number, error: string, message: string): HandlerResult {
  return { status, body: { error, message } };
}

export async function handleStationHistoryRequest(
  db: Db,
  rawStationId: string,
  searchParams: URLSearchParams,
  now: Date,
): Promise<HandlerResult> {
  const stationIdParsed = stationIdSchema.safeParse(rawStationId);
  if (!stationIdParsed.success) {
    return errorResult(400, "invalid_station_id", "stationId must be a valid UUID.");
  }
  const stationId = stationIdParsed.data;

  const queryParsed = querySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!queryParsed.success) {
    return errorResult(
      400,
      "invalid_query",
      queryParsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  const { fuelType: fuelTypeCode, days = DEFAULT_DAYS } = queryParsed.data;

  const detail = await loadStationById(db, stationId);
  if (!detail) {
    return errorResult(404, "station_not_found", `No station with id "${stationId}".`);
  }

  const fuelTypeCodeToId = await loadActiveFuelTypeCodeToId(db);
  const fuelTypeId = fuelTypeCodeToId.get(fuelTypeCode);
  if (!fuelTypeId) {
    return errorResult(400, "unknown_fuel_type", `Unknown fuel type "${fuelTypeCode}".`);
  }

  const latestCompleteDay = previousSydneyDate(sydneyDateOf(now));
  const requestedDates = sydneyDateRangeEndingAt(latestCompleteDay, days);
  const sinceDate = requestedDates[0];
  // Sydney-local day boundaries, not UTC-midnight parses of the date strings — Sydney is
  // UTC+10/+11, so Sydney midnight falls 10-11 hours *before* UTC midnight of the same calendar
  // date. Using `new Date(sinceDate)` directly would push the "since" bound hours too late and
  // systematically miss early-Sydney-morning degraded runs on the window's first day.
  const sinceInstant = sydneyDayBoundary(sinceDate).dayStart;

  const [rollups, degradedIngestionDates, currentPrices] = await Promise.all([
    loadRollupSeries(db, stationId, fuelTypeId, sinceDate, latestCompleteDay),
    loadDegradedIngestionDates(db, sinceInstant, now),
    loadCurrentPricesForStation(db, stationId),
  ]);

  const historyDays = rollups.length;
  if (historyDays < MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS) {
    return {
      status: 404,
      body: {
        error: "insufficient_history",
        message: "Not enough price history has been collected yet for this station and fuel type.",
        historyDays,
        minimumRequired: MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS,
      },
    };
  }

  const included = rollups.filter(
    (r) => !r.partialDay && r.timeWeightedAvgTenths !== null && r.closeTenthsCpl !== null,
  );

  const current = currentPrices.get(fuelTypeId);
  const { averageTenths } = timeWeightedAverage(
    included.map((r) => ({
      priceDate: r.priceDate,
      timeWeightedAvgTenths: r.timeWeightedAvgTenths as number,
      closeTenthsCpl: r.closeTenthsCpl as number,
      partialDay: r.partialDay,
    })),
  );
  const percentile = current
    ? rankPercentile(
        current.priceTenthsCpl,
        included.map((r) => r.timeWeightedAvgTenths as number),
      )
    : null;
  const trendResult = trend(included.map((r) => r.closeTenthsCpl as number));

  const minTenths = rollups.reduce<number | null>(
    (min, r) =>
      r.minTenthsCpl === null ? min : min === null ? r.minTenthsCpl : Math.min(min, r.minTenthsCpl),
    null,
  );
  const maxTenths = rollups.reduce<number | null>(
    (max, r) =>
      r.maxTenthsCpl === null ? max : max === null ? r.maxTenthsCpl : Math.max(max, r.maxTenthsCpl),
    null,
  );

  const rollupDates = new Set(rollups.map((r) => r.priceDate));
  const coverageNote = hasCoverageGap({
    requestedDates,
    rollupDates,
    degradedIngestionDates,
  })
    ? COVERAGE_NOTE_TEXT
    : null;

  return {
    status: 200,
    body: {
      stationId,
      fuelType: fuelTypeCode,
      requestedDays: days,
      historyDays,
      current: current
        ? {
            centsPerLitre: current.priceTenthsCpl / 10,
            lastUpdated: current.sourceReportedAt.toISOString(),
          }
        : null,
      stats: {
        minCentsPerLitre: minTenths === null ? null : minTenths / 10,
        maxCentsPerLitre: maxTenths === null ? null : maxTenths / 10,
        averageCentsPerLitre: averageTenths === null ? null : averageTenths / 10,
        percentile,
      },
      trend: {
        direction: trendResult.direction,
        slopeCentsPerLitrePerDay: trendResult.slopeTenthsPerDay / 10,
      },
      series: rollups.map((r) => ({
        date: r.priceDate,
        averageCentsPerLitre:
          r.timeWeightedAvgTenths === null ? null : r.timeWeightedAvgTenths / 10,
        closeCentsPerLitre: r.closeTenthsCpl === null ? null : r.closeTenthsCpl / 10,
        partialDay: r.partialDay,
      })),
      coverageNote,
    },
  };
}
