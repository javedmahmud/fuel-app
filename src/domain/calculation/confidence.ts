/**
 * `09_CALCULATION_ENGINE.md` §9.7: "It must be computed, never asserted, or it is decoration."
 * All conditions in a tier must hold — this is an AND, not a weighted score.
 */
import type { Mode } from "./types";

export type ConfidenceLevel = "high" | "medium" | "low";

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

  if (historyDays >= 7 && candidateCount >= 2 && priceAgeHours < 7 * 24) {
    return "medium";
  }

  return "low";
}
