import { describe, expect, it } from "vitest";
import { normaliseFuelType, normalisePrice, normaliseStation, toPriceTenthsCpl } from "./normalise";
import type { RawFuelType, RawPrice, RawStation } from "./types";

// Fixtures below are lifted verbatim from spike/findings/test1.raw.json and test2.raw.json —
// real confirmed shapes, not invented ones.

const rawStation: RawStation = {
  brandid: "",
  stationid: "",
  brand: "United",
  code: "972",
  name: "United Petroleum Umina",
  address: "307-313 Ocean Beach Road, UMINA BEACH NSW 2257",
  location: { latitude: -33.511231, longitude: 151.318092 },
  state: "NSW",
};

const rawFuelType: RawFuelType = {
  code: "E10-U91",
  name: "Ethanol 94 / Unleaded 91",
  state: "NSW",
};

const rawPrice: RawPrice = {
  stationcode: 625,
  state: "NSW",
  fueltype: "U91",
  price: 176.9,
  lastupdated: "30/08/2026 12:15:21",
};

describe("toPriceTenthsCpl", () => {
  it("converts the documented example exactly (178.9 -> 1789)", () => {
    expect(toPriceTenthsCpl(178.9)).toBe(1789);
  });

  it("converts a range of real observed price values exactly", () => {
    // Checked empirically: single-decimal cents/L values in this range don't actually trigger
    // floating-point drift in JS when multiplied by 10 (unlike the classic 0.1+0.2 case) — but
    // Math.round is kept in the implementation as cheap, correct defensive practice regardless,
    // rather than relying on that holding for every possible input.
    expect(toPriceTenthsCpl(176.9)).toBe(1769);
    expect(toPriceTenthsCpl(258.9)).toBe(2589);
    expect(toPriceTenthsCpl(209.9)).toBe(2099);
  });
});

describe("normaliseStation", () => {
  it("maps every field from a real reference-data record", () => {
    expect(normaliseStation(rawStation)).toEqual({
      sourceStationCode: "972",
      source: "NSW_FUEL_API",
      name: "United Petroleum Umina",
      brand: "United",
      addressLine: "307-313 Ocean Beach Road, UMINA BEACH NSW 2257",
      latitude: -33.511231,
      longitude: 151.318092,
      state: "NSW",
    });
  });
});

describe("normaliseFuelType", () => {
  it("maps a real fuel-type record", () => {
    expect(normaliseFuelType(rawFuelType)).toEqual({
      sourceCode: "E10-U91",
      displayName: "Ethanol 94 / Unleaded 91",
    });
  });
});

describe("normalisePrice", () => {
  it("coerces stationcode (number) to a string, matching Station.sourceStationCode's type", () => {
    const result = normalisePrice(rawPrice);
    expect(result.sourceStationCode).toBe("625");
    expect(typeof result.sourceStationCode).toBe("string");
  });

  it("converts price to integer tenths and parses the timestamp", () => {
    const result = normalisePrice(rawPrice);
    expect(result.priceTenthsCpl).toBe(1769);
    expect(result.sourceReportedAt?.toISOString()).toBe("2026-08-30T02:15:21.000Z");
  });

  it("keeps the raw record attached for provenance (raw_payload, §6.4)", () => {
    expect(normalisePrice(rawPrice).raw).toBe(rawPrice);
  });

  it("leaves sourceReportedAt undefined for an unparseable timestamp, rather than throwing", () => {
    const bad: RawPrice = { ...rawPrice, lastupdated: "garbage" };
    expect(normalisePrice(bad).sourceReportedAt).toBeUndefined();
  });
});
