import { describe, expect, it } from "vitest";
import {
  detourFuelLitres,
  effectiveCostCents,
  estimatedSavingCents,
  extraFuelCostCents,
  fillCostCents,
  litresRequired,
} from "./cost";
import { isLitresKnown, LITRES_UNKNOWN } from "./litres";

describe("litresRequired", () => {
  it("computes tankCapacity × (1 − currentFraction)", () => {
    const result = litresRequired(50, 0.25);
    expect(isLitresKnown(result)).toBe(true);
    expect(result).toBeCloseTo(37.5, 10);
  });

  it("is a valid zero when the tank is reported exactly full — not confused with unknown (§9.10 boundary: fraction = 1)", () => {
    const result = litresRequired(50, 1);
    expect(result).toBe(0);
    expect(isLitresKnown(result)).toBe(true);
  });

  it("is the full tank capacity when the tank is reported exactly empty (§9.10 boundary: fraction = 0)", () => {
    const result = litresRequired(50, 0);
    expect(result).toBe(50);
    expect(isLitresKnown(result)).toBe(true);
  });

  it("is Unknown when the current fraction isn't known — §9.3's default case", () => {
    expect(litresRequired(50, null)).toBe(LITRES_UNKNOWN);
  });

  it("is Unknown when the tank capacity isn't known, even if the fraction is", () => {
    expect(litresRequired(null, 0.5)).toBe(LITRES_UNKNOWN);
  });

  it("is Unknown when neither is known", () => {
    expect(litresRequired(null, null)).toBe(LITRES_UNKNOWN);
  });
});

describe("fillCostCents", () => {
  it("reproduces §9.4.3's headline worked example: 50 L at 175.9 c/L = $87.95", () => {
    expect(fillCostCents(50, 1759)).toBe(8795);
  });

  it("is zero for zero litres — §9.10's boundary case", () => {
    expect(fillCostCents(0, 1799)).toBe(0);
  });

  it("rounds to the nearest cent rather than truncating", () => {
    // 33.333 L × 179.9 c/L = 5996.6067 cents -> rounds to 5997, not truncated to 5996.
    expect(fillCostCents(33.333, 1799)).toBe(5997);
  });
});

describe("detourFuelLitres / extraFuelCostCents", () => {
  it("reproduces §9.4.2's worked example exactly: 6 km round-trip, 8 L/100km, 180 c/L = 86c", () => {
    const litres = detourFuelLitres(6, 8);
    expect(litres).toBeCloseTo(0.48, 10);
    expect(extraFuelCostCents(6, 8, 1800)).toBe(86); // doc: "6 × 0.08 × 1.80 = 86c"
  });

  it("the one-way reading the doc rejects would have given 43c, not 86c — confirms the factor of two matters", () => {
    expect(extraFuelCostCents(3, 8, 1800)).toBe(43); // doc's rejected one-way reading, for contrast
  });

  it("is zero for zero distance or zero consumption", () => {
    expect(extraFuelCostCents(0, 8, 1800)).toBe(0);
    expect(extraFuelCostCents(6, 0, 1800)).toBe(0);
  });
});

describe("effectiveCostCents", () => {
  it("is the sum of fill cost and detour fuel cost", () => {
    expect(effectiveCostCents(8795, 86)).toBe(8881);
  });

  it("adding any detour never decreases effective cost", () => {
    const fillCost = 8795;
    expect(effectiveCostCents(fillCost, 50)).toBeGreaterThanOrEqual(
      effectiveCostCents(fillCost, 0),
    );
  });

  it("is monotonic in price — §9.10's property: a higher price per litre never produces a lower effective cost", () => {
    const litres = 45;
    const roundTripKm = 6;
    const consumptionLPer100km = 8;
    const prices = [1500, 1650, 1700, 1799, 1850, 2000];
    const costs = prices.map((p) =>
      effectiveCostCents(
        fillCostCents(litres, p),
        extraFuelCostCents(roundTripKm, consumptionLPer100km, p),
      ),
    );
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1]);
    }
  });
});

describe("estimatedSavingCents", () => {
  it("reproduces §9.4.3's table exactly: 50 L fill, best 175.9 vs nearest 178.9 = $1.50 saving", () => {
    // Table 9.4.3: "vs. nearest station | $1.50 | Honest, conservative..." — same 50L fill,
    // recommended (best) price 175.9, nearest-station price 178.9, no detour difference implied
    // by the table's own framing (it's isolating the price-baseline choice, not detour cost).
    const bestCost = fillCostCents(50, 1759);
    const nearestCost = fillCostCents(50, 1789);
    expect(estimatedSavingCents(bestCost, nearestCost)).toBe(150);
  });

  it("is zero when the candidate and nearest are the same station", () => {
    const cost = effectiveCostCents(8795, 0);
    expect(estimatedSavingCents(cost, cost)).toBe(0);
  });

  it("is negative when the 'candidate' is actually more expensive than nearest — a real possibility the type must allow", () => {
    expect(estimatedSavingCents(9000, 8795)).toBe(-205);
  });
});
