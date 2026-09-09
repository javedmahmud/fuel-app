import { describe, expect, it } from "vitest";
import { isFreshEnoughForEligibility, pipelineHealthBand, priceAgeBand } from "./freshness";

const now = new Date("2026-09-09T12:00:00Z");
function minutesAgo(minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}
function hoursAgo(hours: number): Date {
  return minutesAgo(hours * 60);
}
function daysAgo(days: number): Date {
  return hoursAgo(days * 24);
}

describe("pipelineHealthBand", () => {
  it("is healthy well within 30 minutes", () => {
    expect(pipelineHealthBand(minutesAgo(10), now)).toBe("healthy");
  });

  it("is healthy at exactly 30 minutes", () => {
    expect(pipelineHealthBand(minutesAgo(30), now)).toBe("healthy");
  });

  it("is delayed just past 30 minutes", () => {
    expect(pipelineHealthBand(minutesAgo(31), now)).toBe("delayed");
  });

  it("is delayed at exactly 120 minutes", () => {
    expect(pipelineHealthBand(minutesAgo(120), now)).toBe("delayed");
  });

  it("is stale just past 120 minutes", () => {
    expect(pipelineHealthBand(minutesAgo(121), now)).toBe("stale");
  });

  it("is stale when nothing has ever been ingested", () => {
    expect(pipelineHealthBand(null, now)).toBe("stale");
  });

  it("respects a custom threshold config", () => {
    expect(
      pipelineHealthBand(minutesAgo(45), now, { healthyMaxMinutes: 60, delayedMaxMinutes: 90 }),
    ).toBe("healthy");
  });
});

describe("priceAgeBand", () => {
  it("is current for a price reported an hour ago", () => {
    expect(priceAgeBand(hoursAgo(1), now)).toBe("current");
  });

  it("is current at exactly 48 hours — the doc's own boundary", () => {
    expect(priceAgeBand(hoursAgo(48), now)).toBe("current");
  });

  it("is ageing just past 48 hours", () => {
    expect(priceAgeBand(hoursAgo(49), now)).toBe("ageing");
  });

  it("is ageing at exactly 7 days", () => {
    expect(priceAgeBand(daysAgo(7), now)).toBe("ageing");
  });

  it("is long_unchanged just past 7 days", () => {
    expect(priceAgeBand(new Date(daysAgo(7).getTime() - 1), now)).toBe("long_unchanged");
  });

  it("is long_unchanged for a price unchanged for months — still a completely valid state, not an error", () => {
    expect(priceAgeBand(daysAgo(90), now)).toBe("long_unchanged");
  });
});

describe("isFreshEnoughForEligibility", () => {
  it("is eligible for a price reported today", () => {
    expect(isFreshEnoughForEligibility(hoursAgo(2), now)).toBe(true);
  });

  it("is eligible at exactly the 14-day cutoff", () => {
    expect(isFreshEnoughForEligibility(daysAgo(14), now)).toBe(true);
  });

  it("is not eligible just past 14 days", () => {
    expect(isFreshEnoughForEligibility(new Date(daysAgo(14).getTime() - 1), now)).toBe(false);
  });

  it("respects a custom cutoff", () => {
    expect(isFreshEnoughForEligibility(daysAgo(20), now, 30)).toBe(true);
  });
});
