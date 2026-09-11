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

/**
 * UC-02 (Commute Mode, `20_SPRINT_PLAN.md` §20.8) geometry — ADR-011's "polyline corridor and
 * straight-line detour, no routing vendor." `segStart`/`segEnd` are the commute's origin and
 * destination; the result is the perpendicular distance from `point` to that straight-line
 * segment, **clamped to the segment's endpoints** (not the infinite line through them) — a
 * station well past the destination is measured to the destination, not treated as if the route
 * continued forever past it.
 *
 * Approximated via the same local flat-plane projection `boundingBox` already uses (degrees
 * scaled to km, longitude corrected by `cos(latitude)`) rather than exact great-circle segment
 * geometry — appropriate for a narrow, trip-scale corridor buffer (tens of km, not thousands),
 * and consistent with this module's existing approximation choices rather than introducing a
 * second, more precise but inconsistent method.
 */
export function distanceToSegmentKm(point: LatLng, segStart: LatLng, segEnd: LatLng): number {
  const cosLat = Math.max(Math.cos(toRadians(segStart.latitude)), MIN_COS_LATITUDE);
  const toPlaneKm = (p: LatLng) => ({
    x: (p.longitude - segStart.longitude) * KM_PER_DEGREE_LATITUDE * cosLat,
    y: (p.latitude - segStart.latitude) * KM_PER_DEGREE_LATITUDE,
  });

  const p = toPlaneKm(point);
  const b = toPlaneKm(segEnd); // segStart itself is the plane's origin, (0, 0), by construction

  const lengthSq = b.x * b.x + b.y * b.y;
  // Degenerate segment — origin and destination are the same point. Distance to that point.
  if (lengthSq === 0) return Math.hypot(p.x, p.y);

  // Project point onto the line, then clamp t to [0, 1] to stay within the segment.
  const t = Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / lengthSq));
  return Math.hypot(p.x - t * b.x, p.y - t * b.y);
}

/** Whether `point` falls within `corridorWidthKm` of the straight line from `origin` to
 * `destination` — the candidate-selection test for UC-02's corridor search (`20` §20.8). */
export function isWithinCorridor(
  point: LatLng,
  origin: LatLng,
  destination: LatLng,
  corridorWidthKm: number,
): boolean {
  return distanceToSegmentKm(point, origin, destination) <= corridorWidthKm;
}

/**
 * UC-02's actual detour (`21_DETAILED_DESIGN.md` §21.1: "`additionalRoundTripKm` computed from
 * actual detour distance rather than `2 × distanceFromOrigin`"): how much farther the trip
 * `origin → destination` becomes by routing via `waypoint` first, versus going straight there.
 *
 * Deliberately **not** doubled like `additionalRoundTripKm` above — that function's ×2 models a
 * separate round trip made *just* for fuel (drive from home to the station and back home again).
 * A commute is already being driven one-way from origin to destination; visiting a station near
 * that route adds exactly this much extra distance to the trip already underway, not a second
 * trip. The two functions compute genuinely different things but feed the same downstream
 * `additionalRoundTripKm` metrics field (§21.1) — see `rank-candidates.ts`'s `DetourKmStrategy`.
 *
 * Clamped to zero: for a waypoint essentially on the direct line, the three-haversine-call
 * subtraction can land fractionally negative from float/approximation noise, and a detour can
 * never make a trip shorter.
 */
export function corridorDetourKm(origin: LatLng, waypoint: LatLng, destination: LatLng): number {
  const viaWaypoint =
    haversineDistanceKm(origin, waypoint) + haversineDistanceKm(waypoint, destination);
  const direct = haversineDistanceKm(origin, destination);
  return Math.max(0, viaWaypoint - direct);
}
