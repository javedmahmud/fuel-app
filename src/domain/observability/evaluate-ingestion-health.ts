/**
 * `20_SPRINT_PLAN.md` §20.5: the three v2-specific metrics `08_INGESTION_ARCHITECTURE.md` §8.11
 * and `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.3 both call out as mattering most — the ones
 * that catch failure modes nothing else does. Pure — no I/O, no clock, no randomness
 * (`src/domain/README.md`'s rules): every instant and every row is a parameter, fetched by the
 * repository layer and evaluated here.
 */

const LAG_ALARM_THRESHOLD_MINUTES = 90; // §13.3: "> 90 min — the primary health signal"
const JOURNAL_BACKLOG_ALARM_AGE_MINUTES = 60; // §8.11: "any row older than 1 hour"

export interface IngestionLagMetric {
  /** `null` only when there has never been a single successful price observation — a fresh
   * environment, not a lag figure of zero (which would be misleadingly reassuring). */
  lagMinutes: number | null;
  alarming: boolean;
}

/**
 * §13.3/§8.11: "the only metric that catches the failure mode where every run 'succeeds' but
 * returns nothing useful — a green dashboard with stale data is the most dangerous state this
 * system can be in." Measured from `fuel_price_observation.retrieved_at` (our pipeline's own
 * age, per that column's own doc comment — "ingestion monitoring... not for user-facing
 * freshness"), never `source_reported_at` (§6.4/§6.7: that's the price's real age, a different,
 * user-facing question this metric is not answering).
 */
export function evaluateIngestionLag(lastRetrievedAt: Date | null, now: Date): IngestionLagMetric {
  if (!lastRetrievedAt) {
    return { lagMinutes: null, alarming: true }; // no data at all is itself alarm-worthy
  }
  const lagMinutes = (now.getTime() - lastRetrievedAt.getTime()) / 60_000;
  return { lagMinutes, alarming: lagMinutes > LAG_ALARM_THRESHOLD_MINUTES };
}

export interface JournalBacklogMetric {
  /** `api_response_journal` rows with `status <> 'processed'` — awaiting parse or replay. */
  unprocessedCount: number;
  /** `null` when the backlog is empty. */
  oldestUnprocessedAgeMinutes: number | null;
  alarming: boolean;
}

/**
 * §8.11/ADR (journal-before-parse, §16 ADR "unparsed rows never auto-pruned... journal
 * .unprocessed_count must be alarmed before they age out"). The alarm is age-based, not
 * count-based — a handful of rows a few minutes old mid-parse is routine; a single row past an
 * hour means a parser has genuinely started failing, per §8.11's exact wording.
 */
export function evaluateJournalBacklog(
  unprocessedReceivedAts: readonly Date[],
  now: Date,
): JournalBacklogMetric {
  if (unprocessedReceivedAts.length === 0) {
    return { unprocessedCount: 0, oldestUnprocessedAgeMinutes: null, alarming: false };
  }
  const oldestReceivedAt = unprocessedReceivedAts.reduce((oldest, receivedAt) =>
    receivedAt.getTime() < oldest.getTime() ? receivedAt : oldest,
  );
  const oldestUnprocessedAgeMinutes = (now.getTime() - oldestReceivedAt.getTime()) / 60_000;
  return {
    unprocessedCount: unprocessedReceivedAts.length,
    oldestUnprocessedAgeMinutes,
    alarming: oldestUnprocessedAgeMinutes > JOURNAL_BACKLOG_ALARM_AGE_MINUTES,
  };
}

export interface UnexpectedInsertsMetric {
  /** Most recent full_sync runs first, however many were available (fewer than
   * `CONSECUTIVE_RUNS_FOR_SUSTAINED` early in the system's life, e.g. right after the very
   * first full_sync ever ran). */
  recentInsertedCounts: readonly number[];
  alarming: boolean;
}

/** §13.3's only other concrete "sustained" precedent in this doc pack — `ingestion.run.failed`'s
 * own alarm is "2 consecutive, same job." Reused here for the same reason: the doc says
 * "sustained > 0" for unexpected_inserts without a number, and a single non-zero run is routine
 * (a full_sync catching a handful of genuine price changes new_prices hasn't polled yet is
 * normal, not a lost window) — it's *repeated* non-zero runs that indicate new_prices is
 * consistently missing data full_sync then has to make up for. */
export const CONSECUTIVE_RUNS_FOR_SUSTAINED = 2;

/**
 * §8.5/§15.4: `full_sync`'s `insertedCount` doubles as this self-audit signal — anything full_sync
 * finds that wasn't already in `fuel_price_observation` is either genuine price movement
 * new_prices hasn't caught up to yet (routine) or evidence of a silently lost `/prices/new`
 * window (§16 ADR's "200 received but not persisted" danger case, which produces no error of
 * any kind on its own). `mostRecentFirst` must already be ordered newest-run-first and contain
 * only *successful* full_sync runs — a failed run's count means nothing about lost windows.
 */
export function evaluateUnexpectedInserts(
  mostRecentInsertedCountsFirst: readonly number[],
): UnexpectedInsertsMetric {
  const recentInsertedCounts = mostRecentInsertedCountsFirst.slice(
    0,
    CONSECUTIVE_RUNS_FOR_SUSTAINED,
  );
  const alarming =
    recentInsertedCounts.length === CONSECUTIVE_RUNS_FOR_SUSTAINED &&
    recentInsertedCounts.every((count) => count > 0);
  return { recentInsertedCounts, alarming };
}

export interface IngestionHealthReport {
  lag: IngestionLagMetric;
  journalBacklog: JournalBacklogMetric;
  unexpectedInserts: UnexpectedInsertsMetric;
  /** True if any individual metric is alarming — the single boolean a status page or `/health/data`
   * consumer needs for "is everything fine," per §13.4's own framing of that endpoint. */
  alarming: boolean;
}

export function evaluateIngestionHealth(input: {
  lastRetrievedAt: Date | null;
  unprocessedJournalReceivedAts: readonly Date[];
  mostRecentFullSyncInsertedCountsFirst: readonly number[];
  now: Date;
}): IngestionHealthReport {
  const lag = evaluateIngestionLag(input.lastRetrievedAt, input.now);
  const journalBacklog = evaluateJournalBacklog(input.unprocessedJournalReceivedAts, input.now);
  const unexpectedInserts = evaluateUnexpectedInserts(input.mostRecentFullSyncInsertedCountsFirst);
  return {
    lag,
    journalBacklog,
    unexpectedInserts,
    alarming: lag.alarming || journalBacklog.alarming || unexpectedInserts.alarming,
  };
}
