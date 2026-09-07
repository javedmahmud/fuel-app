import { describe, expect, it } from "vitest";
import { applyQualityGates, isNonPricedFuelType, type QualityGateContext } from "./quality-gates";
import type { PriceObservation } from "../fuel-api/types";

const now = new Date("2026-09-08T00:00:00Z");

const context: QualityGateContext = {
  knownStationCodes: new Set(["625"]),
  knownFuelTypeCodes: new Set(["U91"]),
  now,
};

function observation(overrides: Partial<PriceObservation> = {}): PriceObservation {
  return {
    sourceStationCode: "625",
    fuelTypeSourceCode: "U91",
    priceTenthsCpl: 1769,
    sourceReportedAt: new Date("2026-09-07T23:00:00Z"), // 1 hour before `now`
    raw: { stationcode: 625, state: "NSW", fueltype: "U91", price: 176.9, lastupdated: "x" },
    ...overrides,
  };
}

describe("applyQualityGates", () => {
  it("accepts a well-formed observation matching known reference data", () => {
    expect(applyQualityGates(observation(), context)).toEqual({ accepted: true });
  });

  it("rejects a non-finite price without alarming", () => {
    expect(applyQualityGates(observation({ priceTenthsCpl: NaN }), context)).toEqual({
      accepted: false,
      reason: "price_not_numeric",
      alarmWorthy: false,
    });
  });

  it("rejects and alarms on a price below the plausibility band (e.g. a unit error)", () => {
    expect(applyQualityGates(observation({ priceTenthsCpl: 100 }), context)).toEqual({
      accepted: false,
      reason: "price_implausible",
      alarmWorthy: true,
    });
  });

  it("rejects and alarms on a price above the plausibility band", () => {
    expect(applyQualityGates(observation({ priceTenthsCpl: 6000 }), context)).toEqual({
      accepted: false,
      reason: "price_implausible",
      alarmWorthy: true,
    });
  });

  it("accepts prices right at the plausibility band's edges", () => {
    expect(applyQualityGates(observation({ priceTenthsCpl: 500 }), context)).toEqual({
      accepted: true,
    });
    expect(applyQualityGates(observation({ priceTenthsCpl: 5000 }), context)).toEqual({
      accepted: true,
    });
  });

  it("rejects and alarms on an unknown fuel type — could signal a new code needing a ref-data resync", () => {
    expect(applyQualityGates(observation({ fuelTypeSourceCode: "XYZ" }), context)).toEqual({
      accepted: false,
      reason: "fuel_type_unknown",
      alarmWorthy: true,
    });
  });

  it("rejects (without alarming) an unknown station — resolves on the next weekly ref-data sync", () => {
    expect(applyQualityGates(observation({ sourceStationCode: "999999" }), context)).toEqual({
      accepted: false,
      reason: "station_unknown",
      alarmWorthy: false,
    });
  });

  it("rejects when the timestamp never parsed (undefined)", () => {
    expect(applyQualityGates(observation({ sourceReportedAt: undefined }), context)).toEqual({
      accepted: false,
      reason: "source_reported_at_insane",
      alarmWorthy: false,
    });
  });

  it("rejects a timestamp more than a year old", () => {
    const tooOld = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    expect(applyQualityGates(observation({ sourceReportedAt: tooOld }), context)).toEqual({
      accepted: false,
      reason: "source_reported_at_insane",
      alarmWorthy: false,
    });
  });

  it("rejects a timestamp too far in the future, tolerating small clock skew", () => {
    const wayFuture = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h ahead
    expect(applyQualityGates(observation({ sourceReportedAt: wayFuture }), context)).toEqual({
      accepted: false,
      reason: "source_reported_at_insane",
      alarmWorthy: false,
    });

    const slightlyFuture = new Date(now.getTime() + 5 * 60 * 1000); // 5 min ahead — within tolerance
    expect(applyQualityGates(observation({ sourceReportedAt: slightlyFuture }), context)).toEqual({
      accepted: true,
    });
  });
});

describe("isNonPricedFuelType", () => {
  it('flags "EV" — the NSW Fuel API\'s price=0 charging placeholder, not real price data', () => {
    expect(isNonPricedFuelType("EV")).toBe(true);
  });

  it("does not flag a real fuel type code", () => {
    expect(isNonPricedFuelType("U91")).toBe(false);
    expect(isNonPricedFuelType("DL")).toBe(false);
  });
});
