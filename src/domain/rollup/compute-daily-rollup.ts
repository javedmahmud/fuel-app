/**
 * `10_PRICE_HISTORY_METHOD.md` §10.3's algorithm, plus every edge case in §10.4's table (A–H).
 * Pure — no I/O, no clock, no randomness (`src/domain/README.md`'s rules): every instant this
 * needs (`dayStart`/`dayEnd`, already DST-correct per `day-boundary.ts`, and `deactivatedAt`)
 * is a parameter, and the observation lookback the caller must supply is described below.
 *
 * This is the exact bug `06_DATA_ARCHITECTURE.md` v1 warned about and this document exists to
 * prevent: `mean(observations)` ignores duration entirely and is provably wrong (§10.3's worked
 * example, reproduced in this module's tests to the cent).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RollupObservation {
  priceTenthsCpl: number;
  /** When the station itself changed this price — what intervals are built from. */
  sourceReportedAt: Date;
  /** Tiebreaker only (§10.4 case D) — when *we* fetched this record. */
  retrievedAt: Date;
}

export interface ComputeDailyRollupInput {
  /**
   * Every observation the caller has for this (station, fuel type) pair that could plausibly
   * matter for this day — i.e. everything with `sourceReportedAt < dayEnd`. It is safe (and, for
   * case B, necessary) to pass observations from many days earlier: only the single most recent
   * one before `dayStart` is used for the opening price, however old it is. Passing observations
   * at or after `dayEnd` is harmless (ignored) but wasteful — callers should not bother.
   */
  observations: RollupObservation[];
  dayStart: Date;
  dayEnd: Date;
  /**
   * §10.4 case F — the instant the station's `lifecycle_state` became `inactive`, if that
   * happened at or before `dayEnd`. `undefined` means the station was active/suspect for the
   * whole day. When this falls inside `(dayStart, dayEnd)`, the day is weighted only up to this
   * instant and `partialDay` is set.
   */
  deactivatedAt?: Date;
}

export type ComputeDailyRollupResult =
  | {
      skipped: true;
      /** `no_prior_observation` — case C, the station's first day: there is nothing to carry
       * forward, so fabricating a partial-day average would misrepresent it as a full one.
       * `deactivated_before_day` — defensive: the station was already inactive before this day
       * even started, so there is no valid instant in `[dayStart, dayEnd)` to weight at all;
       * the orchestrating job should not be calling this for such a day in the first place. */
      reason: "no_prior_observation" | "deactivated_before_day";
    }
  | {
      skipped: false;
      timeWeightedAvgTenths: number;
      minTenthsCpl: number;
      maxTenthsCpl: number;
      openTenthsCpl: number;
      closeTenthsCpl: number;
      observationCount: number;
      carriedForward: boolean;
      openingPriceAgeDays: number;
      partialDay: boolean;
    };

interface Interval {
  priceTenthsCpl: number;
  startMs: number;
  endMs: number;
}

/** §10.4 case D: two observations sharing the exact same `sourceReportedAt` — the one written
 * later (higher `retrievedAt`) wins; the other is discarded entirely rather than left to create
 * a zero-length interval that would need special-casing downstream. */
function dedupeBySourceReportedAt(observations: RollupObservation[]): RollupObservation[] {
  const latestByTimestamp = new Map<number, RollupObservation>();
  for (const obs of observations) {
    const key = obs.sourceReportedAt.getTime();
    const existing = latestByTimestamp.get(key);
    if (!existing || obs.retrievedAt.getTime() > existing.retrievedAt.getTime()) {
      latestByTimestamp.set(key, obs);
    }
  }
  return [...latestByTimestamp.values()];
}

