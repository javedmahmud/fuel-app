import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * One row per worker job execution (`new_prices`, `full_sync`, `ref_data`, `rollup`).
 * See `06_DATA_ARCHITECTURE.md` §6.3 — without this there is no way to answer "why is this
 * price 6 hours old" (UC-08), and the journal/ledger both hang off a run for the same reason.
 */
export const ingestionRun = pgTable(
  "ingestion_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    jobType: text("job_type", {
      enum: ["new_prices", "full_sync", "ref_data", "rollup"],
    }).notNull(),

    status: text("status", {
      enum: ["running", "success", "partial", "failed"],
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
  },
  (table) => [
    check(
      "ingestion_run_job_type_check",
      sql`${table.jobType} in ('new_prices', 'full_sync', 'ref_data', 'rollup')`,
    ),
    check(
      "ingestion_run_status_check",
      sql`${table.status} in ('running', 'success', 'partial', 'failed')`,
    ),
  ],
);
