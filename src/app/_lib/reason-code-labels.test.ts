import { describe, expect, it } from "vitest";

import { reasonCodeBadges } from "./reason-code-labels";

describe("reasonCodeBadges", () => {
  it("returns an empty list for an empty input", () => {
    expect(reasonCodeBadges([])).toEqual([]);
  });

  it("drops WITHIN_MAX_DETOUR and the codes already narrated in the explanation sentence", () => {
    const badges = reasonCodeBadges([
      "WITHIN_MAX_DETOUR",
      "ALREADY_NEAREST_AND_CHEAPEST",
      "LOWER_EFFECTIVE_COST",
      "DETOUR_NOT_WORTH_SAVING",
    ]);
    expect(badges).toEqual([]);
  });

  it("renders the remaining codes in a fixed display order, not input order", () => {
    const badges = reasonCodeBadges([
      "CONSUMPTION_DEFAULT_ASSUMED",
      "FRESH_PRICE",
      "LOWEST_UNIT_PRICE",
    ]);
    expect(badges).toEqual([
      "Lowest price per litre",
      "Price confirmed recently",
      "Assumes average fuel use",
    ]);
  });

  it("ignores an unrecognised code rather than throwing", () => {
    expect(reasonCodeBadges(["NOT_A_REAL_CODE"])).toEqual([]);
  });
});
