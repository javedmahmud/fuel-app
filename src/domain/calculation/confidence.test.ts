import { describe, expect, it } from "vitest";
import { computeConfidence } from "./confidence";

function base(overrides: Partial<Parameters<typeof computeConfidence>[0]> = {}) {
  return {
    historyDays: 20,
    candidateCount: 3,
    priceAgeHours: 10,
    mode: "personalised" as const,
    ...overrides,
  };
}

describe("computeConfidence", () => {
  it("is high when every condition is met in personalised mode", () => {
    expect(computeConfidence(base())).toBe("high");
  });

  it("is never high in comparison mode, no matter how good the other inputs are — §9.4.4", () => {
    expect(computeConfidence(base({ mode: "comparison" }))).toBe("medium");
  });

  it("drops to medium when history is just under the high threshold", () => {
    expect(computeConfidence(base({ historyDays: 19 }))).toBe("medium");
  });

  it("drops to medium when there are too few candidates for high", () => {
    expect(computeConfidence(base({ candidateCount: 2 }))).toBe("medium");
  });

  it("drops to medium when the price is just over 48h old", () => {
    expect(computeConfidence(base({ priceAgeHours: 48.1 }))).toBe("medium");
  });

  it("is medium at exactly the medium thresholds (7 days, 2 candidates, <7 days old)", () => {
    expect(
      computeConfidence({
        historyDays: 7,
        candidateCount: 2,
        priceAgeHours: 24,
        mode: "comparison",
      }),
    ).toBe("medium");
  });

  it("is low when history is below the medium threshold", () => {
    expect(computeConfidence(base({ historyDays: 6, mode: "comparison" }))).toBe("low");
  });

  it("is low when there's only one candidate", () => {
    expect(computeConfidence(base({ candidateCount: 1, mode: "comparison" }))).toBe("low");
  });

  it("is low when the price is a week old or more", () => {
    expect(computeConfidence(base({ priceAgeHours: 7 * 24, mode: "comparison" }))).toBe("low");
  });

  it("is low with no history and no candidates at all", () => {
    expect(
      computeConfidence({
        historyDays: 0,
        candidateCount: 0,
        priceAgeHours: 999,
        mode: "comparison",
      }),
    ).toBe("low");
  });
});
