import { describe, expect, it } from "vitest";
import { rankPercentile, timeWeightedAverage, trend, type DailyRollupSummary } from "./history";

function rollup(overrides: Partial<DailyRollupSummary> = {}): DailyRollupSummary {
  return {
    priceDate: "2026-09-01",
    timeWeightedAvgTenths: 1000,
    closeTenthsCpl: 1000,
    partialDay: false,
    ...overrides,
  };
}

describe("timeWeightedAverage", () => {
  it("averages daily figures equally — §10.7, not weighted by anything else", () => {
    const rollups = [
      rollup({ timeWeightedAvgTenths: 100 }),
      rollup({ timeWeightedAvgTenths: 200 }),
      rollup({ timeWeightedAvgTenths: 300 }),
    ];
    expect(timeWeightedAverage(rollups)).toEqual({ averageTenths: 200, includedDays: 3 });
  });

  it("excludes partial_day rows from both the average and the included-day count", () => {
    const rollups = [
      rollup({ timeWeightedAvgTenths: 100 }),
      rollup({ timeWeightedAvgTenths: 9999, partialDay: true }), // must not pull the average
      rollup({ timeWeightedAvgTenths: 300 }),
    ];
    expect(timeWeightedAverage(rollups)).toEqual({ averageTenths: 200, includedDays: 2 });
  });

  it("is null with zero included days — no rows at all", () => {
    expect(timeWeightedAverage([])).toEqual({ averageTenths: null, includedDays: 0 });
  });

  it("is null when every row is a partial day", () => {
    expect(timeWeightedAverage([rollup({ partialDay: true })])).toEqual({
      averageTenths: null,
      includedDays: 0,
    });
  });
});

describe("rankPercentile", () => {
  it("computes the fraction of window days at or below the current price", () => {
    expect(rankPercentile(200, [100, 150, 200, 250, 300])).toBeCloseTo(0.6, 10); // 3 of 5
  });

  it("is 1.0 when the current price matches every window day — an identical-prices boundary case", () => {
    expect(rankPercentile(150, [150, 150, 150])).toBe(1);
  });

  it("is 1.0 when today's price is the highest ever seen", () => {
    expect(rankPercentile(9999, [100, 150, 200])).toBe(1);
  });

  it("is 0.0 when today's price is the lowest ever seen", () => {
    expect(rankPercentile(1, [100, 150, 200])).toBe(0);
  });

  it("is always within [0, 1] — the property §9.10 requires", () => {
    const windows = [[100], [100, 200, 300], [500, 500, 500, 100, 900]];
    const currents = [1, 100, 250, 9999];
    for (const window of windows) {
      for (const current of currents) {
        const p = rankPercentile(current, window);
        expect(p).not.toBeNull();
        expect(p as number).toBeGreaterThanOrEqual(0);
        expect(p as number).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is null for an empty window — no history to rank against, not a percentile of zero", () => {
    expect(rankPercentile(200, [])).toBeNull();
  });
});

describe("trend", () => {
  it("computes the exact slope for a perfectly linear rise (golden: +10/day)", () => {
    expect(trend([100, 110, 120, 130])).toEqual({ direction: "rising", slopeTenthsPerDay: 10 });
  });

  it("computes the exact slope for a perfectly linear fall (golden: -10/day)", () => {
    expect(trend([130, 120, 110, 100])).toEqual({ direction: "falling", slopeTenthsPerDay: -10 });
  });

  it("is flat with zero slope for a constant series", () => {
    expect(trend([100, 100, 100, 100])).toEqual({ direction: "flat", slopeTenthsPerDay: 0 });
  });

  it("is flat with a single data point — not enough to fit a line", () => {
    expect(trend([100])).toEqual({ direction: "flat", slopeTenthsPerDay: 0 });
  });

  it("is flat with no data at all", () => {
    expect(trend([])).toEqual({ direction: "flat", slopeTenthsPerDay: 0 });
  });
});
