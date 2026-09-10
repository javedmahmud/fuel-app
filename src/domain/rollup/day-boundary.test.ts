import { describe, expect, it } from "vitest";
import {
  previousSydneyDate,
  sydneyDateOf,
  sydneyDateRangeEndingAt,
  sydneyDayBoundary,
} from "./day-boundary";

describe("sydneyDayBoundary", () => {
  it("returns a 24h span on an ordinary day", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-09-08");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("returns a 25h span on the AEDT->AEST transition day (clocks back, §10.6 case H)", () => {
    // Confirmed live against date-fns-tz: first Sunday of April 2026 is 2026-04-05.
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-04-05");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("returns a 23h span on the AEST->AEDT transition day (clocks forward, §10.6 case H)", () => {
    // Confirmed live: first Sunday of October 2026 is 2026-10-04.
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-10-04");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("dayStart is midnight Sydney local time, correctly offset from UTC", () => {
    // AEST (non-DST) is UTC+10 — 2026-06-15T00:00 Sydney is 2026-06-14T14:00 UTC.
    const { dayStart } = sydneyDayBoundary("2026-06-15");
    expect(dayStart.toISOString()).toBe("2026-06-14T14:00:00.000Z");
  });

  it("rolls over cleanly across a month boundary", () => {
    const { dayEnd } = sydneyDayBoundary("2026-01-31");
    expect(sydneyDateOf(dayEnd)).toBe("2026-02-01");
  });

  it("rejects a non yyyy-MM-dd string rather than silently misparsing it", () => {
    expect(() => sydneyDayBoundary("08/09/2026")).toThrow();
  });
});

describe("sydneyDateOf", () => {
  it("attributes an instant to its Sydney calendar day, not its UTC day", () => {
    // 2026-06-14T23:30 UTC is 2026-06-15T09:30 AEST — the next UTC day already, but still the
    // same Sydney day as anything from 2026-06-14T14:00 UTC onward.
    expect(sydneyDateOf(new Date("2026-06-14T23:30:00.000Z"))).toBe("2026-06-15");
    expect(sydneyDateOf(new Date("2026-06-14T13:59:59.000Z"))).toBe("2026-06-14");
  });
});

describe("previousSydneyDate", () => {
  it("steps back one calendar day", () => {
    expect(previousSydneyDate("2026-09-08")).toBe("2026-09-07");
  });

  it("rolls back across a month/year boundary", () => {
    expect(previousSydneyDate("2026-01-01")).toBe("2025-12-31");
    expect(previousSydneyDate("2026-03-01")).toBe("2026-02-28");
  });
});

describe("sydneyDateRangeEndingAt", () => {
  it("returns count consecutive dates, ascending, ending at the given date", () => {
    expect(sydneyDateRangeEndingAt("2026-09-08", 3)).toEqual([
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
    ]);
  });

  it("returns exactly the end date for count 1", () => {
    expect(sydneyDateRangeEndingAt("2026-09-08", 1)).toEqual(["2026-09-08"]);
  });

  it("rolls back across a month/year boundary", () => {
    expect(sydneyDateRangeEndingAt("2026-01-02", 4)).toEqual([
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
    ]);
  });
});
