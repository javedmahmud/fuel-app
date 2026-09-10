/**
 * `09_CALCULATION_ENGINE.md` §9.1: the calculation engine is a pure library — no database
 * handle, no HTTP client, no clock, no random source. Plain data in, plain data out. Units are
 * explicit and integral throughout (`06_DATA_ARCHITECTURE.md` §6.4): prices are integer tenths
 * of a cent per litre (`priceTenthsCpl`, matching every other module in this codebase — never
 * the float "cents per litre" shown in §21.4's illustrative pseudocode), money is integer
 * cents, distances are kilometres, volumes are litres. Conversion to display units happens once,
 * at the presentation boundary, not here.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** §9.8 — the only channel between the calculation engine and the explanation layer. Prose is
 * derived from these codes, never the reverse (§21.5): the explainer receives an enum, not a
 * number to describe freely. This is what makes the AI guardrails structural. */
export type ReasonCode =
  | "LOWER_EFFECTIVE_COST"
  | "LOWEST_UNIT_PRICE"
  | "WITHIN_MAX_DETOUR"
  | "SHORTEST_DETOUR"
  | "FRESH_PRICE"
  | "PRICE_UNCHANGED_RECENTLY"
  | "BELOW_LOCAL_AVERAGE"
  | "ABOVE_LOCAL_AVERAGE"
  | "ALREADY_NEAREST_AND_CHEAPEST"
  | "DETOUR_NOT_WORTH_SAVING"
  | "LIMITED_HISTORY"
  | "SPARSE_CANDIDATES"
  | "COMPARISON_VOLUME_ASSUMED"
  | "CONSUMPTION_DEFAULT_ASSUMED";

/** §9.2: increment whenever a formula changes. A stored `recommendation_log` row persists
 * whichever version actually produced it, so historical recommendations stay explainable
 * against the version that ran, even after this changes. */
export const ENGINE_VERSION = "1.0.0";

/** §9.4.4: comparison mode's fixed internal reference volume — never shown to the user (the
 * primary UI states a difference, never a total), retained purely as a normalisation basis so
 * ranking is well-defined with no vehicle profile at all, which is the default path. */
export const COMPARISON_REFERENCE_VOLUME_LITRES = 40;

/** §9.4.4: "a national-average figure (~8.5 L/100km, configurable)... used for the detour term
 * with the same labelling discipline" as the reference volume above. */
export const DEFAULT_CONSUMPTION_L_PER_100KM = 8.5;

export type Mode = "comparison" | "personalised";
