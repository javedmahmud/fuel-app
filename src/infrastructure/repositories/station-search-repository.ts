import { and, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { haversineDistanceKm, boundingBox } from "../../domain/calculation/geo";
import type { LatLng } from "../../domain/calculation/types";
import { fuelPriceObservation, station } from "../db/schema";

type ReadDb = Pick<PostgresJsDatabase, "select" | "selectDistinctOn">;

export interface NearbyCandidate {
  stationId: string;
  brand: string | null;
  location: LatLng;
  lifecycleState: "active" | "suspect" | "inactive";
  distanceKm: number;
  price: { priceTenthsCpl: number; sourceReportedAt: Date };
}

/**
 * `06_DATA_ARCHITECTURE.md` §6.5's chosen strategy: a bounding-box prefilter (plain B-tree index
 * on `(latitude, longitude)`, `station_lat_lng_active_idx`) reduces the whole table to a handful
 * of rows, then exact `haversineDistanceKm` trims that box (a superset of the true circle) down
 * to the real radius. `boundingBox` itself already applies the `cos(latitude)` correction
 * (`domain/calculation/geo.ts`) — the "common bug" §6.5 warns about is a box built without it,
 * which silently misses real stations at higher latitude; this function inherits the fix simply
 * by using that pure function rather than reimplementing box math here.
 *
 * The "latest price per station" join reuses the same `DISTINCT ON` shape
 * `rollup-repository.ts`'s `loadOpeningPrices` already established against the very index
 * `fuel-price-observation.ts`'s own schema comment calls out for exactly this: "nearly every
 * user-facing query reduces to... DISTINCT ON (station_id, fuel_type_id) ORDER BY
 * source_reported_at DESC" — this is that query's first real, user-facing consumer. Scoped to
 * only the in-box candidate station ids first, so this second query stays cheap regardless of
 * how large `fuel_price_observation` grows.
 *
 * Stations with no observation at all for the requested fuel type are simply absent from the
 * result — "doesn't sell this fuel type" is `rank-candidates.ts`'s own eligibility gate
 * (`CandidateStation.price` being `undefined`), so there is no reason to carry a priceless row
 * out of the database at all.
 */
export async function findNearbyCandidates(
  db: ReadDb,
  centre: LatLng,
  radiusKm: number,
  fuelTypeId: string,
): Promise<NearbyCandidate[]> {
  const box = boundingBox(centre, radiusKm);

  const stationsInBox = await db
    .select({
      id: station.id,
      brand: station.brand,
      latitude: station.latitude,
      longitude: station.longitude,
      lifecycleState: station.lifecycleState,
    })
    .from(station)
    .where(
      and(
        eq(station.source, "NSW_FUEL_API"),
        ne(station.lifecycleState, "inactive"),
        gte(station.latitude, String(box.minLat)),
        lte(station.latitude, String(box.maxLat)),
        gte(station.longitude, String(box.minLng)),
        lte(station.longitude, String(box.maxLng)),
      ),
    );

  if (stationsInBox.length === 0) return [];

  const stationIds = stationsInBox.map((s) => s.id);
  const latestPrices = await db
    .selectDistinctOn([fuelPriceObservation.stationId], {
      stationId: fuelPriceObservation.stationId,
      priceTenthsCpl: fuelPriceObservation.priceTenthsCpl,
      sourceReportedAt: fuelPriceObservation.sourceReportedAt,
    })
    .from(fuelPriceObservation)
    .where(
      and(
        inArray(fuelPriceObservation.stationId, stationIds),
        eq(fuelPriceObservation.fuelTypeId, fuelTypeId),
      ),
    )
    .orderBy(fuelPriceObservation.stationId, desc(fuelPriceObservation.sourceReportedAt));

  const priceByStationId = new Map(latestPrices.map((p) => [p.stationId, p]));

  const candidates: NearbyCandidate[] = [];
  for (const s of stationsInBox) {
    const price = priceByStationId.get(s.id);
    if (!price) continue;

    // `numeric` columns come back as strings (drizzle's default, to avoid float precision
    // loss on arbitrary-precision decimals) — converted to numbers here, the one place this
    // module crosses from storage representation into the pure geo functions' number-based API.
    const location: LatLng = { latitude: Number(s.latitude), longitude: Number(s.longitude) };
    const distanceKm = haversineDistanceKm(centre, location);
    if (distanceKm > radiusKm) continue; // the box is a superset of the true circle — trim it

    candidates.push({
      stationId: s.id,
      brand: s.brand,
      location,
      lifecycleState: s.lifecycleState,
      distanceKm,
      price: { priceTenthsCpl: price.priceTenthsCpl, sourceReportedAt: price.sourceReportedAt },
    });
  }

  return candidates;
}
