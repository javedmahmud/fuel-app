import { and, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  boundingBox,
  corridorBoundingBox,
  distanceToSegmentKm,
  haversineDistanceKm,
} from "../../domain/calculation/geo";
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

export interface CorridorCandidate {
  stationId: string;
  brand: string | null;
  location: LatLng;
  lifecycleState: "active" | "suspect" | "inactive";
  /** Perpendicular distance to the origin→destination line (`distanceToSegmentKm`) — genuinely
   * not the same thing as `NearbyCandidate.distanceKm` above (distance from a single search
   * point), so it gets its own, honestly-named field rather than reusing that one under a
   * misleading name. Not consumed by `rankCandidates` (which only ever asks for
   * `corridorDetourKm`, the real detour, via `feature/commute-geometry`'s `DetourKmStrategy`
   * seam) — carried here only in case a future caller wants "how far off-route" for display. */
  distanceToRouteKm: number;
  price: { priceTenthsCpl: number; sourceReportedAt: Date };
}

/**
 * `20_SPRINT_PLAN.md` §20.8 / ADR-011's corridor candidate search — the commute-mode counterpart
 * to `findNearbyCandidates` above, same two-stage shape: a cheap bounding-box prefilter
 * (`corridorBoundingBox`, this query's index-backed `WHERE`), then an exact trim in application
 * code using real `distanceToSegmentKm` math (computed once per row and reused as both the trim
 * test and the returned `distanceToRouteKm`, rather than calling the `isWithinCorridor` wrapper
 * and recomputing the same distance a second time) — the box is a generous superset of the true
 * corridor, never a tighter, wrong one; see `corridorBoundingBox`'s own comment for why that's the
 * correct trade-off for an index-backed prefilter. The "latest price per station" join is the
 * identical `DISTINCT ON` shape `findNearbyCandidates` already uses, reused verbatim rather than
 * duplicated with a different variable name.
 */
export async function findCorridorCandidates(
  db: ReadDb,
  origin: LatLng,
  destination: LatLng,
  corridorWidthKm: number,
  fuelTypeId: string,
): Promise<CorridorCandidate[]> {
  const box = corridorBoundingBox(origin, destination, corridorWidthKm);

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

  const candidates: CorridorCandidate[] = [];
  for (const s of stationsInBox) {
    const price = priceByStationId.get(s.id);
    if (!price) continue;

    const location: LatLng = { latitude: Number(s.latitude), longitude: Number(s.longitude) };
    const distanceToRouteKm = distanceToSegmentKm(location, origin, destination);
    if (distanceToRouteKm > corridorWidthKm) continue; // the box is a superset of the true corridor — trim it

    candidates.push({
      stationId: s.id,
      brand: s.brand,
      location,
      lifecycleState: s.lifecycleState,
      distanceToRouteKm,
      price: { priceTenthsCpl: price.priceTenthsCpl, sourceReportedAt: price.sourceReportedAt },
    });
  }

  return candidates;
}

export interface StationDisplayInfo {
  name: string;
  addressLine: string | null;
  suburb: string | null;
}

/**
 * Name/address for display only — deliberately not part of `NearbyCandidate` or anything that
 * flows into `rank-candidates.ts`. The calc engine's `CandidateStation`/`RankedCandidate` types
 * carry only what the ranking math needs (§9.1 — plain data in, plain data out, nothing extra);
 * bolting display fields onto them would blur that boundary for every future caller, not just
 * this one debug page. Called separately, after ranking, only for the station ids actually
 * being shown to a human.
 */
export async function loadStationDisplayInfo(
  db: Pick<PostgresJsDatabase, "select">,
  stationIds: readonly string[],
): Promise<Map<string, StationDisplayInfo>> {
  if (stationIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: station.id,
      name: station.name,
      addressLine: station.addressLine,
      suburb: station.suburb,
    })
    .from(station)
    .where(inArray(station.id, [...stationIds]));

  return new Map(
    rows.map((r) => [r.id, { name: r.name, addressLine: r.addressLine, suburb: r.suburb }]),
  );
}
