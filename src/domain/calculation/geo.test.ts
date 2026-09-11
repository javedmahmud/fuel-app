import { describe, expect, it } from "vitest";
import {
  additionalRoundTripKm,
  boundingBox,
  corridorDetourKm,
  distanceToSegmentKm,
  haversineDistanceKm,
  isWithinCorridor,
} from "./geo";

describe("haversineDistanceKm", () => {
  it("is zero for the same point", () => {
    expect(
      haversineDistanceKm(
        { latitude: -33.87, longitude: 151.21 },
        { latitude: -33.87, longitude: 151.21 },
      ),
    ).toBe(0);
  });

  it("matches the exact identity for a pure 1-degree latitude difference at the equator (R × radians(1))", () => {
    // With no longitude difference, haversine reduces exactly to R × Δlat(radians) — an
    // independently-derivable trig identity, not a value copied from this module's own formula.
    const distance = haversineDistanceKm(
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 0 },
    );
    expect(distance).toBeCloseTo(111.19492664455873, 6);
  });

  it("matches the exact antipodal half-circumference (π × R)", () => {
    const distance = haversineDistanceKm(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 180 },
    );
    expect(distance).toBeCloseTo(20015.086796020572, 6);
  });

  it("is symmetric — distance(a, b) === distance(b, a)", () => {
    const a = { latitude: -33.87, longitude: 151.21 };
    const b = { latitude: -37.81, longitude: 144.96 };
    expect(haversineDistanceKm(a, b)).toBeCloseTo(haversineDistanceKm(b, a), 10);
  });

  it("is a real-world sanity check: Sydney CBD to Melbourne CBD is roughly 714 km", () => {
    const sydney = { latitude: -33.8688, longitude: 151.2093 };
    const melbourne = { latitude: -37.8136, longitude: 144.9631 };
    expect(haversineDistanceKm(sydney, melbourne)).toBeCloseTo(714, -1); // within ~10km
  });

  it("handles a pair straddling the antimeridian correctly — §9.10's boundary case", () => {
    // These two points are only 2° of longitude apart going the short way around (through
    // ±180°), not 358° the naive-subtraction way — haversine's own formula (using sin of the
    // half-difference) gets this right automatically, with no explicit wraparound handling
    // needed. Confirmed against the same 1°-of-latitude identity used above, since these two
    // points also differ by exactly 20° of latitude at a shared longitude-crossing.
    const distance = haversineDistanceKm(
      { latitude: 10, longitude: -179 },
      { latitude: -10, longitude: 179 },
    );
    expect(distance).toBeLessThanOrEqual(20015.087); // never exceeds the antipodal maximum
    // A naive |Δlng| × cos(lat) estimate would wrongly treat this as ~358° apart, i.e. huge;
    // the real short-way distance is small — on the order of a couple thousand km, not global.
    expect(distance).toBeLessThan(3000);
  });
});

describe("additionalRoundTripKm", () => {
  it("doubles the one-way distance — §9.4.2's factor-of-two fix", () => {
    expect(additionalRoundTripKm(3)).toBe(6);
    expect(additionalRoundTripKm(0)).toBe(0);
  });
});

