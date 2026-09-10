/**
 * `09_CALCULATION_ENGINE.md` §9.7: "It must be computed, never asserted, or it is decoration."
 * All conditions in a tier must hold — this is an AND, not a weighted score.
 */
import type { Mode } from "./types";

export type ConfidenceLevel = "high" | "medium" | "low";

/** §9.7's `medium` tier's day requirement — also reused by
 * `src/application/handle-station-history-request.ts` as the "insufficient history" gate for
 * `GET /stations/{id}/history` (`21_DETAILED_DESIGN.md` §21.1: "fewer than the
 * confidence-threshold days (§9.7)"), so both consumers read the same threshold rather than two
 * independently-typed magic numbers that could drift apart. */
export const MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS = 7;

export interface ConfidenceInput {
  /** Days of history in the averaging window — from `daily_price_rollup`'s row count, not raw
   * observations. */
  historyDays: number;
  /** Eligible candidate stations, after the eligibility gate (§9.9's flowchart), not the raw
   * bounding-box hit count. */
  candidateCount: number;
  /** Age of the *recommended* station's price, in hours (`source_reported_at`-based, matching
   * `priceAgeBand`'s own basis — never `retrieved_at`). */
  priceAgeHours: number;
  mode: Mode;
}

/**
 * §9.7's table. `high` additionally requires personalised mode — §9.4.4's "Confidence | Capped
 * at medium" for comparison mode is the same rule stated from the other side: comparison mode
 * can never reach `high`, no matter how much history or how fresh the price, because the
 * recommendation is still built on an assumed 40 L fill rather than the user's own tank.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceLevel {
  const { historyDays, candidateCount, priceAgeHours, mode } = input;

  if (mode === "personalised" && historyDays >= 20 && candidateCount >= 3 && priceAgeHours < 48) {
    return "high";
  }

  if (
    historyDays >= MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS &&
    candidateCount >= 2 &&
    priceAgeHours < 7 * 24
  ) {
    return "medium";
  }

  return "low";
}
