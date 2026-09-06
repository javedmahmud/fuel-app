import { bigserial, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { ingestionRun } from "./ingestion-run";

/**
 * One row per upstream call, written **before** the call is made (`07_FUEL_API_INTEGRATION.md`
 * §7.7) — this is what the budget guard reads to enforce the 2,500/month quota. `06` §6.3:
 * "the quota must be enforced, which requires counting."
 */
export const apiCallLedger = pgTable(
  "api_call_ledger",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    ingestionRunId: uuid("ingestion_run_id")
      .notNull()
      .references(() => ingestionRun.id),

    endpoint: text("endpoint").notNull(),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),

    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),

    /** "YYYY-MM" — denormalised deliberately so the budget guard's monthly count is a single
     * indexed equality lookup, not a date-range scan on every call it makes. */
    billingMonth: text("billing_month").notNull(),
  },
  (table) => [index("ledger_billing_month_idx").on(table.billingMonth)],
);
