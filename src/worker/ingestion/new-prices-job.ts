import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { ok, type Result } from "../../domain/result";
import type { FuelDataSource } from "../../infrastructure/fuel-api";
import type { FuelApiError } from "../../infrastructure/fuel-api/types";
import { persistObservations, type PersistObservationsResult } from "./persist-observations";

type Db = Pick<PostgresJsDatabase, "select" | "insert" | "update">;

/**
 * `new_prices` — hourly, the primary cycle. Deliberately does NOT do `full_sync`'s
 * station-presence graduation (§8.6): this is an incremental delta, not a full snapshot, so
 * treating "not in this batch" as "missing" would wrongly flag nearly every station on every
 * single run. Presence-based absence tracking is `full_sync`'s job specifically, because only a
 * full snapshot can tell the difference between "didn't change this hour" and "actually gone."
 */
export async function runNewPricesJob(
  db: Db,
  fuelDataSource: Pick<FuelDataSource, "fetchNewPrices">,
  now: Date,
): Promise<Result<PersistObservationsResult, FuelApiError>> {
  const fetched = await fuelDataSource.fetchNewPrices(now);
  if (!fetched.ok) return fetched;

  const result = await persistObservations(
    db,
    fetched.value.data,
    fetched.value.ingestionRunId,
    now,
  );
  return ok(result);
}
