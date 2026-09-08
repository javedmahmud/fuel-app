import { fromZonedTime } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import { computeDailyRollup, type RollupObservation } from "./compute-daily-rollup";
import { sydneyDayBoundary } from "./day-boundary";

const SYDNEY_TZ = "Australia/Sydney";

/** Builds a UTC `Date` from Sydney-local wall-clock fields — the same convention
 * `fuel-api/timestamps.ts` uses for real observation timestamps. */
function sydney(y: number, m: number, d: number, hh: number, mm: number, ss = 0): Date {
  return fromZonedTime(new Date(y, m - 1, d, hh, mm, ss), SYDNEY_TZ);
}

function obs(
  priceTenthsCpl: number,
  sourceReportedAt: Date,
  retrievedAt?: Date,
): RollupObservation {
  return { priceTenthsCpl, sourceReportedAt, retrievedAt: retrievedAt ?? sourceReportedAt };
}

// §10.4 case E ("observation timestamped in the future") is deliberately not exercised here —
// the doc is explicit that it's rejected upstream by the data-quality gate (§8.10) and should
// never reach this pure function at all.

describe("computeDailyRollup — §10.3 worked example, to the exact cent", () => {
  it("matches the doc's hand-worked figure of 177.6 c/L (1776 tenths), not the naive mean", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    const observations = [
      obs(1799, sydney(2026, 6, 14, 20, 0, 0)), // opening price, carried from the prior day
      obs(1759, sydney(2026, 6, 15, 10, 12, 0)),
      obs(1729, sydney(2026, 6, 15, 15, 43, 0)),
      obs(1769, sydney(2026, 6, 15, 18, 2, 0)),
    ];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.timeWeightedAvgTenths).toBe(1776); // doc: "15,341,100 / 86,400 = 177.6 c/L"
    expect(result.openTenthsCpl).toBe(1799);
    expect(result.closeTenthsCpl).toBe(1769);
    expect(result.minTenthsCpl).toBe(1729);
    expect(result.maxTenthsCpl).toBe(1799);
    expect(result.observationCount).toBe(3);
    expect(result.carriedForward).toBe(true);
    expect(result.partialDay).toBe(false);

    // The regression this whole document exists to prevent: a naive mean of just the day's
    // change events ignores the carried-forward opening price and duration entirely.
    const naiveMeanTenths = Math.round((1759 + 1729 + 1769) / 3); // doc: "175.2" — wrong by 2.4c
    expect(naiveMeanTenths).toBe(1752);
    expect(result.timeWeightedAvgTenths).not.toBe(naiveMeanTenths);
  });
});

