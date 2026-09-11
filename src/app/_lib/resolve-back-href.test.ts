import { describe, expect, it } from "vitest";

import { resolveBackHref } from "./resolve-back-href";

describe("resolveBackHref", () => {
  it("uses a well-formed /search?... URL as-is", () => {
    expect(resolveBackHref("/search?locality=Chatswood&fuelType=U91")).toBe(
      "/search?locality=Chatswood&fuelType=U91",
    );
  });

  it("uses a well-formed /commute?... URL as-is — feature/commute-screen", () => {
    expect(resolveBackHref("/commute?destLocality=Canberra&fuelType=U91")).toBe(
      "/commute?destLocality=Canberra&fuelType=U91",
    );
  });

  it("falls back to / when from is undefined", () => {
    expect(resolveBackHref(undefined)).toBe("/");
  });

  it("falls back to / when from is empty", () => {
    expect(resolveBackHref("")).toBe("/");
  });

  it("rejects a path that isn't /search or /commute, even if it looks close", () => {
    expect(resolveBackHref("/searching?x=1")).toBe("/");
    expect(resolveBackHref("/commuted?x=1")).toBe("/");
    expect(resolveBackHref("/stations/abc")).toBe("/");
  });

  it("rejects an absolute/external URL rather than trusting it as a redirect target", () => {
    expect(resolveBackHref("https://evil.example.com/search?x=1")).toBe("/");
    expect(resolveBackHref("//evil.example.com/search?x=1")).toBe("/");
  });

  it("rejects /search or /commute with no query string at all (must have the leading '?')", () => {
    expect(resolveBackHref("/search")).toBe("/");
    expect(resolveBackHref("/commute")).toBe("/");
  });
});
