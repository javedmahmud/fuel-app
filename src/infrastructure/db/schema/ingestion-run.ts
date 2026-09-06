import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * One row per worker job execution (`new_prices`, `full_sync`, `ref_data`, `rollup`).
 * See `06_DATA_ARCHITECTURE.md` §6.3 — without this there is no way to answer "why is this
 * price 6 hours old" (UC-08), and the journal/ledger both hang off a run for the same reason.
 *
 * `keyFingerprint` + `environmentName` added in feature/fuel-api-adapter, beyond the original
 * ERD — `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.8.1 / ADR-016: "the worker fingerprints its
 * key and records the hash with each ingestion run." A hash seen here under a different
 * environment name than before is the shared-key detection this whole mechanism exists for —
 * see `08_INGESTION_ARCHITECTURE.md` §8.4's flowchart for exactly when this check runs (right
 * after the advisory lock, before the budget guard).
 */
export const ingestionRun = pgTable(
  "ingestion_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    jobType: text("job_type", {
      enum: ["new_prices", "full_sync", "ref_data", "rollup"],
    }).notNull(),

    // skipped_budget / skipped_circuit are first-class outcomes per §7.7/§8.4's flowchart —
    // not the same as `failed`, which implies something actually went wrong during the call.
    status: text("status", {
      enum: ["running", "success", "partial", "failed", "skipped_budget", "skipped_circuit"],
    })
      .notNull()
      .default("running"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    apiCallsUsed: integer("api_calls_used").notNull().default(0),
    recordsReceived: integer("records_received").notNull().default(0),
    recordsPersisted: integer("records_persisted").notNull().default(0),
    recordsRejected: integer("records_rejected").notNull().default(0),

    failureReason: text("failure_reason"),

    /** SHA-256 of the Fuel API consumer key in use for this run — never the key itself. */
    keyFingerprint: text("key_fingerprint"),
    /** `ENVIRONMENT_NAME` the worker was started with for this run, e.g. "staging". */
    environmentName: text("environment_name"),
  },
  (table) => [
    check(
      "ingestion_run_job_type_check",
      sql`${table.jobType} in ('new_prices', 'full_sync', 'ref_data', 'rollup')`,
    ),
    check(
      "ingestion_run_status_check",
      sql`${table.status} in ('running', 'success', 'partial', 'failed', 'skipped_budget', 'skipped_circuit')`,
    ),
    // The shared-key detection query: "has this key_fingerprint ever appeared under a
    // different environment_name?" — a startup check that must run fast, every single boot.
    index("ingestion_run_key_fingerprint_idx").on(table.keyFingerprint),
  ],
);