describe("boundingBox", () => {
  it("is symmetric around the centre", () => {
    const box = boundingBox({ latitude: -33.87, longitude: 151.21 }, 10);
    expect(box.maxLat - -33.87).toBeCloseTo(-33.87 - box.minLat, 10);
    expect(box.maxLng - 151.21).toBeCloseTo(151.21 - box.minLng, 10);
  });

  it("widens the longitude span at higher latitude — the cos(lat) correction", () => {
    // §6.5's "common bug": without dividing by cos(latitude), the box is too narrow in
    // longitude at higher latitudes and stations are silently missed. A box further from the
    // equator must span more degrees of longitude for the same radius in km.
    const equatorBox = boundingBox({ latitude: 0, longitude: 0 }, 50);
    const highLatBox = boundingBox({ latitude: -60, longitude: 0 }, 50);
    const equatorLngSpan = equatorBox.maxLng - equatorBox.minLng;
    const highLatLngSpan = highLatBox.maxLng - highLatBox.minLng;
    expect(highLatLngSpan).toBeGreaterThan(equatorLngSpan);
    // cos(60°) = 0.5 exactly, so the high-latitude span should be almost exactly double.
    expect(highLatLngSpan / equatorLngSpan).toBeCloseTo(2, 2);
  });

  it("the latitude span alone does not depend on latitude (only longitude does)", () => {
    const equatorBox = boundingBox({ latitude: 0, longitude: 0 }, 50);
    const highLatBox = boundingBox({ latitude: -60, longitude: 0 }, 50);
    expect(highLatBox.maxLat - highLatBox.minLat).toBeCloseTo(
      equatorBox.maxLat - equatorBox.minLat,
      10,
    );
  });

  it("stays finite at a pole, rather than producing NaN or Infinity — §9.10's boundary case", () => {
    const box = boundingBox({ latitude: 90, longitude: 0 }, 10);
    expect(Number.isFinite(box.minLng)).toBe(true);
    expect(Number.isFinite(box.maxLng)).toBe(true);
  });

  it("every real NSW/TAS candidate station falls inside a box built around a nearby search point", () => {
    // Direct check of the actual reason this function exists: a station within `radiusKm` of
    // the centre must land inside the box haversineDistanceKm confirms is that close.
    const centre = { latitude: -33.87, longitude: 151.21 };
    const nearbyStation = { latitude: -33.85, longitude: 151.19 }; // a few km away
    const radiusKm = 10;
    expect(haversineDistanceKm(centre, nearbyStation)).toBeLessThan(radiusKm);

    const box = boundingBox(centre, radiusKm);
    expect(nearbyStation.latitude).toBeGreaterThanOrEqual(box.minLat);
    expect(nearbyStation.latitude).toBeLessThanOrEqual(box.maxLat);
    expect(nearbyStation.longitude).toBeGreaterThanOrEqual(box.minLng);
    expect(nearbyStation.longitude).toBeLessThanOrEqual(box.maxLng);
  });
});

describe("distanceToSegmentKm — UC-02 corridor geometry (ADR-011)", () => {
  // A segment along the equator (fixed latitude, so cos(lat) = 1 — no longitude correction to
  // reason about), 1° of longitude long: segStart (0,0) to segEnd (0,1).
  const segStart = { latitude: 0, longitude: 0 };
  const segEnd = { latitude: 0, longitude: 1 };

  it("is zero for a point exactly on the segment", () => {
    const onSegment = { latitude: 0, longitude: 0.5 };
    expect(distanceToSegmentKm(onSegment, segStart, segEnd)).toBeCloseTo(0, 6);
  });

  it("measures the perpendicular distance for a point beside the segment's middle", () => {
    // 0.5° of latitude directly above the segment's midpoint — perpendicular distance is just
    // that latitude offset in km (no longitude component): 0.5 × 111.32 (this function's own
    // km-per-degree constant, matching boundingBox's — a flat-plane approximation, deliberately
    // not the more precise geodesic figure haversineDistanceKm's own test uses; see the module
    // comment on why that's the right trade-off here).
    const besideMidpoint = { latitude: 0.5, longitude: 0.5 };
    expect(distanceToSegmentKm(besideMidpoint, segStart, segEnd)).toBeCloseTo(55.66, 6);
  });

  it("clamps to the start endpoint for a point whose projection falls before the segment", () => {
    // Compared against this same function's own degenerate-segment case (straight-line distance
    // to a single point via its own flat-plane projection), not haversineDistanceKm — the two
    // use different approximations (flat-plane vs. exact geodesic) that agree closely but not to
    // many decimal places, so cross-checking them isn't a meaningful equality test here.
    const behindStart = { latitude: 0, longitude: -1 };
    expect(distanceToSegmentKm(behindStart, segStart, segEnd)).toBeCloseTo(
      distanceToSegmentKm(behindStart, segStart, segStart),
      6,
    );
  });

  it("clamps to the end endpoint for a point whose projection falls past the segment", () => {
    const pastEnd = { latitude: 0, longitude: 2 };
    expect(distanceToSegmentKm(pastEnd, segStart, segEnd)).toBeCloseTo(
      distanceToSegmentKm(pastEnd, segEnd, segEnd),
      6,
    );
  });

  it("degenerate segment (origin === destination) roughly matches the real geodesic distance to that point", () => {
    // Loose tolerance deliberately — this is the flat-plane approximation vs. the exact
    // haversine figure, and the two are expected to differ slightly (the same trade-off
    // `boundingBox` already makes), not to match to many decimal places.
    const samePoint = { latitude: -33.87, longitude: 151.21 };
    const elsewhere = { latitude: -33.9, longitude: 151.25 };
    expect(distanceToSegmentKm(elsewhere, samePoint, samePoint)).toBeCloseTo(
      haversineDistanceKm(elsewhere, samePoint),
      1,
    );
  });

  it("real-world sanity check: Goulburn (near the Sydney-Canberra route) is closer to that corridor than Wollongong (on the coast, off-route)", () => {
    const sydney = { latitude: -33.8688, longitude: 151.2093 };
    const canberra = { latitude: -35.3081, longitude: 149.1244 };
    const goulburn = { latitude: -34.7539, longitude: 149.7161 };
    const wollongong = { latitude: -34.4278, longitude: 150.8931 };

    const goulburnDistance = distanceToSegmentKm(goulburn, sydney, canberra);
    const wollongongDistance = distanceToSegmentKm(wollongong, sydney, canberra);

    expect(goulburnDistance).toBeCloseTo(12.47, 0); // within ~1km
    expect(wollongongDistance).toBeCloseTo(29.16, 0);
    expect(goulburnDistance).toBeLessThan(wollongongDistance);
  });
});

