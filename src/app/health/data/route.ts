/**
 * `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.4: "the one a human looks at" — the operator/status
 * page endpoint, and the natural backing endpoint for a public status indicator during a UC-08
 * outage. `15_SEQUENCE_DIAGRAMS.md`'s outage walkthrough reads this exact endpoint
 * ("Web->>DB: /health/data → lag = 95 min") to decide whether to show the "data is delayed"
 * banner — this is that lookup made real.
 *
 * Deliberately not `/health/live` or `/health/ready` — those answer "is the process/DB up,"
 * unrelated to the three ingestion-health metrics this branch scopes to
 * (`20_SPRINT_PLAN.md` §20.5). Always live, never cached (`export const dynamic`): stale health
 * data defeats the entire point of the endpoint.
 */
import { NextResponse } from "next/server";

import {
  evaluateIngestionHealth,
  CONSECUTIVE_RUNS_FOR_SUSTAINED,
} from "../../../domain/observability/evaluate-ingestion-health";
import { getDb } from "../../../infrastructure/db/client";
import {
  loadLastRetrievedAt,
  loadRecentFullSyncInsertedCounts,
  loadUnprocessedJournalReceivedAts,
} from "../../../infrastructure/repositories/observability-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const now = new Date();

  const [lastRetrievedAt, unprocessedJournalReceivedAts, recentFullSyncInsertedCounts] =
    await Promise.all([
      loadLastRetrievedAt(db),
      loadUnprocessedJournalReceivedAts(db),
      loadRecentFullSyncInsertedCounts(db, CONSECUTIVE_RUNS_FOR_SUSTAINED),
    ]);

  const report = evaluateIngestionHealth({
    lastRetrievedAt,
    unprocessedJournalReceivedAts,
    mostRecentFullSyncInsertedCountsFirst: recentFullSyncInsertedCounts,
    now,
  });

  // Always 200: this is informational content for an operator/status page (§13.4), not a
  // traffic-admission gate like /health/ready — the web service itself is fine even when
  // ingestion is alarming, so a non-2xx here would be a false "the service is down" signal to
  // anything watching HTTP status alone. `alarming` in the body is the real signal to act on.
  return NextResponse.json({
    timestamp: now.toISOString(),
    alarming: report.alarming,
    metrics: {
      // §13.3: "> 90 min — the primary health signal."
      ingestionLagMinutes: {
        value: report.lag.lagMinutes,
        alarmThresholdMinutes: 90,
        alarming: report.lag.alarming,
      },
      // §8.11: "any row older than 1 hour."
      journalBacklog: {
        unprocessedCount: report.journalBacklog.unprocessedCount,
        oldestUnprocessedAgeMinutes: report.journalBacklog.oldestUnprocessedAgeMinutes,
        alarmThresholdMinutes: 60,
        alarming: report.journalBacklog.alarming,
      },
      // §8.11: "sustained > 0 — indicates lost windows." See evaluate-ingestion-health.ts's own
      // comment for what "sustained" means here (2 consecutive non-zero runs).
      fullSyncUnexpectedInserts: {
        recentInsertedCountsMostRecentFirst: report.unexpectedInserts.recentInsertedCounts,
        alarming: report.unexpectedInserts.alarming,
      },
    },
  });
}
