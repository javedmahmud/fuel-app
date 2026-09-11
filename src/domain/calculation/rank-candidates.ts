/**
 * `09_CALCULATION_ENGINE.md` §9.9's ranking pipeline, orchestrating every other module in this
 * directory. This is the one function in the engine with real interpretive judgment calls
 * beyond what the spec states literally — each is called out in its own comment below, the
 * same "documented deviation, not a silent gap" discipline used throughout this codebase.
 */
import { computeConfidence, type ConfidenceLevel } from "./confidence";
import {
  effectiveCostCents,
  estimatedSavingCents,
  extraFuelCostCents,
  fillCostCents,
  litresRequired,
} from "./cost";
import {
  DEFAULT_ELIGIBILITY_MAX_AGE_DAYS,
  isFreshEnoughForEligibility,
  priceAgeBand,
} from "./freshness";
import { additionalRoundTripKm, haversineDistanceKm } from "./geo";
import { trend } from "./history";
import { isLitresKnown, LITRES_UNKNOWN } from "./litres";
import {
  COMPARISON_REFERENCE_VOLUME_LITRES,
  DEFAULT_CONSUMPTION_L_PER_100KM,
  ENGINE_VERSION,
  type LatLng,
  type Mode,
  type ReasonCode,
} from "./types";
import { err, ok, type Result } from "../result";

export type LifecycleState = "active" | "suspect" | "inactive";

export interface CandidateStation {
  stationId: string;
  brand: string | null;
  location: LatLng;
  lifecycleState: LifecycleState;
  /** `undefined` when this station doesn't sell the selected fuel type at all — §9.9's first
   * eligibility gate. */
  price?: { priceTenthsCpl: number; sourceReportedAt: Date };
}

export interface VehicleProfileInput {
  tankCapacityLitres: number | null;
  currentFuelFraction: number | null;
  consumptionLPer100km: number | null;
}

/**
 * The local-area price history this function needs to compute `BELOW_LOCAL_AVERAGE`, rank
 * percentile, and trend — assembled by the caller (the repository/orchestration layer, which has
 * DB access) from real `daily_price_rollup` rows via `history.ts`'s own functions. Kept as an
 * input rather than computed here so this module stays pure (§9.1) — it cannot reach into the
 * database itself.
 */
export interface LocalAreaContext {
  historyDays: number;
  localAverageTenths: number | null;
  /** Daily average prices in the window, for `rankPercentile`. */
  windowPricesTenths: readonly number[];
  /** Daily closes in day order, for `trend`. */
  closesTenthsInDayOrder: readonly number[];
}

/**
 * How a candidate's round-trip detour is computed — the one seam between this pipeline's
 * eligibility/cost/ranking logic (mode-agnostic) and the two genuinely different geometries that
 * feed it. Defaults to `originRadialDetourKm` (nearby search, UC-01, §9.4.2's ×2 round-trip
 * convention); UC-02's commute mode (`feature/commute-api`) supplies `corridorDetourKm` instead,
 * via `geo.ts`. Kept as an injected function rather than a `mode: "radial" | "corridor"` flag so
 * this module never needs to know commute mode exists — same "domain has no outgoing arrows"
 * discipline (`05_CONTEXT_AND_CONTAINERS.md` §5.3) applied to a second use case, not just I/O.
 */
export type DetourKmStrategy = (origin: LatLng, candidateLocation: LatLng) => number;

const originRadialDetourKm: DetourKmStrategy = (origin, candidateLocation) =>
  additionalRoundTripKm(haversineDistanceKm(origin, candidateLocation));

export interface RankCandidatesInput {
  candidates: readonly CandidateStation[];
  origin: LatLng;
  /** Round-trip cap, matching `additionalRoundTripKm`'s own round-trip convention (§9.4.2) —
   * not a one-way distance limit. Compared against whatever `detourKm` below produces, so the
   * same cap works unchanged for both nearby-search and commute mode. */
  maxDetourKm: number;
  /** `null` means no vehicle profile at all — comparison mode, unconditionally (§9.4.4). A
   * profile that exists but is missing tank capacity or current fraction still resolves to
   * comparison mode via `litresRequired`'s own `Unknown` outcome — this function does not
   * duplicate that check, it just asks `litresRequired`. */
  vehicleProfile: VehicleProfileInput | null;
  localArea: LocalAreaContext;
  preferredBrand?: string;
  eligibilityMaxAgeDays?: number;
  /** Defaults to `originRadialDetourKm` — every existing caller (UC-01 search) is unaffected by
   * this field's existence unless it opts in. */
  detourKm?: DetourKmStrategy;
  now: Date;
}

