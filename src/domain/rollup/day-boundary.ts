/**
 * `10_PRICE_HISTORY_METHOD.md` §10.6: "Days are calendar days in Australia/Sydney, because that
 * is what 'the price on Tuesday' means to a user... always divide by the actual elapsed seconds
 * of the interval set" — never a hard-coded 86,400. `fromZonedTime` resolves the correct
 * AEST/AEDT offset for the given date, so on the two DST transition days a year the returned
 * `dayEnd - dayStart` is genuinely 23h or 25h, not 24h — same library and pattern already used
 * by `fuel-api/timestamps.ts` for the same reason.
 */
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

const SYDNEY_TZ = "Australia/Sydney";

/** `yyyy-MM-dd`, unambiguous about which calendar day it names regardless of the reader's own
 * timezone — never a `Date`, which would silently carry an implicit (and here, wrong) timezone. */
export type SydneyDateString = string;

export interface DayBoundary {
  /** UTC instant of local midnight at the start of the day. */
  dayStart: Date;
  /** UTC instant of local midnight at the start of the *next* day — exclusive upper bound. */
  dayEnd: Date;
}

function parseDateString(dateStr: SydneyDateString): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(`sydneyDayBoundary: "${dateStr}" is not a yyyy-MM-dd date string.`);
  }
  const [, y, m, d] = match;
  return { year: Number(y), month: Number(m), day: Number(d) };
}

/**
 * The UTC instants bounding one Sydney calendar day — `[dayStart, dayEnd)`. `day + 1` overflows
 * cleanly (JS `Date` normalises e.g. day 32 of a 31-day month into the 1st of the next month),
 * so this works across month and year boundaries without separate handling.
 */
export function sydneyDayBoundary(dateStr: SydneyDateString): DayBoundary {
  const { year, month, day } = parseDateString(dateStr);
  const dayStart = fromZonedTime(new Date(year, month - 1, day, 0, 0, 0, 0), SYDNEY_TZ);
  const dayEnd = fromZonedTime(new Date(year, month - 1, day + 1, 0, 0, 0, 0), SYDNEY_TZ);
  return { dayStart, dayEnd };
}

/** The Sydney calendar date (`yyyy-MM-dd`) a UTC instant falls on — e.g. for grouping
 * observations by the local day they belong to, not the UTC day. */
export function sydneyDateOf(instant: Date): SydneyDateString {
  return formatInTimeZone(instant, SYDNEY_TZ, "yyyy-MM-dd");
}

/** The previous calendar date string, in the same `yyyy-MM-dd` shape — plain calendar-day
 * arithmetic (no timezone conversion needed, since both ends are already Sydney-local dates). */
export function previousSydneyDate(dateStr: SydneyDateString): SydneyDateString {
  const { year, month, day } = parseDateString(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day - 1));
  return d.toISOString().slice(0, 10);
}
