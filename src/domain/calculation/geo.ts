/**
 * `09_CALCULATION_ENGINE.md` §9.3 / `06_DATA_ARCHITECTURE.md` §6.5. Pure geometry — no I/O, no
 * clock, no randomness. The bounding-box + haversine strategy itself (rather than PostGIS) is
 * §6.5's decision; this module is just the two formulas that decision needs. The actual SQL
 * query using `boundingBox` as a prefilter lives in the repository layer (a separate branch —
 * this is the pure math only).
 */
import type { BoundingBox, LatLng } from "./types";

const EARTH_RADIUS_KM = 6371; // mean radius — consistent with the box's degree-per-km approximation below

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance. Straight-line, not road distance — `09` §9.3 is explicit about this;
 * detour estimates elsewhere in this module are a deliberate approximation on top of it. */
export function haversineDistanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * §9.4.2's Gap 1 fix: a detour is travelled twice, out and back. `distanceKm` here is the
 * one-way distance the trip actually adds — for nearby-search mode (UC-01, no route to compare
 * against) that's `haversineDistanceKm(origin, station)` itself, per the proposed
 * `2 × distanceFromOrigin` reading. Named `additionalRoundTripKm` rather than a bare "detour"
 * so the round-trip convention travels with the value, matching §9.4.2's
 * `additional_round_trip_km` field name.
 */
export function additionalRoundTripKm(distanceKm: number): number {
  return 2 * distanceKm;
}

/** Degrees of latitude per kilometre is effectively constant; degrees of longitude per
 * kilometre shrinks toward the poles by a factor of `cos(latitude)` — omitting this correction
 * is `06` §6.5's "common bug": the box ends up too narrow in longitude and stations are
 * silently missed. Clamped away from exactly 0 (the poles) so this returns a valid, if
 * enormous, box rather than `Infinity`/`NaN` — real NSW/TAS search centres are nowhere near a
 * pole, but a pure function should still return a defined answer for one (§9.10's boundary
 * test), not blow up. */
const KM_PER_DEGREE_LATITUDE = 111.32; // ~ Earth's circumference / 360
const MIN_COS_LATITUDE = 1e-6;

export function boundingBox(centre: LatLng, radiusKm: number): BoundingBox {
  const latDeltaDeg = radiusKm / KM_PER_DEGREE_LATITUDE;

  const cosLat = Math.max(Math.cos(toRadians(centre.latitude)), MIN_COS_LATITUDE);
  const lngDeltaDeg = radiusKm / (KM_PER_DEGREE_LATITUDE * cosLat);

  return {
    minLat: centre.latitude - latDeltaDeg,
    maxLat: centre.latitude + latDeltaDeg,
    minLng: centre.longitude - lngDeltaDeg,
    maxLng: centre.longitude + lngDeltaDeg,
  };
}