export interface RankedCandidateMetrics {
  distanceKm: number;
  additionalRoundTripKm: number;
  fillCostCents: number;
  extraFuelCostCents: number;
  effectiveCostCents: number;
  priceTenthsCpl: number;
  sourceReportedAt: Date;
}

export interface RankedCandidate {
  stationId: string;
  brand: string | null;
  metrics: RankedCandidateMetrics;
}

interface RecommendationBase {
  engineVersion: string;
  recommended: RankedCandidate;
  /** Full eligible set, in ranked order — not just the winner, since the presentation layer
   * needs the runner-ups too. */
  ranked: readonly RankedCandidate[];
  reasonCodes: ReasonCode[];
  estimatedSavingCents: number;
  confidence: ConfidenceLevel;
  rankPercentile: number | null;
  trendDirection: "rising" | "falling" | "flat";
}

/** §9.4.4: kept as a genuinely distinct type from `PersonalisedResult` — not a shared type with
 * an optional field — so the presentation layer cannot accidentally render one as the other. */
export interface ComparisonResult extends RecommendationBase {
  mode: "comparison";
  referenceVolumeLitres: number;
}

export interface PersonalisedResult extends RecommendationBase {
  mode: "personalised";
  litresRequiredLitres: number;
}

export type RecommendationResult = ComparisonResult | PersonalisedResult;

export type RankCandidatesError = { type: "no_eligible_candidates" };

interface ComputedCandidate {
  station: CandidateStation;
  metrics: RankedCandidateMetrics;
}

function isEligible(
  candidate: CandidateStation,
  origin: LatLng,
  maxDetourKm: number,
  detourKm: DetourKmStrategy,
  eligibilityMaxAgeDays: number,
  now: Date,
): boolean {
  // §9.9's flowchart, in order — a candidate must pass every gate.
  if (!candidate.price) return false; // sells selected fuel type?
  if (detourKm(origin, candidate.location) > maxDetourKm) return false; // within max detour?
  if (!isFreshEnoughForEligibility(candidate.price.sourceReportedAt, now, eligibilityMaxAgeDays)) {
    return false; // price within staleness cutoff?
  }
  // Station active? — `suspect` stays eligible, deliberately consistent with the ingestion
  // side's loadKnownStationCodeToId: §8.6 calls a suspect station "still searchable," a
  // degraded-confidence flag rather than an exclusion. Only `inactive` is excluded here.
  if (candidate.lifecycleState === "inactive") return false;
  return true;
}

function computeMetrics(
  candidate: CandidateStation,
  origin: LatLng,
  litres: number,
  consumptionLPer100km: number,
  detourKm: DetourKmStrategy,
): RankedCandidateMetrics {
  const price = candidate.price as NonNullable<CandidateStation["price"]>; // guaranteed by isEligible
  // distanceKm always means "straight-line distance from origin," in both modes — only the
  // round-trip detour figure differs by mode (originRadialDetourKm vs corridorDetourKm). It's
  // still meaningful display/tie-breaker information for a commute candidate (§9.9's tie-breaker
  // #1 reads it as "shorter [origin] distance", unchanged).
  const distanceKm = haversineDistanceKm(origin, candidate.location);
  const roundTripKm = detourKm(origin, candidate.location);
  const fillCost = fillCostCents(litres, price.priceTenthsCpl);
  const extraCost = extraFuelCostCents(roundTripKm, consumptionLPer100km, price.priceTenthsCpl);
  return {
    distanceKm,
    additionalRoundTripKm: roundTripKm,
    fillCostCents: fillCost,
    extraFuelCostCents: extraCost,
    effectiveCostCents: effectiveCostCents(fillCost, extraCost),
    priceTenthsCpl: price.priceTenthsCpl,
    sourceReportedAt: price.sourceReportedAt,
  };
}

