/**
 * `12_AI_ARCHITECTURE.md` §12.5 — "The interface." `RecommendationResult` (and
 * `HistoricalContext` below) is the only channel between the calculation engine and whatever
 * renders prose: no database access, no tools, no retrieval, no arithmetic capability. §12.2's
 * guardrail ("Claude must not invent prices, station availability, opening hours, fuel types, or
 * historical data. Deterministic application logic is authoritative. AI may explain structured
 * calculations.") is enforced by this type signature, not by prompt instructions — an
 * `LlmExplainer` implementing this same interface (§12.6, flag-gated, not built in this branch)
 * would have exactly the same structural inability to fabricate a number.
 */
import type { RecommendationResult } from "../calculation/rank-candidates";
import type { TrendDirection } from "../calculation/history";

/**
 * The input `explainPriceContext` needs for UC-03 ("Is this a good local price?") — not yet
 * consumed by a real endpoint (`21_DETAILED_DESIGN.md` §21.1's `/recommendations/local-price` is
 * explicitly Milestone 3, behind a feature flag), but built and tested now per §12.5's interface,
 * the same "build the whole interface, not just today's caller" treatment this codebase already
 * gives `Result<T, E>` and the worker's job-runner pattern. Assembled by a caller with database
 * access from `domain/calculation/history.ts`'s own functions, the same division of
 * responsibility `LocalAreaContext` already uses in `rank-candidates.ts`.
 */
export interface HistoricalContext {
  /** The station's current price, in tenths of a cent per litre — never derived from the
   * rollup (`06_DATA_ARCHITECTURE.md` §6.1: a derived cache is not the source for "right now"). */
  currentPriceTenths: number;
  /** §10.7's time-weighted average over the window, in tenths of a cent per litre. `null` only
   * when there's no usable history at all (`history.ts`'s `timeWeightedAverage`'s own contract). */
  averageTenths: number | null;
  /** §9.6.2's rank-based percentile of `currentPriceTenths` against the window's daily
   * averages — the fraction of days at or below the current price. */
  percentile: number | null;
  trendDirection: TrendDirection;
  /** Days of history in the window — the same `daily_price_rollup` row count basis
   * `ConfidenceInput.historyDays` and the history endpoint's `insufficient_history` gate both
   * use, via the shared `MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS` threshold. */
  historyDays: number;
}

/**
 * §12.5's literal interface: `explainRecommendation(result) → string`,
 * `explainPriceContext(context) → string`. An `LlmExplainer` (not built here — §12.1: "off by
 * default", not required for MVP) would implement the same shape, so `search-service.ts` (or
 * whichever caller) can depend on this interface rather than the concrete `TemplateExplainer`.
 */
export interface Explainer {
  explainRecommendation(result: RecommendationResult): string;
  explainPriceContext(context: HistoricalContext): string;
}
