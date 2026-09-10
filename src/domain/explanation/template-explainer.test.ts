import { describe, expect, it } from "vitest";

import type { ComparisonResult, RankedCandidate } from "../calculation/rank-candidates";
import type { ReasonCode } from "../calculation/types";
import { explainPriceContext, explainRecommendation } from "./template-explainer";

const now = new Date("2026-09-09T12:00:00Z");

function candidate(overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    stationId: "station-1",
    brand: "Ampol",
    metrics: {
      distanceKm: 2.4,
      additionalRoundTripKm: 4.8,
      fillCostCents: 7196,
      extraFuelCostCents: 82,
      effectiveCostCents: 7278,
      priceTenthsCpl: 1799,
      sourceReportedAt: now,
    },
    ...overrides,
  };
}

function result(
  reasonCodes: ReasonCode[],
  overrides: Partial<ComparisonResult> = {},
): ComparisonResult {
  return {
    mode: "comparison",
    engineVersion: "1.0.0",
    recommended: candidate(),
    ranked: [candidate()],
    reasonCodes,
    estimatedSavingCents: 480,
    confidence: "medium",
    rankPercentile: null,
    trendDirection: "flat",
    referenceVolumeLitres: 40,
    ...overrides,
  };
}

describe("explainRecommendation", () => {
  it("uses the 'already nearest and cheapest' sentence, no detour caveat, when that's the only relevant code", () => {
    const sentence = explainRecommendation(
      result(["ALREADY_NEAREST_AND_CHEAPEST", "WITHIN_MAX_DETOUR"]),
    );
    expect(sentence).toBe(
      "Ampol is your closest option and also comes out cheapest once the drive is counted — no detour worth making today.",
    );
  });

  it("adds the 'a cheaper price exists further away' caveat when DETOUR_NOT_WORTH_SAVING also fires", () => {
    const sentence = explainRecommendation(
      result(["ALREADY_NEAREST_AND_CHEAPEST", "DETOUR_NOT_WORTH_SAVING", "WITHIN_MAX_DETOUR"]),
    );
    expect(sentence).toBe(
      "Ampol is your closest option and still works out cheapest once the drive is counted — a lower per-litre price exists further away, but it's not worth the extra distance.",
    );
  });

  it("uses the distance+saving sentence when the recommendation isn't the nearest station", () => {
    const sentence = explainRecommendation(
      result(["LOWER_EFFECTIVE_COST", "LOWEST_UNIT_PRICE", "WITHIN_MAX_DETOUR"], {
        recommended: candidate({
          brand: "7-Eleven",
          metrics: { ...candidate().metrics, distanceKm: 3.1 },
        }),
        estimatedSavingCents: 355,
      }),
    );
    expect(sentence).toBe(
      "7-Eleven is 3.1 km away and works out about $3.55 cheaper than the nearest alternative, once the extra driving is counted.",
    );
  });

  it("falls back to a generic label when brand is null", () => {
    const sentence = explainRecommendation(
      result(["LOWER_EFFECTIVE_COST", "WITHIN_MAX_DETOUR"], {
        recommended: candidate({ brand: null }),
      }),
    );
    expect(sentence.startsWith("This station is")).toBe(true);
  });

  it("prioritises the already-nearest framing over LOWER_EFFECTIVE_COST when both codes are present", () => {
    // Realistic: a single-candidate result still gets LOWER_EFFECTIVE_COST-style facts absent,
    // but a multi-candidate tie where the nearest also wins outright emits both codes together.
    const sentence = explainRecommendation(
      result(["ALREADY_NEAREST_AND_CHEAPEST", "LOWER_EFFECTIVE_COST", "LOWEST_UNIT_PRICE"]),
    );
    expect(sentence).toContain("your closest option");
    expect(sentence).not.toContain("cheaper than the nearest alternative");
  });

  it("falls back to a plain distance+price sentence in the defensive case neither primary code fires", () => {
    const sentence = explainRecommendation(result(["WITHIN_MAX_DETOUR"]));
    expect(sentence).toBe("Ampol is 2.4 km away, priced at 179.9¢/L.");
  });
});

describe("explainPriceContext", () => {
  function context(overrides: Partial<Parameters<typeof explainPriceContext>[0]> = {}) {
    return {
      currentPriceTenths: 1997,
      averageTenths: 2034,
      percentile: 0.22, // 22% of days were at or below today's (cheap) price
      trendDirection: "falling" as const,
      historyDays: 30,
      ...overrides,
    };
  }

  it("refuses to judge when there's insufficient history, per §9.7", () => {
    expect(explainPriceContext(context({ historyDays: 3 }))).toBe(
      "Not enough local history has been collected yet to judge whether this is a good price.",
    );
  });

  it("refuses to judge when there's no usable average even with enough days", () => {
    expect(explainPriceContext(context({ historyDays: 10, averageTenths: null }))).toBe(
      "Not enough local history has been collected yet to judge whether this is a good price.",
    );
  });

  it("describes a below-average price correctly, with percentile framing inverted from the raw value", () => {
    const sentence = explainPriceContext(context());
    expect(sentence).toBe(
      "Current price is 3.7¢ below the 30-day local average. That's cheaper than 78% of the last 30 days.",
    );
  });

  it("describes an above-average price with 'above', not 'below'", () => {
    const sentence = explainPriceContext(context({ currentPriceTenths: 2100, percentile: 0.85 }));
    expect(sentence).toBe(
      "Current price is 6.6¢ above the 30-day local average. That's cheaper than 15% of the last 30 days.",
    );
  });

  it("handles an exact match to the average without a signed direction word", () => {
    const sentence = explainPriceContext(context({ currentPriceTenths: 2034, percentile: 0.5 }));
    expect(sentence).toBe(
      "Current price is right in line with the 30-day local average. That's cheaper than 50% of the last 30 days.",
    );
  });

  it("omits the percentile sentence when percentile is null", () => {
    const sentence = explainPriceContext(context({ percentile: null }));
    expect(sentence).toBe("Current price is 3.7¢ below the 30-day local average.");
  });
});