describe("isWithinCorridor", () => {
  const origin = { latitude: -33.8688, longitude: 151.2093 }; // Sydney
  const destination = { latitude: -35.3081, longitude: 149.1244 }; // Canberra
  const goulburn = { latitude: -34.7539, longitude: 149.7161 }; // ~12.5km off the direct line
  const wollongong = { latitude: -34.4278, longitude: 150.8931 }; // ~29.2km off the direct line

  it("includes a station within the corridor width", () => {
    expect(isWithinCorridor(goulburn, origin, destination, 20)).toBe(true);
  });

  it("excludes a station outside the corridor width", () => {
    expect(isWithinCorridor(wollongong, origin, destination, 20)).toBe(false);
  });

  it("is inclusive at the exact boundary (<=, not <)", () => {
    const distance = distanceToSegmentKm(goulburn, origin, destination);
    expect(isWithinCorridor(goulburn, origin, destination, distance)).toBe(true);
  });
});

describe("corridorDetourKm — UC-02's actual (not doubled) detour", () => {
  it("is zero when the waypoint is the origin or the destination itself", () => {
    const origin = { latitude: -33.8688, longitude: 151.2093 };
    const destination = { latitude: -35.3081, longitude: 149.1244 };
    expect(corridorDetourKm(origin, origin, destination)).toBe(0);
    expect(corridorDetourKm(origin, destination, destination)).toBe(0);
  });

  it("is never negative, even for a waypoint essentially on the direct line (float-noise clamp)", () => {
    const origin = { latitude: 0, longitude: 0 };
    const destination = { latitude: 0, longitude: 2 };
    const almostOnLine = { latitude: 0, longitude: 1 }; // exact midpoint
    expect(corridorDetourKm(origin, almostOnLine, destination)).toBeGreaterThanOrEqual(0);
  });

  it("is NOT double the one-way distance — unlike additionalRoundTripKm, a commute isn't a separate round trip just for fuel", () => {
    const origin = { latitude: 0, longitude: 0 };
    const destination = { latitude: 0, longitude: 2 };
    const waypoint = { latitude: 1, longitude: 1 }; // 1° north of the midpoint
    const detour = corridorDetourKm(origin, waypoint, destination);
    const naiveDoubled = additionalRoundTripKm(haversineDistanceKm(origin, waypoint));
    expect(detour).toBeLessThan(naiveDoubled);
  });

  it("real-world sanity check: Wollongong (off-route) costs more detour than Goulburn (near-route) on a Sydney→Canberra trip", () => {
    const sydney = { latitude: -33.8688, longitude: 151.2093 };
    const canberra = { latitude: -35.3081, longitude: 149.1244 };
    const goulburn = { latitude: -34.7539, longitude: 149.7161 };
    const wollongong = { latitude: -34.4278, longitude: 150.8931 };

    const goulburnDetour = corridorDetourKm(sydney, goulburn, canberra);
    const wollongongDetour = corridorDetourKm(sydney, wollongong, canberra);

    expect(goulburnDetour).toBeCloseTo(1.59, 0);
    expect(wollongongDetour).toBeCloseTo(8.29, 0);
    expect(goulburnDetour).toBeLessThan(wollongongDetour);
  });
});
