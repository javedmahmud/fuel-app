import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { err, ok, type Result } from "../../domain/result";
import type { FuelDataSource } from "../../infrastructure/fuel-api";
import type { FuelApiError } from "../../infrastructure/fuel-api/types";
import { upsertFuelTypesFromReferenceData } from "../../infrastructure/repositories/fuel-type-repository";
import { upsertStationsFromReferenceData } from "../../infrastructure/repositories/station-repository";

type Db = Pick<PostgresJsDatabase, "select" | "insert" | "update">;

export interface RefDataJobResult {
  stationsUpserted: number;
  stationsDeactivated: number;
  fuelTypesUpserted: number;
  fuelTypesDeactivated: number;
}

/**
 * `ref_data` — weekly. First in the bootstrap order (`08_INGESTION_ARCHITECTURE.md` §8.8):
 * "nothing can be normalised without it." Fetches via the adapter, then upserts stations and
 * fuel types as the two reference tables everything else's quality gates check against.
 */
export async function runRefDataJob(
  db: Db,
  fuelDataSource: Pick<FuelDataSource, "fetchReferenceData">,
  now: Date,
): Promise<Result<RefDataJobResult, FuelApiError>> {
  const fetched = await fuelDataSource.fetchReferenceData(now);
  if (!fetched.ok) return fetched;

  const stationResult = await upsertStationsFromReferenceData(db, fetched.value.data.stations, now);
  const fuelTypeResult = await upsertFuelTypesFromReferenceData(db, fetched.value.data.fuelTypes);

  if (stationResult.upserted === 0 && fetched.value.data.stations.length > 0) {
    // upsertStationsFromReferenceData only returns 0 upserted for an empty input array — seeing
    // it here with non-empty input would mean every single insert silently failed, which
    // shouldn't be possible given the function's own guard clause. Defensive check, not an
    // expected path; surfaced as malformed_response rather than silently reporting success.
    return err({
      type: "malformed_response",
      message: "Station upsert reported zero writes for a non-empty fetch",
    });
  }

  return ok({
    stationsUpserted: stationResult.upserted,
    stationsDeactivated: stationResult.deactivated,
    fuelTypesUpserted: fuelTypeResult.upserted,
    fuelTypesDeactivated: fuelTypeResult.deactivated,
  });
}
