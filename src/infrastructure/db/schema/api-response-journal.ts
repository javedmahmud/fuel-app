import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { ingestionRun } from "./ingestion-run";

// drizzle-orm/pg-core has no built-in `bytea` column type as of this version — this is the
// documented pattern for adding one: https://orm.drizzle.team/docs/custom-types
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * *New in v2, the single most important table in the pack* — `04_ARCHITECTURE_SUMMARY.md` §4.4.
 * The raw response body is committed here **before** any parsing that could fail, because
 * `/prices/new` delivery is at-most-once: the watermark is server-side and per API key, so a
 * response received but not persisted is lost forever (confirmed by spike Test 3,
 * `18_DECISION_BRIEF.md` Part 1). See `08_INGESTION_ARCHITECTURE.md` §8.3 for the full
 * journal-before-parse sequence this table exists to support.
 *
 * `status = 'unparsed'` rows are the **only copy** of a consumed price window and are never
 * auto-pruned (§6.8's retention table) — they're evidence, not a cache.
 */
export const apiResponseJournal = pgTable(
  "api_response_journal",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    ingestionRunId: uuid("ingestion_run_id")
      .notNull()
      .references(() => ingestionRun.id),

    endpoint: text("endpoint").notNull(),
    httpStatus: integer("http_status").notNull(),

    /** Verbatim response body, pre-parse. This is what makes recovery possible: everything
     * downstream of the commit becomes retryable offline. */
    rawBody: bytea("raw_body").notNull(),

    status: text("status", {
      enum: ["unprocessed", "processed", "unparsed"],
    })
      .notNull()
      .default("unprocessed"),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),

    failureReason: text("failure_reason"),
  },
  (table) => [
    // Finds unprocessed and unparsed responses for replay (§6.6). Partial: 'processed' rows
    // (the overwhelming majority once ingestion is healthy) never need to be scanned.
    index("journal_unprocessed_idx")
      .on(table.status)
      .where(sql`${table.status} <> 'processed'`),

    check("journal_status_check", sql`${table.status} in ('unprocessed', 'processed', 'unparsed')`),
  ],
);
