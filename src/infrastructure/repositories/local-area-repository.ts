import { and, asc, avg, eq, gte, inArray, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { LocalAreaContext } from "../../domain/calculation/rank-candidates";
import {
  previousSydneyDate,
  sydneyDateOf,
  type SydneyDateString,
} from "../../domain/rollup/day-boundary";
import { dailyPriceRollup } from "../db/schema";

type ReadDb = Pick<PostgresJsDatabase, "select">;

/**
 * `10_PRICE_HISTORY_METHOD.md` §10.7: "Local area figures — aggregate across stations within a
 * bounding box, each station's daily average weighted equally so a suburb with many stations
 * does not dominate." Computed for the whole candidate neighbourhood *before* ranking, not for
 * whichever station ends up recommended — `rank-candidates.ts`'s `LocalAreaContext` is an input
 * to ranking (it feeds `BELOW_LOCAL_AVERAGE`/rank percentile/trend), so it can't depend on
 * ranking's own output without a circular dependency.
 *
 * The `AVG(...)` aggregation happens in SQL, one row per day, rather than pulling every
 * station's every day into JS and averaging there — the same "push the aggregation down"
 * preference as this codebase's bulk-write repositories. `partial_day` rows are excluded per
 * §10.7's own rule ("days with partial_day = true... are excluded").
 */
export async function loadLocalAreaContext(
  db: ReadDb,
  stationIds: readonly string[],
  fuelTypeId: string,
  windowDays: number,
  now: Date,
): Promise<LocalAreaContext> {
  if (stationIds.length === 0) {
    return {
      historyDays: 0,
      localAverageTenths: null,
      windowPricesTenths: [],
      closesTenthsInDayOrder: [],
    };
  }

  const endDate = previousSydneyDate(sydneyDateOf(now)); // rollup runs nightly for the previous day
  const startDate = stepBackDays(endDate, windowDays - 1);

  const rows = await db
    .select({
      priceDate: dailyPriceRollup.priceDate,
      avgTimeWeightedTenths: avg(dailyPriceRollup.timeWeightedAvgTenths),
      avgCloseTenths: avg(dailyPriceRollup.closeTenthsCpl),
    })
    .from(dailyPriceRollup)
    .where(
      and(
        inArray(dailyPriceRollup.stationId, [...stationIds]),
        eq(dailyPriceRollup.fuelTypeId, fuelTypeId),
        eq(dailyPriceRollup.partialDay, false),
        gte(dailyPriceRollup.priceDate, startDate),
        lte(dailyPriceRollup.priceDate, endDate),
      ),
    )
    .groupBy(dailyPriceRollup.priceDate)
    .orderBy(asc(dailyPriceRollup.priceDate));

  // AVG(...) over a non-empty group is never actually null (drizzle's own type is conservative,
  // typed nullable for the general case), but rows failing that assumption are skipped rather
  // than silently coerced to a wrong number — same defensive stance as elsewhere in this codebase.
  const windowPricesTenths = rows
    .map((r) =>
      r.avgTimeWeightedTenths !== null ? Math.round(Number(r.avgTimeWeightedTenths)) : null,
    )
    .filter((v): v is number => v !== null);
  const closesTenthsInDayOrder = rows
    .map((r) => (r.avgCloseTenths !== null ? Math.round(Number(r.avgCloseTenths)) : null))
    .filter((v): v is number => v !== null);

  const localAverageTenths =
    windowPricesTenths.length > 0
      ? Math.round(windowPricesTenths.reduce((sum, p) => sum + p, 0) / windowPricesTenths.length)
      : null;

  return {
    historyDays: rows.length,
    localAverageTenths,
    windowPricesTenths,
    closesTenthsInDayOrder,
  };
}

function stepBackDays(date: SydneyDateString, days: number): SydneyDateString {
  let result = date;
  for (let i = 0; i < days; i++) result = previousSydneyDate(result);
  return result;
}
