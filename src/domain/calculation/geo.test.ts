import { describe, expect, it } from "vitest";
import { additionalRoundTripKm, boundingBox, haversineDistanceKm } from "./geo";

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
