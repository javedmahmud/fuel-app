/**
 * `src/application/README.md`: "Use-case services — orchestration only... calls down into the
 * domain layer for calculations and into infrastructure for data — holds no business rules of
 * its own." This is UC-01's "nearby search" — wires `rank-candidates.ts`'s pure engine to real
 * station/observation/rollup data and persists the result. Not pure itself (real DB access,
 * real `now`), unlike everything it calls into the domain layer for.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

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
import { findNearbyCandidates } from "../infrastructure/repositories/station-search-repository";

type Db = Pick<PostgresJsDatabase, "select" | "selectDistinctOn" | "insert">;

/** Days of `daily_price_rollup` history the local-area context draws on — §10.7's own examples
 * default to a 30-day window ("30-day average"), reused here as this service's default. */
const LOCAL_AREA_WINDOW_DAYS = 30;

export interface SearchInput {
  origin: LatLng;
  /** Round-trip cap — the same convention `rank-candidates.ts`'s `maxDetourKm` already uses
   * (§9.4.2). For UC-01 nearby-search mode there's no separate "route," so this is simply how
   * far round-trip the user is willing to go; the DB search radius is derived from it, not a
   * second independent input. */
  maxDetourKm: number;
  fuelTypeCode: string;
  vehicleProfile: VehicleProfileInput | null;
  preferredBrand?: string;
  now: Date;
  userId?: string;
  sessionHash?: string;
}

export type SearchError = { type: "unknown_fuel_type" } | RankCandidatesError;

export interface SearchOutcome {
  result: RecommendationResult;
  recommendationLogId: string;
}

export async function runSearch(
  db: Db,
  input: SearchInput,
): Promise<Result<SearchOutcome, SearchError>> {
  const fuelTypeCodeToId = await loadActiveFuelTypeCodeToId(db);
  const fuelTypeId = fuelTypeCodeToId.get(input.fuelTypeCode);
  if (!fuelTypeId) {
    return err({ type: "unknown_fuel_type" });
  }

  // One-way DB search radius derived from the round-trip cap — fetching stations no round trip
  // to could ever pass anyway would be pure waste (and the true eligibility gate, using the
  // exact same round-trip math, still runs inside rankCandidates below regardless).
  const searchRadiusKm = input.maxDetourKm / 2;

  const nearby = await findNearbyCandidates(db, input.origin, searchRadiusKm, fuelTypeId);

  const candidates: CandidateStation[] = nearby.map((c) => ({
    stationId: c.stationId,
    brand: c.brand,
    location: c.location,
    lifecycleState: c.lifecycleState,
    price: c.price,
  }));

  const localArea = await loadLocalAreaContext(
    db,
    nearby.map((c) => c.stationId),
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
  });
  if (!rankResult.ok) return rankResult;

  const { id } = await persistRecommendation(db, {
    result: rankResult.value,
    calculationInputs: {
      origin: input.origin,
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
