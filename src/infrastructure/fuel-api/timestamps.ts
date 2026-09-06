/**
 * Every timestamp in this module is real, undocumented behaviour confirmed live against the
 * sandbox — `07_FUEL_API_INTEGRATION.md` §7.1 and `spike/scripts/lib/fuelApi.mjs`.
 *
 * The spike's own timestamp parser hardcoded a flat UTC+10 offset, explicitly flagged there as
 * unsafe once AEDT resumes (~October) — deliberately not repeated here. `date-fns-tz` resolves
 * the correct AEST/AEDT offset for any given date, which matters even more given
 * `10_PRICE_HISTORY_METHOD.md` §10.6's warning that DST days aren't 86,400 seconds.
 */
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

const SYDNEY_TZ = "Australia/Sydney";

/**
 * Builds the `requestTimeStamp` header value every price/reference-data call needs beyond the
 * bearer token — `dd/MM/yyyy hh:mm:ss AM/PM`, 12-hour clock, Sydney local time. Omitting it (or
 * `transactionID`) is what produces the undocumented `400 HeadersError`.
 */
export function buildRequestTimeStamp(now: Date): string {
  return formatInTimeZone(now, SYDNEY_TZ, "dd/MM/yyyy hh:mm:ss a").toUpperCase();
}

/**
 * Parses `lastupdated` on a price record — confirmed `dd/MM/yyyy HH:mm:ss` (24-hour clock),
 * e.g. `"26/08/2026 09:05:17"`, **not ISO 8601**. `new Date(raw)` does not parse this reliably.
 * Timezone is assumed Sydney local per §7.1 (unconfirmed against a second source, but
 * consistent with `requestTimeStamp`'s own local-time convention).
 *
 * Returns `undefined` rather than throwing on anything unparseable — malformed timestamps are
 * a per-record data-quality-gate concern (`06_DATA_ARCHITECTURE.md` §6.9's "source_reported_at
 * sane" check), not an adapter-level crash.
 */
export function parseLastUpdated(raw: string): Date | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return undefined;

  const [, dd, MM, yyyy, HH, mm, ss] = match;
  const day = Number(dd);
  const month = Number(MM);
  const year = Number(yyyy);
  const hour = Number(HH);
  const minute = Number(mm);
  const second = Number(ss);

  // Reject values regex-shaped but semantically impossible (e.g. month 13, hour 25) — fromZonedTime
  // would otherwise silently roll them into a neighbouring date/time rather than reporting them
  // as the malformed input they are.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }

  // fromZonedTime treats the given fields as wall-clock time IN the named zone and resolves the
  // correct UTC instant, accounting for whichever of AEST (+10) or AEDT (+11) actually applies
  // on that date — unlike the spike's hardcoded +10, this stays correct across the DST boundary.
  const parsed = fromZonedTime(new Date(year, month - 1, day, hour, minute, second), SYDNEY_TZ);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
