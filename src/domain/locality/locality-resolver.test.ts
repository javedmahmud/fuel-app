import { describe, expect, it } from "vitest";
import { resolveLocality, suggestLocalities, type LocalityEntry } from "./locality-resolver";

const localities: LocalityEntry[] = [
  { name: "Sydney", latitude: -33.8698, longitude: 151.21 },
  { name: "Newtown (NSW)", latitude: -33.8976, longitude: 151.1804 },
  { name: "Bondi Beach", latitude: -33.8909, longitude: 151.2739 },
  { name: "Bondi Junction", latitude: -33.893, longitude: 151.25 },
];

describe("resolveLocality", () => {
  it("resolves an exact match", () => {
    expect(resolveLocality("Sydney", localities)).toEqual({
      name: "Sydney",
      latitude: -33.8698,
      longitude: 151.21,
      matchType: "exact",
    });
  });

  it("resolves a case-insensitive match when the exact casing doesn't hit", () => {
    expect(resolveLocality("sydney", localities)).toEqual({
      name: "Sydney",
      latitude: -33.8698,
      longitude: 151.21,
      matchType: "case_insensitive",
    });
  });

  it("resolves after trimming surrounding whitespace", () => {
    expect(resolveLocality("  Sydney  ", localities)?.name).toBe("Sydney");
  });

  it("prefers an exact match over a case-insensitive one when the dataset technically has both possible", () => {
    // Same name, different casing, both present — exact match must win, not whichever the
    // dataset happens to list first.
    const withDuplicateCasing: LocalityEntry[] = [
      { name: "sydney", latitude: 1, longitude: 1 },
      { name: "Sydney", latitude: -33.8698, longitude: 151.21 },
    ];
    expect(resolveLocality("Sydney", withDuplicateCasing)).toEqual({
      name: "Sydney",
      latitude: -33.8698,
      longitude: 151.21,
      matchType: "exact",
    });
  });

  it("is undefined for a locality name not in the dataset", () => {
    expect(resolveLocality("Nowhereville", localities)).toBeUndefined();
  });

  it("is undefined for an empty or whitespace-only query", () => {
    expect(resolveLocality("", localities)).toBeUndefined();
    expect(resolveLocality("   ", localities)).toBeUndefined();
  });

  it("does not partial-match — 'Bondi' alone must not resolve to 'Bondi Beach'", () => {
    expect(resolveLocality("Bondi", localities)).toBeUndefined();
  });

  it("is undefined against an empty dataset", () => {
    expect(resolveLocality("Sydney", [])).toBeUndefined();
  });
});

describe("suggestLocalities", () => {
  it("returns every locality whose name starts with the query, case-insensitively", () => {
    const results = suggestLocalities("bondi", localities);
    expect(results.map((r) => r.name)).toEqual(["Bondi Beach", "Bondi Junction"]);
  });

  it("respects the limit", () => {
    const results = suggestLocalities("bondi", localities, 1);
    expect(results).toHaveLength(1);
  });

  it("is empty for an empty query", () => {
    expect(suggestLocalities("", localities)).toEqual([]);
  });

  it("is empty when nothing matches", () => {
    expect(suggestLocalities("zzz", localities)).toEqual([]);
  });

  it("does not match a substring that isn't a prefix", () => {
    // "town" is a substring of "Newtown (NSW)" but not a prefix — must not match.
    expect(suggestLocalities("town", localities)).toEqual([]);
  });
});