export function computeDailyRollup(input: ComputeDailyRollupInput): ComputeDailyRollupResult {
  const { dayStart, dayEnd } = input;
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime();

  // §10.4 case F: truncate the day at deactivation, if it happened during this day.
  const deactivatedAtMs = input.deactivatedAt?.getTime();
  const partialDay = deactivatedAtMs !== undefined && deactivatedAtMs < dayEndMs;
  const effectiveEndMs =
    deactivatedAtMs !== undefined ? Math.min(deactivatedAtMs, dayEndMs) : dayEndMs;

  if (effectiveEndMs <= dayStartMs) {
    return { skipped: true, reason: "deactivated_before_day" };
  }

  const deduped = dedupeBySourceReportedAt(input.observations);

  // Step 1 — the opening price: the most recent observation strictly before dayStart, however
  // far back it is (case B). None at all means this is the station's first day (case C).
  let opening: RollupObservation | undefined;
  for (const obs of deduped) {
    if (obs.sourceReportedAt.getTime() < dayStartMs) {
      if (!opening || obs.sourceReportedAt.getTime() > opening.sourceReportedAt.getTime()) {
        opening = obs;
      }
    }
  }
  if (!opening) {
    return { skipped: true, reason: "no_prior_observation" };
  }

  // Step 2 — the day's change events, in order, truncated at effectiveEndMs (case F).
  const dayEvents = deduped
    .filter(
      (obs) =>
        obs.sourceReportedAt.getTime() >= dayStartMs &&
        obs.sourceReportedAt.getTime() < effectiveEndMs,
    )
    .sort((a, b) => a.sourceReportedAt.getTime() - b.sourceReportedAt.getTime());

  // Step 3 — build intervals: opening price from dayStart, each event closes the previous
  // interval and opens its own, the last interval runs to effectiveEndMs.
  const intervals: Interval[] = [];
  let cursorMs = dayStartMs;
  let currentPrice = opening.priceTenthsCpl;
  for (const event of dayEvents) {
    const eventMs = event.sourceReportedAt.getTime();
    intervals.push({ priceTenthsCpl: currentPrice, startMs: cursorMs, endMs: eventMs });
    cursorMs = eventMs;
    currentPrice = event.priceTenthsCpl;
  }
  intervals.push({ priceTenthsCpl: currentPrice, startMs: cursorMs, endMs: effectiveEndMs });

  // Step 4 — weight by duration. Zero-length intervals (case D leftovers, or an event landing
  // exactly on dayStart) contribute nothing to either sum, which is correct by construction.
  let weightedSumTenthsMs = 0;
  let totalDurationMs = 0;
  let minTenthsCpl = intervals[0].priceTenthsCpl;
  let maxTenthsCpl = intervals[0].priceTenthsCpl;
  for (const interval of intervals) {
    const duration = interval.endMs - interval.startMs;
    weightedSumTenthsMs += interval.priceTenthsCpl * duration;
    totalDurationMs += duration;
    minTenthsCpl = Math.min(minTenthsCpl, interval.priceTenthsCpl);
    maxTenthsCpl = Math.max(maxTenthsCpl, interval.priceTenthsCpl);
  }

  const openingPriceAgeDays = Math.floor(
    (dayStartMs - opening.sourceReportedAt.getTime()) / MS_PER_DAY,
  );

  return {
    skipped: false,
    timeWeightedAvgTenths: Math.round(weightedSumTenthsMs / totalDurationMs),
    minTenthsCpl,
    maxTenthsCpl,
    openTenthsCpl: opening.priceTenthsCpl,
    closeTenthsCpl: intervals[intervals.length - 1].priceTenthsCpl,
    // Only events that actually landed inside the (possibly truncated) day count — the opening
    // price's own observation is from a prior day and is never counted here.
    observationCount: dayEvents.length,
    // Always true given step 1's construction: the opening price's source observation is, by
    // definition, from strictly before dayStart — i.e. always "a prior day" — for every day
    // that isn't skipped under case C. Computed explicitly (not hardcoded) so this stays
    // correct if the algorithm's opening-price rule ever changes.
    carriedForward: opening.sourceReportedAt.getTime() < dayStartMs,
    openingPriceAgeDays,
    partialDay,
  };
}
