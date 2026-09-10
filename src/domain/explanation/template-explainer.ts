/**
 * `12_AI_ARCHITECTURE.md` §12.1: "Build the explanation layer as a template renderer... DEFAULT,
 * off by default for the LLM." This is that renderer — the only `Explainer` implementation this
 * branch builds (§12.1's "the templates get built either way" — an `LlmExplainer` is Phase 2,
 * per §12.4, not MVP). Pure — no I/O, no clock, no randomness (`src/domain/README.md`'s rules):
 * every fact used is already present in the input, nothing is looked up or invented.
 *
 * **Fixed phrase fragments, composed — not one canned sentence per reason-code combination.**
 * §12.4 names the real risk directly: "with 14 codes, the combinatorics of natural-sounding
 * multi-reason prose grow awkward." A lookup table keyed by the full `reasonCodes` set would need
 * up to 2^14 entries; this instead picks ONE primary clause from a small, mutually-exclusive
 * decision table (mirroring §12.3's own single worked example, which is itself one comparative
 * sentence, not a list of every reason code stitched together) and interpolates only numbers
 * already computed by the calculation engine. The other reason codes — freshness bands, local-
 * average position, the two "assumed" flags — are surfaced to the UI as the raw `reasonCodes`
 * array already returned by `/search` (§9.8: "structurally visible in the output"), rendered as
 * separate badges/tags by the results screen (§21.9's mockup literally renders them that way),
 * not folded into this one sentence.
 */
import type { RecommendationResult } from "../calculation/rank-candidates";
import type { Explainer, HistoricalContext } from "./explainer";
import { MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS } from "../calculation/confidence";

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatCentsPerLitre(tenths: number): string {
  return `${(tenths / 10).toFixed(1)}¢/L`;
}

function formatKm(km: number): string {
  return `${km.toFixed(1)} km`;
}

function stationLabel(brand: string | null): string {
  return brand ?? "This station";
}

/**
 * The one sentence §12.3 asks for, e.g. *"Ampol is 2.4 km away and works out about $4.80 cheaper
 * once the extra driving is counted."* `RecommendationResult` carries no station name/address
 * (deliberately — `station-search-repository.ts`'s own comment on why display fields stay out of
 * the calc engine's types), so this uses `brand`, falling back to a generic label when it's
 * `null`.
 */
export function explainRecommendation(result: RecommendationResult): string {
  const { recommended, reasonCodes, estimatedSavingCents } = result;
  const label = stationLabel(recommended.brand);
  const alreadyNearestAndCheapest = reasonCodes.includes("ALREADY_NEAREST_AND_CHEAPEST");
  const detourNotWorthSaving = reasonCodes.includes("DETOUR_NOT_WORTH_SAVING");
  const lowerEffectiveCost = reasonCodes.includes("LOWER_EFFECTIVE_COST");

  if (alreadyNearestAndCheapest && detourNotWorthSaving) {
    return (
      `${label} is your closest option and still works out cheapest once the drive is ` +
      `counted — a lower per-litre price exists further away, but it's not worth the extra ` +
      `distance.`
    );
  }

  if (alreadyNearestAndCheapest) {
    return `${label} is your closest option and also comes out cheapest once the drive is counted — no detour worth making today.`;
  }

  if (lowerEffectiveCost) {
    return (
      `${label} is ${formatKm(recommended.metrics.distanceKm)} away and works out about ` +
      `${formatDollars(estimatedSavingCents)} cheaper than the nearest alternative, once the ` +
      `extra driving is counted.`
    );
  }

  // Defensive fallback — every real result from rankCandidates emits one of the two codes
  // above (buildReasonCodes always pushes ALREADY_NEAREST_AND_CHEAPEST when the recommended
  // candidate is also the nearest, which single-candidate results always are), but this
  // function shouldn't silently produce nothing if that ever changes.
  return `${label} is ${formatKm(recommended.metrics.distanceKm)} away, priced at ${formatCentsPerLitre(recommended.metrics.priceTenthsCpl)}.`;
}

/**
 * UC-03's "Is this a good local price?" sentence. Not yet called by a real endpoint
 * (`/recommendations/local-price` is Milestone 3) — see `explainer.ts`'s module comment.
 * §9.7: "`low` confidence must change what the UI says, not merely add a badge... a
 * recommendation the system cannot support should not be made" — so insufficient history
 * produces a fixed refusal, never a hedged guess.
 */
export function explainPriceContext(context: HistoricalContext): string {
  if (context.historyDays < MEDIUM_CONFIDENCE_MIN_HISTORY_DAYS || context.averageTenths === null) {
    return "Not enough local history has been collected yet to judge whether this is a good price.";
  }

  const diffTenths = context.currentPriceTenths - context.averageTenths;
  const diffCents = Math.abs(diffTenths) / 10;
  const direction = diffTenths < 0 ? "below" : diffTenths > 0 ? "above" : "in line with";

  const base =
    diffTenths === 0
      ? `Current price is right in line with the ${context.historyDays}-day local average.`
      : `Current price is ${diffCents.toFixed(1)}¢ ${direction} the ${context.historyDays}-day local average.`;

  if (context.percentile === null) {
    return base;
  }

  // `history.ts`'s `rankPercentile` is literally "the fraction of days at or below the current
  // price" (its own doc comment) — a HIGH percentile means today is at or above almost every
  // other day, i.e. an expensive day, and a LOW percentile means an unusually cheap one. So the
  // "cheaper than N% of days" framing below is `1 - percentile`, not `percentile` directly —
  // using `percentile` here would silently invert the sentence's meaning.
  const cheaperThanPercent = Math.round((1 - context.percentile) * 100);
  return `${base} That's cheaper than ${cheaperThanPercent}% of the last ${context.historyDays} days.`;
}

export const templateExplainer: Explainer = {
  explainRecommendation,
  explainPriceContext,
};
