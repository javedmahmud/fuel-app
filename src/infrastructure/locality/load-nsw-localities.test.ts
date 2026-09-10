import { describe, expect, it } from "vitest";
import { resolveLocality } from "../../domain/locality/locality-resolver";
import { ATTRIBUTION, loadNswLocalities } from "./load-nsw-localities";

/**
 * Against the real generated dataset (`npm run locality:build`'s output), not synthetic data —
 * a static file with no network/DB involved, so this runs as a normal unit test, not an
 * `.integration.test.ts`. Reproduces `spike/geo-data/README.md`'s own Test 8 spot-check values
 * exactly, so a regression in the build script (a coordinate-axis swap, a bad sort, a broken
 * filter) fails this test, not just a manual eyeball later.
 */
describe("loadNswLocalities (real dataset)", () => {
  it("loads a substantial, real NSW locality set", () => {
    const localities = loadNswLocalities();
    // 4,542 confirmed live when scripts/build-locality-dataset.ts last ran (2 non-geographic
    // ABS categories excluded from the source's 4,544 features) — a wide bound, not the exact
    // number, so a future ABS edition bump doesn't make this test brittle for no reason.
    expect(localities.length).toBeGreaterThan(4000);
  });

  it("reproduces every real coordinate from spike/geo-data/README.md's own Test 8 spot-check", () => {
    const localities = loadNswLocalities();

    const cases: { name: string; latitude: number; longitude: number }[] = [
      { name: "Sydney", latitude: -33.8698, longitude: 151.21 },
      { name: "Newtown (NSW)", latitude: -33.8976, longitude: 151.1804 },
      { name: "Parramatta", latitude: -33.815, longitude: 151.0082 },
      { name: "Bondi Beach", latitude: -33.8909, longitude: 151.2739 },
      { name: "Wagga Wagga", latitude: -35.1055, longitude: 147.3606 },
    ];

    for (const { name, latitude, longitude } of cases) {
      const match = resolveLocality(name, localities);
      expect(match, `expected to resolve "${name}"`).toBeDefined();
      expect(match?.latitude).toBeCloseTo(latitude, 3);
      expect(match?.longitude).toBeCloseTo(longitude, 3);
    }
  });

  it("excludes ABS's non-geographic catch-all categories", () => {
    const localities = loadNswLocalities();
    expect(resolveLocality("No usual address (NSW)", localities)).toBeUndefined();
    expect(resolveLocality("Migratory - Offshore - Shipping (NSW)", localities)).toBeUndefined();
  });

  it("caches the loaded dataset — repeated calls return the same array instance", () => {
    expect(loadNswLocalities()).toBe(loadNswLocalities());
  });
});

describe("ATTRIBUTION", () => {
  it("carries the exact required CC BY 4.0 attribution text", () => {
    expect(ATTRIBUTION).toContain("Australian Bureau of Statistics");
    expect(ATTRIBUTION).toContain("CC BY 4.0");
  });
});
