/**
 * `09_CALCULATION_ENGINE.md` §9.3/§9.6, `10_PRICE_HISTORY_METHOD.md` §10.7 — everything here
 * consumes already-computed `daily_price_rollup` rows. **Never recomputes from raw
 * observations** (§9.6.1's explicit rule, which overrides §21.4's looser illustrative
 * signature naming a raw `PriceObservation[]` parameter — §9.6.1 is the more specific,
 * deliberately-argued statement of the two, same kind of doc-precedence call as
 * `http-client.ts`'s §21.2-overrides-§7.8 note).
 */

/** The subset of a `daily_price_rollup` row these functions need. */
export interface DailyRollupSummary {
  priceDate: string;
  timeWeightedAvgTenths: number;
  closeTenthsCpl: number;
  partialDay: boolean;
}

export interface TimeWeightedAverageResult {
  /** `null` only when there are zero included days — nothing to average, not a zero price. */
  averageTenths: number | null;
  includedDays: number;
}

/**
 * §10.7: "mean of the 30 daily time-weighted averages, each day weighted **equally**. Not
 * weighted by observation count." §10.7 also excludes `partial_day = true` rows and days
 * skipped under case C — case C days never produce a row at all (§10.4), so they're already
 * absent from `rollups` by construction; only `partial_day` needs filtering here.
 */
export function timeWeightedAverage(
  rollups: readonly DailyRollupSummary[],
): TimeWeightedAverageResult {
  const included = rollups.filter((r) => !r.partialDay);
  if (included.length === 0) {
    return { averageTenths: null, includedDays: 0 };
  }
  const sum = included.reduce((total, r) => total + r.timeWeightedAvgTenths, 0);
  return { averageTenths: sum / included.length, includedDays: included.length };
}

/**
 * §9.6.2: a **true rank percentile** — the fraction of days in the window at or below the
 * current price — not the min-max normalisation `03` proposed, which a single erroneous outlier
 * permanently distorts. `<=` (not `<`) so a run of identical prices correctly yields 1.0, not an
 * undercount. `null` only for an empty window — no history to rank against, not a percentile of
 * 0.
 */
export function rankPercentile(
  currentPriceTenths: number,
  windowPricesTenths: readonly number[],
): number | null {
  if (windowPricesTenths.length === 0) return null;
  const atOrBelow = windowPricesTenths.filter((p) => p <= currentPriceTenths).length;
  return atOrBelow / windowPricesTenths.length;
}

export type TrendDirection = "rising" | "falling" | "flat";

export interface TrendResult {
  direction: TrendDirection;
  /** Tenths of a cent per litre, per day. */
  slopeTenthsPerDay: number;
}

/**
 * §9.3/§10.7: "linear regression on daily closes." Ordinary least squares against day index
 * (0, 1, 2, ...) as x — the exact sign of the slope decides direction, with no arbitrary
 * "flatness band" epsilon: the doc doesn't specify one, and inventing one would make the
 * direction depend on a hidden constant rather than the regression itself (§9.1's "auditable"
 * principle — every number traces to a function and its inputs).
 */
export function trend(closesTenthsInDayOrder: readonly number[]): TrendResult {
  const n = closesTenthsInDayOrder.length;
  if (n < 2) {
    return { direction: "flat", slopeTenthsPerDay: 0 };
  }

  const meanX = (n - 1) / 2;
  const meanY = closesTenthsInDayOrder.reduce((sum, y) => sum + y, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let x = 0; x < n; x++) {
    const dx = x - meanX;
    numerator += dx * (closesTenthsInDayOrder[x] - meanY);
    denominator += dx * dx;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const direction: TrendDirection = slope > 0 ? "rising" : slope < 0 ? "falling" : "flat";
  return { direction, slopeTenthsPerDay: slope };
}
