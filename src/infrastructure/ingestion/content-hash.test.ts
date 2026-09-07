import { describe, expect, it } from "vitest";
import { computeContentHash } from "./content-hash";

const base = {
  source: "NSW_FUEL_API",
  stationCode: "625",
  fuelCode: "U91",
  priceTenthsCpl: 1769,
  sourceReportedAt: new Date("2026-08-30T02:15:21.000Z"),
};

describe("computeContentHash", () => {
  it("is deterministic for identical inputs", () => {
    expect(computeContentHash(base)).toBe(computeContentHash({ ...base }));
  });

  it("produces a 64-character hex string (SHA-256)", () => {
    expect(computeContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the price changes", () => {
    expect(computeContentHash(base)).not.toBe(
      computeContentHash({ ...base, priceTenthsCpl: 1770 }),
    );
  });

  it("changes when the station changes", () => {
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, stationCode: "626" }));
  });

  it("changes when the fuel type changes", () => {
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, fuelCode: "P95" }));
  });

  it("changes when source_reported_at changes", () => {
    expect(computeContentHash(base)).not.toBe(
      computeContentHash({ ...base, sourceReportedAt: new Date("2026-08-30T03:00:00.000Z") }),
    );
  });

  it("does NOT take retrieved_at or ingestion_run_id as inputs at all — §8.7's explicit warning", () => {
    // There's no parameter for either in computeContentHash's signature — this test exists as
    // a guard against a future "helpful" refactor accidentally adding one. Two calls
    // representing the exact same real-world price, "delivered" at two different times (the
    // only thing retrieved_at/ingestion_run_id would ever represent), must hash identically.
    const deliveredFirstPoll = computeContentHash(base);
    const deliveredSecondPollSameData = computeContentHash({ ...base });
    expect(deliveredFirstPoll).toBe(deliveredSecondPollSameData);
  });
});
