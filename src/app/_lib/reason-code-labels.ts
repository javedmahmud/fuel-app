/**
 * `21_DETAILED_DESIGN.md` §21.9's UI principle: "Explain why, from reason codes, never free
 * text — the UI renders the `reasonCodes` enum from §21.5 through a fixed lookup table of short
 * phrases. A new reason meaning requires a new code, not a copy tweak." This is that lookup
 * table — display-only, deliberately separate from `domain/explanation/template-explainer.ts`'s
 * one-sentence `explanation` (which already narrates the primary "why this station" reasoning);
 * these are the short supporting badges the Results screen renders alongside it, matching the
 * approved mockup's tag list.
 */
import type { ReasonCode } from "../../domain/calculation/types";

const REASON_CODE_LABELS: Record<ReasonCode, string | null> = {
  // Narrated in the explanation sentence already — no separate badge needed.
  ALREADY_NEAREST_AND_CHEAPEST: null,
  LOWER_EFFECTIVE_COST: null,
  DETOUR_NOT_WORTH_SAVING: null,
  // True for every eligible candidate, always (rank-candidates.ts's own comment) — no
  // informational value as a badge.
  WITHIN_MAX_DETOUR: null,

  LOWEST_UNIT_PRICE: "Lowest price per litre",
  SHORTEST_DETOUR: "Shortest detour",
  FRESH_PRICE: "Price confirmed recently",
  PRICE_UNCHANGED_RECENTLY: "Price steady a few days",
  BELOW_LOCAL_AVERAGE: "Below local average",
  ABOVE_LOCAL_AVERAGE: "Above local average",
  LIMITED_HISTORY: "Limited local history",
  SPARSE_CANDIDATES: "Few stations nearby",
  COMPARISON_VOLUME_ASSUMED: "Based on a 40L reference fill",
  CONSUMPTION_DEFAULT_ASSUMED: "Assumes average fuel use",
};

/** Every code that has a badge, in a fixed display order (not the order the engine happened to
 * push them in) — `null`-labelled codes (already narrated, or uninformative) are dropped. */
const DISPLAY_ORDER: ReasonCode[] = [
  "LOWEST_UNIT_PRICE",
  "SHORTEST_DETOUR",
  "FRESH_PRICE",
  "PRICE_UNCHANGED_RECENTLY",
  "BELOW_LOCAL_AVERAGE",
  "ABOVE_LOCAL_AVERAGE",
  "LIMITED_HISTORY",
  "SPARSE_CANDIDATES",
  "COMPARISON_VOLUME_ASSUMED",
  "CONSUMPTION_DEFAULT_ASSUMED",
];

export function reasonCodeBadges(reasonCodes: readonly string[]): string[] {
  const present = new Set(reasonCodes);
  return DISPLAY_ORDER.filter((code) => present.has(code)).map(
    (code) => REASON_CODE_LABELS[code] as string,
  );
}
