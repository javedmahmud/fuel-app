/**
 * `src/application/README.md`: "Use-case services — orchestration only... calls down into the
 * domain layer for calculations and into infrastructure for data — holds no business rules of
 * its own." UC-02's `CommuteService` (`05_CONTEXT_AND_CONTAINERS.md` §5.3), the narrow route
 * experiment (`20_SPRINT_PLAN.md` §20.8, ADR-011) — wires `rank-candidates.ts`'s pure engine to
 * real corridor candidate data, using `feature/commute-geometry`'s `corridorDetourKm` as the
 * `DetourKmStrategy` instead of nearby-search's origin-radial default.
 *
 * Deliberately shaped as a near-mirror of `search-service.ts`'s `runSearch` rather than sharing
 * code with it: the two differ in exactly one place (which candidates are fetched, and which
 * detour strategy ranks them) but that's already the seam `rank-candidates.ts` exposes — forcing
 * a shared "generic search" abstraction over these two thin orchestration functions would hide
 * that difference behind an abstraction rather than naming it, for no real duplication saved.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { corridorDetourKm } from "../domain/calculation/geo";
import {
  rankCandidates,
  type CandidateStation,
  type RankCandidatesError,
  type RecommendationResult,
  type VehicleProfileInput,
} from "../domain/calculation/rank-candidates";
import type { LatLng } from "../domain/calculation/types";
import { err, ok, type Result } from "../domain/result";
import { loadActiveFuelTypeCodeToId } from "../infrastructure/repositories/fuel-type-repository";
import { loadLocalAreaContext } from "../infrastructure/repositories/local-area-repository";
import { persistRecommendation } from "../infrastructure/repositories/recommendation-repository";
import { findCorridorCandidates } from "../infrastructure/repositories/station-search-repository";

type Db = Pick<PostgresJsDatabase, "select" | "selectDistinctOn" | "insert">;

/** Same window `search-service.ts` uses (§10.7's own "30-day average" example) — no UC-02-
 * specific reason to differ. */
const LOCAL_AREA_WINDOW_DAYS = 30;

export interface CommuteInput {
  origin: LatLng;
  destination: LatLng;
  /** The eligibility cap `rankCandidates` compares `corridorDetourKm` against — how much extra
   * distance, beyond the direct origin→destination trip, the driver is willing to accept for a
   * cheaper station. Unlike `SearchInput.maxDetourKm`, not derived from a separate "radius"
   * concept — UC-02's own product definition has the user enter this directly ("User enters
   * origin, destination, fuel type and max detour"). */
  maxDetourKm: number;
  fuelTypeCode: string;
  vehicleProfile: VehicleProfileInput | null;
  preferredBrand?: string;
  now: Date;
  userId?: string;
  sessionHash?: string;
}

export type CommuteError = { type: "unknown_fuel_type" } | RankCandidatesError;

export interface CommuteOutcome {
  result: RecommendationResult;
  recommendationLogId: string;
}

export async function runCommute(
  db: Db,
  input: CommuteInput,
): Promise<Result<CommuteOutcome, CommuteError>> {
  const fuelTypeCodeToId = await loadActiveFuelTypeCodeToId(db);
  const fuelTypeId = fuelTypeCodeToId.get(input.fuelTypeCode);
  if (!fuelTypeId) {
    return err({ type: "unknown_fuel_type" });
  }

  // The DB prefilter's corridor width is deliberately just `maxDetourKm` itself — a station
  // whose real, precise detour ends up within the driver's cap cannot be meaningfully farther
  // off the direct line than that same cap in km, so this can only ever over-fetch (safe, just
  // extra rows scanned before the exact `rankCandidates` gate below runs), never under-fetch and
  // silently drop a truly-eligible station. See `corridorBoundingBox`'s own comment for the same
  // "generous superset, exact trim later" reasoning applied one layer up.
  const corridor = await findCorridorCandidates(
    db,
    input.origin,
    input.destination,
    input.maxDetourKm,
    fuelTypeId,
  );

  const candidates: CandidateStation[] = corridor.map((c) => ({
    stationId: c.stationId,
    brand: c.brand,
    location: c.location,
    lifecycleState: c.lifecycleState,
    price: c.price,
  }));

  const localArea = await loadLocalAreaContext(
    db,
    corridor.map((c) => c.stationId),
    fuelTypeId,
    LOCAL_AREA_WINDOW_DAYS,
    input.now,
  );

  const rankResult = rankCandidates({
    candidates,
    origin: input.origin,
    maxDetourKm: input.maxDetourKm,
    vehicleProfile: input.vehicleProfile,
    localArea,
    preferredBrand: input.preferredBrand,
    now: input.now,
    // The one line that actually makes this UC-02 rather than UC-01: every other input above
    // mirrors runSearch exactly. `feature/commute-geometry`'s seam, exercised for real.
    detourKm: (origin, candidateLocation) =>
      corridorDetourKm(origin, candidateLocation, input.destination),
  });
  if (!rankResult.ok) return rankResult;

  const { id } = await persistRecommendation(db, {
    result: rankResult.value,
    calculationInputs: {
      origin: input.origin,
      destination: input.destination,
      maxDetourKm: input.maxDetourKm,
      fuelTypeCode: input.fuelTypeCode,
      vehicleProfile: input.vehicleProfile,
      preferredBrand: input.preferredBrand,
      now: input.now.toISOString(),
    },
    userId: input.userId,
    sessionHash: input.sessionHash,
  });

  return ok({ result: rankResult.value, recommendationLogId: id });
}
