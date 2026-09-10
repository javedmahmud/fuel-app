/**
 * `21_DETAILED_DESIGN.md` §21.1's history endpoint: "The series is observed history, not a
 * complete change log — say so in the response, not just in this doc... The response body
 * carries a `coverageNote` field (a short fixed string, not freeform) whenever the requested
 * window includes a day the ingestion log shows as degraded or missing." Pure — no I/O, no
 * clock (`src/domain/README.md`'s rules): every date set is a parameter, built by the
 * repository/application layers from `daily_price_rollup` and `ingestion_run`.
 */

/** The one fixed string this ever emits — never freeform, per §21.1's explicit requirement. */
export const COVERAGE_NOTE_TEXT =
  "Some days in this window had missing or degraded price collection — this history reflects the price changes we actually observed, not a complete record.";

export interface CoverageGapInput {
  /** Every Sydney calendar date (`yyyy-MM-dd`) in the requested history window, ascending. */
  requestedDates: readonly string[];
  /** Dates that have a `daily_price_rollup` row for this station/fuel type — a date's absence
   * here is a genuine gap, not a legitimate "no price change that day" row (which still has a
   * row, just with `observationCount = 0`; §10.4 case A is not a gap). */
  rollupDates: ReadonlySet<string>;
  /** Dates the ingestion log (`ingestion_run`) shows a degraded `new_prices`/`full_sync` run
   * for — even when a rollup row still exists for that date, per §21.1's "degraded or missing"
   * wording naming both cases separately. */
  degradedIngestionDates: ReadonlySet<string>;
}

/** True the moment any single requested date is missing a rollup row or has a degraded
 * ingestion run — one bad day is enough to caveat the whole window honestly, per §10.1a's "a
 * missed cycle is gone permanently, not backfillable." */
export function hasCoverageGap(input: CoverageGapInput): boolean {
  return input.requestedDates.some(
    (date) => !input.rollupDates.has(date) || input.degradedIngestionDates.has(date),
  );
}