/**
 * §9.9: "Tie within 1 cent?" — interpreted here as *exact* equality of `effectiveCostCents`
 * (already integer, already rounded), not a sliding ±1c window. A sliding tolerance ("A ties
 * with B, B ties with C, but A and C don't") is not, in general, transitive — and §9.10 requires
 * "ranking is a total order" as a hard property. The "0.3-cent gap" noise the doc's own
 * reasoning describes is sub-cent float noise, which rounding to whole cents in `cost.ts`
 * already absorbs; exact-cent equality is the transitivity-safe reading of the same intent.
 */
function compareCandidates(
  a: ComputedCandidate,
  b: ComputedCandidate,
  now: Date,
  preferredBrand: string | undefined,
): number {
  const costDiff = a.metrics.effectiveCostCents - b.metrics.effectiveCostCents;
  if (costDiff !== 0) return costDiff;

  // Tie-breakers, in §9.9's exact order.
  const distanceDiff = a.metrics.distanceKm - b.metrics.distanceKm; // 1. shorter distance
  if (distanceDiff !== 0) return distanceDiff;

  const ageDiff = // 2. fresher price — smaller age wins
    now.getTime() -
    a.metrics.sourceReportedAt.getTime() -
    (now.getTime() - b.metrics.sourceReportedAt.getTime());
  if (ageDiff !== 0) return ageDiff;

  if (preferredBrand) {
    // 3. user preference
    const aMatch = a.station.brand === preferredBrand;
    const bMatch = b.station.brand === preferredBrand;
    if (aMatch !== bMatch) return aMatch ? -1 : 1;
  }

  return a.metrics.priceTenthsCpl - b.metrics.priceTenthsCpl; // 4. lower unit price
}

function buildReasonCodes(args: {
  recommended: ComputedCandidate;
  ranked: readonly ComputedCandidate[];
  nearestEligible: ComputedCandidate;
  localArea: LocalAreaContext;
  confidence: ConfidenceLevel;
  mode: Mode;
  consumptionWasDefaulted: boolean;
  now: Date;
}): ReasonCode[] {
  const {
    recommended,
    ranked,
    nearestEligible,
    localArea,
    confidence,
    mode,
    consumptionWasDefaulted,
    now,
  } = args;
  const codes: ReasonCode[] = [];

  if (ranked.length > 1) codes.push("LOWER_EFFECTIVE_COST"); // §9.9: recommended is the min by construction
  if (
    recommended.metrics.priceTenthsCpl === Math.min(...ranked.map((r) => r.metrics.priceTenthsCpl))
  ) {
    codes.push("LOWEST_UNIT_PRICE");
  }
  codes.push("WITHIN_MAX_DETOUR"); // true for every eligible candidate, always
  if (
    recommended.metrics.additionalRoundTripKm ===
    Math.min(...ranked.map((r) => r.metrics.additionalRoundTripKm))
  ) {
    codes.push("SHORTEST_DETOUR");
  }

  const band = priceAgeBand(recommended.metrics.sourceReportedAt, now);
  if (band === "current") codes.push("FRESH_PRICE");
  if (band === "ageing") codes.push("PRICE_UNCHANGED_RECENTLY");

  if (localArea.localAverageTenths !== null) {
    if (recommended.metrics.priceTenthsCpl < localArea.localAverageTenths)
      codes.push("BELOW_LOCAL_AVERAGE");
    else if (recommended.metrics.priceTenthsCpl > localArea.localAverageTenths)
      codes.push("ABOVE_LOCAL_AVERAGE");
  }

  if (recommended.station.stationId === nearestEligible.station.stationId) {
    codes.push("ALREADY_NEAREST_AND_CHEAPEST");
  }

  // A cheaper-per-litre candidate existed but wasn't recommended — its detour cost outweighed
  // the saving, which is exactly what minimising effectiveCost (not unit price) is for.
  const cheaperUnitPriceExists = ranked.some(
    (r) => r.metrics.priceTenthsCpl < recommended.metrics.priceTenthsCpl,
  );
  if (cheaperUnitPriceExists) codes.push("DETOUR_NOT_WORTH_SAVING");

  if (confidence === "low" && localArea.historyDays < 7) codes.push("LIMITED_HISTORY");
  if (ranked.length < 2) codes.push("SPARSE_CANDIDATES");
  if (mode === "comparison") codes.push("COMPARISON_VOLUME_ASSUMED");
  if (consumptionWasDefaulted) codes.push("CONSUMPTION_DEFAULT_ASSUMED");

  return codes;
}

