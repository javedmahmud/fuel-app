/**
 * `09_CALCULATION_ENGINE.md` §9.4 — the "practical cost, not cents per litre" core idea, and
 * the three gaps closed around it. Ranking by `L × Pᵢ + Dᵢ` correctly trades price against
 * detour and changes its mind based on fill size; nothing about that model changes here, only
 * its previously-underspecified edges.
 */
import { LITRES_UNKNOWN, type LitresRequired } from "./litres";

/** §9.3: `litresRequired` returns `Unknown` when the current fuel fraction isn't known — the
 * default case, since most users never enter a vehicle profile at all (§9.4.4). Both inputs are
 * required for a concrete figure: a tank capacity with no fraction, or vice versa, is just as
 * unknown as having neither. `tankCapacityLitres × (1 − currentFuelFraction)` per `03`'s
 * original formula — §9.4 raises no objection to this part, only to what happens around it. */
export function litresRequired(
  tankCapacityLitres: number | null,
  currentFuelFraction: number | null,
): LitresRequired {
  if (tankCapacityLitres === null || currentFuelFraction === null) {
    return LITRES_UNKNOWN;
  }
  return tankCapacityLitres * (1 - currentFuelFraction);
}

/** `litres × (priceTenthsCpl / 10)`, rounded to the nearest cent — the one point in this module
 * where a fraction-of-a-cent result must collapse to money's integer-cents unit (`09` §9.1). */
export function fillCostCents(litres: number, priceTenthsCpl: number): number {
  return Math.round((litres * priceTenthsCpl) / 10);
}

/** §9.3's separately-named `detourFuelLitres` — kept as its own export because it's independently
 * useful (e.g. for showing "uses an extra 0.5 L" in an explanation) and because §9.4.2's worked
 * example is stated in these exact intermediate terms. */
export function detourFuelLitres(roundTripKm: number, consumptionLPer100km: number): number {
  return (roundTripKm * consumptionLPer100km) / 100;
}

/** §21.4's actual signature combines `detourFuelLitres` + `detourFuelCost` into one call —
 * followed here since the sprint plan names §21.4 as the authoritative source for signatures,
 * while still exposing `detourFuelLitres` above for the intermediate value. */
export function extraFuelCostCents(
  roundTripKm: number,
  consumptionLPer100km: number,
  priceTenthsCpl: number,
): number {
  return fillCostCents(detourFuelLitres(roundTripKm, consumptionLPer100km), priceTenthsCpl);
}

export function effectiveCostCents(fillCost: number, extraFuelCost: number): number {
  return fillCost + extraFuelCost;
}

/**
 * §9.4.3: **vs. the nearest eligible station, never the average or the most expensive
 * candidate** — the only baseline that describes a decision the user actually faced, and the
 * smallest, most honest of the three candidates the doc considered. Zero when the recommendation
 * *is* the nearest station (reason code `ALREADY_NEAREST_AND_CHEAPEST` at the orchestration
 * layer, not here — this function only computes the number).
 */
export function estimatedSavingCents(
  candidateCostCents: number,
  nearestEligibleCostCents: number,
): number {
  return nearestEligibleCostCents - candidateCostCents;
}
