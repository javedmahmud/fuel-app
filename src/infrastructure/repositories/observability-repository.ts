import { and, desc, eq, gte, inArray, lt, max, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { sydneyDateOf } from "../../domain/rollup/day-boundary";
import { apiResponseJournal, fuelPriceObservation, ingestionRun } from "../db/schema";

type ReadDb = Pick<PostgresJsDatabase, "select">;

/**
 * `08_INGESTION_ARCHITECTURE.md` §8.11 / `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.3's raw
 * inputs — one small, targeted query per metric, feeding `domain/observability/
 * evaluate-ingestion-health.ts`'s pure evaluators. None of these scan the full history of any
 * table: the retrieved_at max uses `observation_retrieved_at_idx`, the journal query uses
 * `journal_unprocessed_idx` (built specifically to keep this cheap even once most rows are
 * long since processed), and the full_sync lookup is bounded by `limit`.
 */

/** `fuel_price_observation.retrieved_at`'s own doc comment: "ingestion monitoring... not for
 * user-facing freshness" — this is exactly that monitoring use. `null` means no observation has
 * ever been persisted (a fresh environment), not "no lag." */
export async function loadLastRetrievedAt(db: ReadDb): Promise<Date | null> {
  const [row] = await db
    .select({ lastRetrievedAt: max(fuelPriceObservation.retrievedAt) })
    .from(fuelPriceObservation);
  return row?.lastRetrievedAt ?? null;
}

/** Every row still awaiting parse or replay (`status <> 'processed'`) — §8.11's alarm is
 * age-based, so the evaluator needs each row's own `received_at`, not just a count. */
export async function loadUnprocessedJournalReceivedAts(db: ReadDb): Promise<Date[]> {
  const rows = await db
    .select({ receivedAt: apiResponseJournal.receivedAt })
    .from(apiResponseJournal)
    .where(ne(apiResponseJournal.status, "processed"));
  return rows.map((r) => r.receivedAt);
}

/** Most-recent-first `records_persisted` for successful `full_sync` runs — full_sync's
 * `insertedCount` doubling as this self-audit signal per `persist-observations.ts`'s own
 * comment. Only `status = 'success'` runs count: a failed run's count says nothing about lost
 * windows. */
export async function loadRecentFullSyncInsertedCounts(
  db: ReadDb,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .select({ recordsPersisted: ingestionRun.recordsPersisted })
    .from(ingestionRun)
    .where(and(eq(ingestionRun.jobType, "full_sync"), eq(ingestionRun.status, "success")))
    .orderBy(desc(ingestionRun.finishedAt))
    .limit(limit);
  return rows.map((r) => r.recordsPersisted);
}

/** §21.1's history endpoint (UC-06): Sydney calendar dates with a `new_prices`/`full_sync` run
 * that didn't fully succeed (`failed`/`partial`/`skipped_budget`/`skipped_circuit`) — the
 * `coverageNote` "degraded" half, feeding `domain/rollup/coverage-note.ts`'s `hasCoverageGap`.
 * `ref_data`/`rollup` runs are excluded: they don't fetch prices, so their own health says
 * nothing about a gap in *price* coverage. Keyed by `started_at`, not `finished_at` — a run that
 * degraded partway through still started on the day it was trying to cover. */
export async function loadDegradedIngestionDates(
  db: ReadDb,
  since: Date,
  until: Date,
): Promise<Set<string>> {
  const rows = await db
    .select({ startedAt: ingestionRun.startedAt })
    .from(ingestionRun)
    .where(
      and(
        inArray(ingestionRun.jobType, ["new_prices", "full_sync"]),
        inArray(ingestionRun.status, ["failed", "partial", "skipped_budget", "skipped_circuit"]),
        gte(ingestionRun.startedAt, since),
        lt(ingestionRun.startedAt, until),
      ),
    );
  return new Set(rows.map((r) => sydneyDateOf(r.startedAt)));
}
