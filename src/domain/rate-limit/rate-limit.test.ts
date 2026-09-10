import { describe, expect, it } from "vitest";
import { computeWindowStart, isWithinRateLimit } from "./rate-limit";

describe("computeWindowStart", () => {
  it("floors to the epoch-aligned start of a 60s window", () => {
    expect(computeWindowStart(new Date("2026-09-10T14:32:47.500Z"), 60)).toEqual(
      new Date("2026-09-10T14:32:00.000Z"),
    );
  });

  it("is idempotent for two timestamps in the same window", () => {
    const a = computeWindowStart(new Date("2026-09-10T14:32:01Z"), 60);
    const b = computeWindowStart(new Date("2026-09-10T14:32:59Z"), 60);
    expect(a).toEqual(b);
  });

  it("moves to a new window right at the boundary", () => {
    const justBefore = computeWindowStart(new Date("2026-09-10T14:32:59.999Z"), 60);
    const atBoundary = computeWindowStart(new Date("2026-09-10T14:33:00.000Z"), 60);
    expect(justBefore).not.toEqual(atBoundary);
    expect(atBoundary).toEqual(new Date("2026-09-10T14:33:00.000Z"));
  });

  it("works for a non-60s window size", () => {
    expect(computeWindowStart(new Date("2026-09-10T14:32:47Z"), 3600)).toEqual(
      new Date("2026-09-10T14:00:00.000Z"),
    );
  });
});

describe("isWithinRateLimit", () => {
  it("is true when the count is at or under the max", () => {
    expect(isWithinRateLimit(1, 60)).toBe(true);
    expect(isWithinRateLimit(60, 60)).toBe(true);
  });

  it("is false once the count exceeds the max", () => {
    expect(isWithinRateLimit(61, 60)).toBe(false);
  });
});
