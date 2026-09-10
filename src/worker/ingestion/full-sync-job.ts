import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { ok, type Result } from "../../domain/result";
import type { FuelDataSource } from "../../infrastructure/fuel-api";
import type { FuelApiError } from "../../infrastructure/fuel-api/types";
import {
  recordFullSyncStationPresence,
  type StationGraduationResult,
} from "../../infrastructure/repositories/station-repository";
import { persistObservations, type PersistObservationsResult } from "./persist-observations";

type Db = Pick<PostgresJsDatabase, "select" | "insert" | "update">;

export interface FullSyncJobResult extends PersistObservationsResult {
  stationGraduation: StationGraduationResult;
}

/**
 * `full_sync` — the recovery mechanism (§8.5), not a nicety. Same gate → hash → insert pipeline
 * as `new_prices`, plus the one thing only a *full* snapshot can drive: station-presence
 * graduation (§8.6) — was every currently-known station actually present in this run's data?
 *
 * `insertedCount` here doubles as §8.5's self-audit metric: "a persistently high insert rate on
 * full sync means new_prices is losing windows... the only signal that data is being lost,
 * since a lost window produces no error anywhere." Not computed separately — it's the same
 * number `persistObservations` already returns, just read with that meaning in mind by whoever
 * is watching it (§8.11's `ingestion.full_sync.unexpected_inserts` alarm).
 */
export async function runFullSyncJob(
  db: Db,
  fuelDataSource: Pick<FuelDataSource, "fetchAllPrices">,
  now: Date,
): Promise<Result<FullSyncJobResult, FuelApiError>> {
  const fetched = await fuelDataSource.fetchAllPrices(now);
  if (!fetched.ok) return fetched;

  const persisted = await persistObservations(
    db,
    fetched.value.data,
    fetched.value.ingestionRunId,
    now,
  );
  const stationGraduation = await recordFullSyncStationPresence(db, persisted.observedStationCodes);

  return ok({ ...persisted, stationGraduation });
}
