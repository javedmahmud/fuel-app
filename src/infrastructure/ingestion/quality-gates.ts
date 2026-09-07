import type { PriceObservation } from "../fuel-api/types";

/**
 * `08_INGESTION_ARCHITECTURE.md` §8.10 (and `06_DATA_ARCHITECTURE.md` §6.9's earlier version of
 * the same table). Records failing any check are **rejected, counted, and logged with their
 * payload — never silently dropped, never coerced into looking valid.**
 *
 * Two simplifications from the doc's exact wording, both because supporting infrastructure this
 * branch doesn't build yet is missing — noted here rather than silently deviating:
 *
 * - **"Station known" → reject, not "queue for ref-data resync, retry."** A retry-queue is
 *   genuine future work; for now an unknown station is rejected like any other gate failure,
 *   and the next scheduled `ref_data` run (weekly) is what would make it resolvable again.
 * - **"source_reported_at sane" → reject, not "clamp + flag."** Clamping-and-keeping needs a
 *   quality-flag column on `fuel_price_observation` that doesn't exist in the current schema.
 *   Rejecting a record with a wildly wrong timestamp is the conservative substitute — it's
 *   still counted and logged with its payload, so nothing is silently lost, just not silently
 *   coerced into looking trustworthy either.
 */

/** 50.0–500.0 c/L in the raw unit, i.e. 500–5000 in our integer-tenths storage unit. */
const PLAUSIBLE_PRICE_TENTHS_MIN = 500;
const PLAUSIBLE_PRICE_TENTHS_MAX = 5000;

/** Clock skew tolerance for "not in the future." Generous on purpose — this is about catching
 * genuinely wrong timestamps, not policing sub-minute skew between our clock and NSW's. */
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000; // 1 hour
const MAX_AGE_MS = 366 * 24 * 60 * 60 * 1000; // just over a year, per the "not >1 year old" rule

/**
 * Fuel type codes the NSW Fuel API includes in every `/prices` response that aren't actually
 * priced per litre. Currently just `"EV"` (electric vehicle charging) — the API reports it for
 * every station with `price: 0` regardless of whether that station offers charging, since
 * charging isn't sold in cents/litre at all. This is not malformed or out-of-range price data;
 * it was never price data to begin with, so it's filtered out *before* `applyQualityGates`
 * below rather than being evaluated and rejected by the price-plausibility check.
 *
 * Found live investigating a real full_sync run that logged "910 rejected" (~8.6%, over
 * §8.11's >5%-of-a-batch alarm threshold): replaying the journaled raw response showed 903 of
 * those 910 were 100% of that run's "EV" rows, all `price: 0` — i.e. the alarm was firing on
 * every healthy run, not on a real data problem (the other 7 were genuine stale
 * `source_reported_at` values, correctly rejected). Excluding these here — not counted toward
 * `rejectedCount`/`rejectedByReason` in persist-observations.ts — is what makes
 * `rejected_pct` a meaningful signal again.
 */
const NON_PRICED_FUEL_TYPE_CODES: ReadonlySet<string> = new Set(["EV"]);

export function isNonPricedFuelType(fuelTypeSourceCode: string): boolean {
  return NON_PRICED_FUEL_TYPE_CODES.has(fuelTypeSourceCode);
}

export type QualityGateReason =
  | "price_not_numeric"
  | "price_implausible"
  | "fuel_type_unknown"
  | "station_unknown"
  | "source_reported_at_insane";

export type QualityGateOutcome =
  { accepted: true } | { accepted: false; reason: QualityGateReason; alarmWorthy: boolean };

export interface QualityGateContext {
  knownStationCodes: ReadonlySet<string>;
  knownFuelTypeCodes: ReadonlySet<string>;
  now: Date;
}

export function applyQualityGates(
  observation: PriceObservation,
  context: QualityGateContext,
): QualityGateOutcome {
  if (!Number.isFinite(observation.priceTenthsCpl)) {
    return { accepted: false, reason: "price_not_numeric", alarmWorthy: false };
  }

  // The plausibility band earns its alarm: if NSW ever changed price units, every record would
  // still parse as a valid integer. This is the only thing standing between that and a database
  // full of prices wrong by a factor of ten.
  if (
    observation.priceTenthsCpl < PLAUSIBLE_PRICE_TENTHS_MIN ||
    observation.priceTenthsCpl > PLAUSIBLE_PRICE_TENTHS_MAX
  ) {
    return { accepted: false, reason: "price_implausible", alarmWorthy: true };
  }

  if (!context.knownFuelTypeCodes.has(observation.fuelTypeSourceCode)) {
    return { accepted: false, reason: "fuel_type_unknown", alarmWorthy: true };
  }

  if (!context.knownStationCodes.has(observation.sourceStationCode)) {
    return { accepted: false, reason: "station_unknown", alarmWorthy: false };
  }

  if (!observation.sourceReportedAt) {
    return { accepted: false, reason: "source_reported_at_insane", alarmWorthy: false };
  }
  const ageMs = context.now.getTime() - observation.sourceReportedAt.getTime();
  if (ageMs < -FUTURE_TOLERANCE_MS || ageMs > MAX_AGE_MS) {
    return { accepted: false, reason: "source_reported_at_insane", alarmWorthy: false };
  }

  return { accepted: true };
}
