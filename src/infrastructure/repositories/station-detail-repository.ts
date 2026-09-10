import { desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { LatLng } from "../../domain/calculation/types";
import { fuelPriceObservation, station } from "../db/schema";

type ReadDb = Pick<PostgresJsDatabase, "select" | "selectDistinctOn">;

export interface StationDetail {
  id: string;
  name: string;
  brand: string | null;
  addressLine: string | null;
  suburb: string | null;
  postcode: string | null;
  state: string | null;
  location: LatLng;
  lifecycleState: "active" | "suspect" | "inactive";
}

/** `GET /api/v1/stations/{stationId}` (§21.1, UC-05). `undefined` for a genuinely nonexistent
 * id — the caller's job to turn that into a 404, not this repository's. Doesn't filter on
 * `lifecycleState`: an `inactive` station is still a real station a stale link/bookmark might
 * point at, and showing it (last-known details, presumably stale prices) is more honest than a
 * 404 that reads as "never existed." */
export async function loadStationById(
  db: Pick<PostgresJsDatabase, "select">,
  stationId: string,
): Promise<StationDetail | undefined> {
  const [row] = await db
    .select({
      id: station.id,
      name: station.name,
      brand: station.brand,
      addressLine: station.addressLine,
      suburb: station.suburb,
      postcode: station.postcode,
      state: station.state,
      latitude: station.latitude,
      longitude: station.longitude,
      lifecycleState: station.lifecycleState,
    })
    .from(station)
    .where(eq(station.id, stationId));

  if (!row) return undefined;

  // `numeric` columns come back as strings (drizzle's default) — see
  // `station-search-repository.ts`'s identical conversion note.
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    addressLine: row.addressLine,
    suburb: row.suburb,
    postcode: row.postcode,
    state: row.state,
    location: { latitude: Number(row.latitude), longitude: Number(row.longitude) },
    lifecycleState: row.lifecycleState,
  };
}

export interface CurrentPrice {
  priceTenthsCpl: number;
  sourceReportedAt: Date;
}

/**
 * The latest observation per fuel type this station currently has a price for, keyed by
 * `fuelTypeId` — reused by both the station-detail endpoint (every fuel type at once) and the
 * history endpoint (`current`, picking the one entry for its requested fuel type), the same
 * `DISTINCT ON (station_id, fuel_type_id) ORDER BY source_reported_at DESC` shape
 * `station-search-repository.ts` and `rollup-repository.ts` already establish for this exact
 * query pattern. A fuel type absent from the map means this station has never reported a price
 * for it — not an error, just nothing to show.
 */
export async function loadCurrentPricesForStation(
  db: ReadDb,
  stationId: string,
): Promise<Map<string, CurrentPrice>> {
  const rows = await db
    .selectDistinctOn([fuelPriceObservation.fuelTypeId], {
      fuelTypeId: fuelPriceObservation.fuelTypeId,
      priceTenthsCpl: fuelPriceObservation.priceTenthsCpl,
      sourceReportedAt: fuelPriceObservation.sourceReportedAt,
    })
    .from(fuelPriceObservation)
    .where(eq(fuelPriceObservation.stationId, stationId))
    .orderBy(fuelPriceObservation.fuelTypeId, desc(fuelPriceObservation.sourceReportedAt));

  return new Map(
    rows.map((r) => [
      r.fuelTypeId,
      { priceTenthsCpl: r.priceTenthsCpl, sourceReportedAt: r.sourceReportedAt },
    ]),
  );
}
