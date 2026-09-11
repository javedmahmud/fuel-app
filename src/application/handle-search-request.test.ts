import { describe, expect, it } from "vitest";

import { resolveDisplayLimit } from "./handle-search-request";

describe("resolveDisplayLimit", () => {
  it("defaults to 5 when unspecified — real feedback that an unbounded list is overwhelming", () => {
    expect(resolveDisplayLimit(undefined)).toBe(5);
  });

  it("treats an explicit '5' the same as unspecified", () => {
    expect(resolveDisplayLimit("5")).toBe(5);
  });

  it("resolves '10' to 10", () => {
    expect(resolveDisplayLimit("10")).toBe(10);
  });

  it("resolves 'all' to the §13.9 result cap (50), not literally unlimited", () => {
    expect(resolveDisplayLimit("all")).toBe(50);
  });
});
