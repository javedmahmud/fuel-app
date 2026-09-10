import { describe, expect, it } from "vitest";

import { hasCoverageGap } from "./coverage-note";

describe("hasCoverageGap", () => {
  it("is false when every requested date has a rollup row and no degraded ingestion", () => {
    const gap = hasCoverageGap({
      requestedDates: ["2026-09-01", "2026-09-02", "2026-09-03"],
      rollupDates: new Set(["2026-09-01", "2026-09-02", "2026-09-03"]),
      degradedIngestionDates: new Set(),
    });
    expect(gap).toBe(false);
  });

  it("is true when a requested date has no rollup row at all", () => {
    const gap = hasCoverageGap({
      requestedDates: ["2026-09-01", "2026-09-02", "2026-09-03"],
      rollupDates: new Set(["2026-09-01", "2026-09-03"]), // 09-02 missing
      degradedIngestionDates: new Set(),
    });
    expect(gap).toBe(true);
  });

  it("is true when a date has a rollup row but the ingestion log shows it degraded", () => {
    const gap = hasCoverageGap({
      requestedDates: ["2026-09-01", "2026-09-02"],
      rollupDates: new Set(["2026-09-01", "2026-09-02"]),
      degradedIngestionDates: new Set(["2026-09-02"]),
    });
    expect(gap).toBe(true);
  });

  it("is false for an empty requested window — nothing to be missing", () => {
    const gap = hasCoverageGap({
      requestedDates: [],
      rollupDates: new Set(),
      degradedIngestionDates: new Set(),
    });
    expect(gap).toBe(false);
  });

  it("a date outside the requested window doesn't count, even if degraded or missing", () => {
    const gap = hasCoverageGap({
      requestedDates: ["2026-09-02"],
      rollupDates: new Set(["2026-09-02"]),
      degradedIngestionDates: new Set(["2026-09-01"]), // degraded, but not requested
    });
    expect(gap).toBe(false);
  });
});