describe("computeDailyRollup — §10.4 edge cases", () => {
  it("case A: no observations on the day — carries the opening price across the whole day", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    const observations = [obs(1500, sydney(2026, 6, 10, 9, 0, 0))];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.observationCount).toBe(0);
    expect(result.carriedForward).toBe(true);
    expect(result.timeWeightedAvgTenths).toBe(1500);
    expect(result.openTenthsCpl).toBe(1500);
    expect(result.closeTenthsCpl).toBe(1500);
    expect(result.minTenthsCpl).toBe(1500);
    expect(result.maxTenthsCpl).toBe(1500);
  });

  it("case B: opening price is weeks old — still carried forward, with its age reported", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    const openingAt = sydney(2026, 5, 4, 12, 0, 0); // 41.5 days before 2026-06-15T00:00 local
    const observations = [obs(1500, openingAt)];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.carriedForward).toBe(true);
    expect(result.openingPriceAgeDays).toBe(41); // floored elapsed days, not calendar-date subtraction
    expect(result.timeWeightedAvgTenths).toBe(1500); // still a completely valid figure
  });

  it("case C: no prior observation at all — skips the day rather than fabricating a partial average", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    // Only observations during/after the day — nothing before dayStart to open from.
    const observations = [obs(1500, sydney(2026, 6, 15, 10, 0, 0))];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result).toEqual({ skipped: true, reason: "no_prior_observation" });
  });

  it("case D: identical source_reported_at — the later-retrieved_at record wins, at the opening boundary", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    const tiedAt = sydney(2026, 6, 10, 9, 0, 0);
    const observations = [
      obs(1400, tiedAt, sydney(2026, 6, 10, 9, 0, 5)), // fetched first, wrong/superseded
      obs(1500, tiedAt, sydney(2026, 6, 10, 9, 5, 0)), // fetched later — this one should win
    ];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.openTenthsCpl).toBe(1500);
  });

  it("case D: identical source_reported_at during the day — the earlier one contributes a zero-length interval", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    const openingAt = sydney(2026, 6, 10, 9, 0, 0);
    const tiedAt = sydney(2026, 6, 15, 12, 0, 0);
    const observations = [
      obs(1000, openingAt),
      obs(1600, tiedAt, sydney(2026, 6, 15, 12, 0, 1)), // stale write, superseded
      obs(1700, tiedAt, sydney(2026, 6, 15, 12, 0, 9)), // later retrieved_at — this one wins
    ];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.observationCount).toBe(1); // the duplicate was discarded, not double-counted
    expect(result.closeTenthsCpl).toBe(1700);
    expect(result.maxTenthsCpl).toBe(1700);
    expect(result.minTenthsCpl).toBe(1000); // 1600 never had any duration to be a candidate
  });

  it("case F: station deactivated mid-day — weights only up to deactivation and flags partial_day", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    const observations = [
      obs(1000, sydney(2026, 6, 10, 9, 0, 0)),
      obs(1200, sydney(2026, 6, 15, 6, 0, 0)), // before deactivation — counts
      obs(9999, sydney(2026, 6, 15, 20, 0, 0)), // after deactivation — must be ignored entirely
    ];
    const deactivatedAt = sydney(2026, 6, 15, 12, 0, 0); // noon — exactly half the day

    const result = computeDailyRollup({ observations, dayStart, dayEnd, deactivatedAt });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.partialDay).toBe(true);
    expect(result.observationCount).toBe(1); // only the 06:00 change; the post-deactivation row is invisible
    expect(result.closeTenthsCpl).toBe(1200);
    expect(result.maxTenthsCpl).toBe(1200);
    // 1000 from 00:00-06:00 (21,600s) + 1200 from 06:00-12:00 (21,600s) — an exact 50/50 split.
    expect(result.timeWeightedAvgTenths).toBe(1100);
  });

  it("defensive: a station deactivated at or before dayStart yields no valid interval — skipped, not a bogus zero-duration average", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    const observations = [obs(1000, sydney(2026, 6, 10, 9, 0, 0))];

    const result = computeDailyRollup({
      observations,
      dayStart,
      dayEnd,
      deactivatedAt: dayStart,
    });

    expect(result).toEqual({ skipped: true, reason: "deactivated_before_day" });
  });

  it("case G: a price returning to a previous value is an ordinary change event, nothing special", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
    const observations = [
      obs(1000, sydney(2026, 6, 10, 9, 0, 0)),
      obs(1200, sydney(2026, 6, 15, 8, 0, 0)),
      obs(1000, sydney(2026, 6, 15, 16, 0, 0)), // back to the opening price
    ];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.observationCount).toBe(2);
    expect(result.openTenthsCpl).toBe(1000);
    expect(result.closeTenthsCpl).toBe(1000);
    expect(result.maxTenthsCpl).toBe(1200);
    // 00:00-08:00 (28,800s) @1000 + 08:00-16:00 (28,800s) @1200 + 16:00-24:00 (28,800s) @1000
    // — an exact three-way split of equal thirds.
    expect(result.timeWeightedAvgTenths).toBe(Math.round((1000 + 1200 + 1000) / 3));
  });

  it("case H: DST clocks-back day (25h, 2026-04-05) divides by actual elapsed seconds, not 86,400", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-04-05");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(25 * 60 * 60 * 1000); // sanity on the fixture itself

    const observations = [
      obs(1000, sydney(2026, 3, 20, 9, 0, 0)),
      // The one change event lands 80,000s (22h13m20s) after dayStart, leaving 10,000s to dayEnd
      // — chosen so a hardcoded ÷86,400 divisor would silently produce a different (wrong)
      // figure than the correct ÷90,000 (the real length of this 25h day).
      obs(2000, new Date(dayStart.getTime() + 80_000 * 1000)),
    ];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    const expected = Math.round((1000 * 80_000 + 2000 * 10_000) / 90_000);
    expect(expected).toBe(1111);
    expect(result.timeWeightedAvgTenths).toBe(1111);
    // What a hardcoded-86,400 bug would have produced instead — proof the two are distinguishable.
    expect(Math.round((1000 * 80_000 + 2000 * 10_000) / 86_400)).not.toBe(
      result.timeWeightedAvgTenths,
    );
  });

  it("case H: DST clocks-forward day (23h, 2026-10-04) divides by actual elapsed seconds, not 86,400", () => {
    const { dayStart, dayEnd } = sydneyDayBoundary("2026-10-04");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(23 * 60 * 60 * 1000);

    const observations = [
      obs(1000, sydney(2026, 9, 20, 9, 0, 0)),
      // 60,000s in, leaving 22,800s of this day's real 82,800s total.
      obs(2000, new Date(dayStart.getTime() + 60_000 * 1000)),
    ];

    const result = computeDailyRollup({ observations, dayStart, dayEnd });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    const expected = Math.round((1000 * 60_000 + 2000 * 22_800) / 82_800);
    expect(result.timeWeightedAvgTenths).toBe(expected);
    expect(Math.round((1000 * 60_000 + 2000 * 22_800) / 86_400)).not.toBe(
      result.timeWeightedAvgTenths,
    );
  });
});

