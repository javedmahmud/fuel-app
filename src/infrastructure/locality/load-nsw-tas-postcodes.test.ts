import { describe, expect, it } from "vitest";
import { resolveLocality } from "../../domain/locality/locality-resolver";
import { ATTRIBUTION, loadNswTasPostcodes } from "./load-nsw-tas-postcodes";

/**
 * Against the real generated dataset (`npm run postcode:build`'s output), not synthetic data —
 * mirrors `load-nsw-localities.test.ts` exactly, reusing the same `resolveLocality` (no new
 * domain logic needed for postcodes — same shape of problem, different backing table). A static
 * file with no network/DB involved, so this runs as a normal unit test.
 */
describe("loadNswTasPostcodes (real dataset)", () => {
  it("loads a substantial, real NSW/TAS postcode set", () => {
    const postcodes = loadNswTasPostcodes();
    // 753 confirmed live (638 NSW 2xxx + 115 TAS 7xxx) when the build script last ran — a wide
    // bound, not the exact number, so a future ABS edition bump doesn't make this brittle.
    expect(postcodes.length).toBeGreaterThan(600);
    expect(postcodes.length).toBeLessThan(1000);
  });

  it("reproduces every real coordinate from spike/geo-data/README.md's own postcode spot-check", () => {
    const postcodes = loadNswTasPostcodes();

    const cases: { code: string; latitude: number; longitude: number }[] = [
      { code: "2000", latitude: -33.8698, longitude: 151.21 }, // Sydney CBD
      { code: "2150", latitude: -33.8152, longitude: 151.0082 }, // Parramatta
      { code: "2650", latitude: -35.2754, longitude: 147.4129 }, // Wagga Wagga
      { code: "7000", latitude: -42.8746, longitude: 147.3154 }, // Hobart
    ];

    for (const { code, latitude, longitude } of cases) {
      const match = resolveLocality(code, postcodes);
      expect(match, `expected to resolve postcode "${code}"`).toBeDefined();
      expect(match?.latitude).toBeCloseTo(latitude, 3);
      expect(match?.longitude).toBeCloseTo(longitude, 3);
    }
  });

  it("resolves postcode 2000 to essentially the same point as the SAL 'Sydney' locality — cross-validation", async () => {
    const { loadNswLocalities } = await import("./load-nsw-localities");
    const postcodes = loadNswTasPostcodes();
    const localities = loadNswLocalities();

    const fromPostcode = resolveLocality("2000", postcodes);
    const fromLocality = resolveLocality("Sydney", localities);

    expect(fromPostcode?.latitude).toBeCloseTo(fromLocality!.latitude, 2);
    expect(fromPostcode?.longitude).toBeCloseTo(fromLocality!.longitude, 2);
  });

  it("excludes out-of-range postcodes — e.g. a Victorian or Queensland postcode", () => {
    const postcodes = loadNswTasPostcodes();
    expect(resolveLocality("3000", postcodes)).toBeUndefined(); // Melbourne
    expect(resolveLocality("4000", postcodes)).toBeUndefined(); // Brisbane
  });

  it("excludes ABS's non-geographic catch-all categories", () => {
    const postcodes = loadNswTasPostcodes();
    expect(resolveLocality("9494", postcodes)).toBeUndefined();
    expect(resolveLocality("ZZZZ", postcodes)).toBeUndefined();
  });

  it("caches the loaded dataset — repeated calls return the same array instance", () => {
    expect(loadNswTasPostcodes()).toBe(loadNswTasPostcodes());
  });
});

describe("ATTRIBUTION", () => {
  it("carries the exact required CC BY 4.0 attribution text, distinct from the locality one", () => {
    expect(ATTRIBUTION).toContain("Australian Bureau of Statistics");
    expect(ATTRIBUTION).toContain("Postal Areas");
    expect(ATTRIBUTION).toContain("CC BY 4.0");
  });
});