export function rankCandidates(
  input: RankCandidatesInput,
): Result<RecommendationResult, RankCandidatesError> {
  const eligibilityMaxAgeDays = input.eligibilityMaxAgeDays ?? DEFAULT_ELIGIBILITY_MAX_AGE_DAYS;
  const detourKm = input.detourKm ?? originRadialDetourKm;

  // §9.4.4: mode is decided purely by whether litresRequired can produce a concrete figure —
  // "no profile" and "profile present but incomplete" both correctly collapse to comparison
  // mode this way, without duplicating litresRequired's own null-checks here.
  const litresOutcome = input.vehicleProfile
    ? litresRequired(
        input.vehicleProfile.tankCapacityLitres,
        input.vehicleProfile.currentFuelFraction,
      )
    : LITRES_UNKNOWN;
  const mode: Mode = isLitresKnown(litresOutcome) ? "personalised" : "comparison";
  const litres = isLitresKnown(litresOutcome) ? litresOutcome : COMPARISON_REFERENCE_VOLUME_LITRES;

  const suppliedConsumption = input.vehicleProfile?.consumptionLPer100km ?? null;
  const consumptionWasDefaulted = suppliedConsumption === null;
  const consumptionLPer100km = suppliedConsumption ?? DEFAULT_CONSUMPTION_L_PER_100KM;

  const eligible = input.candidates.filter((c) =>
    isEligible(c, input.origin, input.maxDetourKm, detourKm, eligibilityMaxAgeDays, input.now),
  );

  if (eligible.length === 0) {
    return err({ type: "no_eligible_candidates" });
  }

  const computed: ComputedCandidate[] = eligible.map((station) => ({
    station,
    metrics: computeMetrics(station, input.origin, litres, consumptionLPer100km, detourKm),
  }));

  const ranked = [...computed].sort((a, b) =>
    compareCandidates(a, b, input.now, input.preferredBrand),
  );
  const recommended = ranked[0];
  // Nearest eligible station is a *different* selection than the ranking winner (§9.4.3) —
  // literally the closest by distance among the eligible set, whatever its price.
  const nearestEligible = computed.reduce((nearest, c) =>
    c.metrics.distanceKm < nearest.metrics.distanceKm ? c : nearest,
  );

  const confidence = computeConfidence({
    historyDays: input.localArea.historyDays,
    candidateCount: computed.length,
    priceAgeHours:
      (input.now.getTime() - recommended.metrics.sourceReportedAt.getTime()) / (60 * 60 * 1000),
    mode,
  });

  const rankPercentileValue =
    input.localArea.windowPricesTenths.length > 0
      ? input.localArea.windowPricesTenths.filter((p) => p <= recommended.metrics.priceTenthsCpl)
          .length / input.localArea.windowPricesTenths.length
      : null;

  const trendResult = trend(input.localArea.closesTenthsInDayOrder);

  const reasonCodes = buildReasonCodes({
    recommended,
    ranked,
    nearestEligible,
    localArea: input.localArea,
    confidence,
    mode,
    consumptionWasDefaulted,
    now: input.now,
  });

  const base: RecommendationBase = {
    engineVersion: ENGINE_VERSION,
    recommended: toRankedCandidate(recommended),
    ranked: ranked.map(toRankedCandidate),
    reasonCodes,
    estimatedSavingCents: estimatedSavingCents(
      recommended.metrics.effectiveCostCents,
      nearestEligible.metrics.effectiveCostCents,
    ),
    confidence,
    rankPercentile: rankPercentileValue,
    trendDirection: trendResult.direction,
  };

  if (mode === "personalised") {
    return ok({ ...base, mode: "personalised", litresRequiredLitres: litres });
  }
  return ok({
    ...base,
    mode: "comparison",
    referenceVolumeLitres: COMPARISON_REFERENCE_VOLUME_LITRES,
  });
}

function toRankedCandidate(c: ComputedCandidate): RankedCandidate {
  return { stationId: c.station.stationId, brand: c.station.brand, metrics: c.metrics };
}