describe("computeDailyRollup — a month of synthetic data, correct answer known by construction", () => {
  it("reproduces every day's hand-computable open/close/average across June 2026", () => {
    const basePriceTenths = 1000;
    const stepTenths = 5;
    const daysInMonth = 30;

    // One change event at local noon every day, moving the price up by `stepTenths` — noon
    // splits a 24h (non-DST — June is deep in Sydney winter) day exactly in half, so each day's
    // correct time-weighted average is trivially (open + close) / 2, computed independently of
    // computeDailyRollup itself, not by re-deriving its own formula.
    const seed = obs(basePriceTenths, sydney(2026, 5, 31, 9, 0, 0));
    const noonEvents: RollupObservation[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      noonEvents.push(obs(basePriceTenths + day * stepTenths, sydney(2026, 6, day, 12, 0, 0)));
    }
    const allObservations = [seed, ...noonEvents];

    for (let day = 1; day <= daysInMonth; day++) {
      const { dayStart, dayEnd } = sydneyDayBoundary(`2026-06-${String(day).padStart(2, "0")}`);
      const visibleObservations = allObservations.filter((o) => o.sourceReportedAt < dayEnd);

      const result = computeDailyRollup({ observations: visibleObservations, dayStart, dayEnd });

      const expectedOpen = basePriceTenths + (day - 1) * stepTenths;
      const expectedClose = basePriceTenths + day * stepTenths;

      expect(result.skipped).toBe(false);
      if (result.skipped) throw new Error(`day ${day} unexpectedly skipped`);
      expect(result.openTenthsCpl).toBe(expectedOpen);
      expect(result.closeTenthsCpl).toBe(expectedClose);
      expect(result.observationCount).toBe(1);
      expect(result.timeWeightedAvgTenths).toBe(Math.round((expectedOpen + expectedClose) / 2));
      expect(result.carriedForward).toBe(true);
      expect(result.partialDay).toBe(false);
    }
  });
});
