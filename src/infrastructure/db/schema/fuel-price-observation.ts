import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { fuelType } from "./fuel-type";
import { ingestionRun } from "./ingestion-run";
import { station } from "./station";

/**
 * Append-only. No UPDATE, no DELETE — enforced by a database trigger (see the
 * `0001_observation_append_only.sql` migration) as well as by never exposing a mutation
 * method from the repository layer. This is the governing principle of the whole schema:
 * `06_DATA_ARCHITECTURE.md` §6.1 — "nothing derived is stored as truth."
 *
 * A restated price from upstream is a *new* row with a later `retrievedAt`, never an edit.
 */
export const fuelPriceObservation = pgTable(
  "fuel_price_observation",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    stationId: uuid("station_id")
      .notNull()
      .references(() => station.id),
    fuelTypeId: uuid("fuel_type_id")
      .notNull()
      .references(() => fuelType.id),

    /**
     * INTEGER tenths of a cent per litre — 178.9 c/L is stored as 1789. Never a float:
     * `06_DATA_ARCHITECTURE.md` §6.4 explains why (binary floating point can't represent
     * 178.9 exactly, so sums/averages drift and equal prices stop comparing equal).
     * The domain layer works in these integer tenths throughout; conversion to display
     * units happens once, at the presentation boundary.
     */
    priceTenthsCpl: integer("price_tenths_cpl").notNull(),

    /** When the *station* changed this price — the price's real age. Freshness shown to
     * users is computed from this, never from `retrievedAt` (§6.4, §6.7). */
    sourceReportedAt: timestamp("source_reported_at", { withTimezone: true }).notNull(),

    /** When *we* fetched it — our pipeline's age, used for ingestion monitoring, not for
     * user-facing freshness. Conflating the two produces wrong answers in both directions. */
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),

    ingestionRunId: uuid("ingestion_run_id").references(() => ingestionRun.id),

    source: text("source").notNull().default("NSW_FUEL_API"),

    /** Verbatim source record, kept forever (until the 90-day nulling in the retention job —
     * see §6.8). Costs ~200 bytes/row; buys reprocessing, evidence, and honest provenance. */
    rawPayload: jsonb("raw_payload"),

    /** Deterministic dedup key. `/prices/new` can re-deliver the same price across
     * overlapping polls; this is what makes persistence idempotent. */
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    // The critical index (§6.6): nearly every user-facing query reduces to "the most recent
    // observation for each (station, fuel type) pair among these candidates" — a
    // DISTINCT ON (station_id, fuel_type_id) ORDER BY source_reported_at DESC. Without this
    // index that's a sort over millions of rows on every search; with it, index-only.
    index("observation_station_fuel_reported_idx").on(
      table.stationId,
      table.fuelTypeId,
      table.sourceReportedAt,
    ),

    // Enforces the dedup contract above at the database level, not just in application logic —
    // this MUST be unique, or a re-delivered price across overlapping polls creates a duplicate
    // row instead of being silently skipped (§6.9's "Duplicate" data quality gate).
    uniqueIndex("observation_content_hash_unique_idx").on(table.contentHash),

    // Ingestion monitoring / freshness dashboards read by retrievedAt, not sourceReportedAt.
    index("observation_retrieved_at_idx").on(table.retrievedAt),
  ],
);
