import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * A fuel station, keyed by the provider's own station code. See `06_DATA_ARCHITECTURE.md` §6.2.
 *
 * `lifecycle_state` is graduated (`active -> suspect -> inactive`) rather than a single missing
 * snapshot immediately marking a station closed — see §6.3's rationale ("a single missing
 * snapshot is weak evidence of closure"). Reference data is the authority on existence.
 */
export const station = pgTable(
  "station",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** The provider's own station identifier. Unique only together with `source` (see below). */
    sourceStationCode: text("source_station_code").notNull(),

    /** Which upstream this station came from. Always "NSW_FUEL_API" today, but named for the
     * day a second source (e.g. a different state's feed) exists. */
    source: text("source").notNull().default("NSW_FUEL_API"),

    name: text("name").notNull(),
    brand: text("brand"),
    addressLine: text("address_line"),
    suburb: text("suburb"),
    postcode: text("postcode"),

    /** e.g. "NSW", "TAS" — the plausibility check in §6.9 flags coordinates outside this pair. */
    state: varchar("state", { length: 3 }),

    /** NUMERIC(8,6)/(9,6), not float — see `06_DATA_ARCHITECTURE.md` §6.4 on why prices are
     * integers; the same drift argument applies to coordinates used in distance math. */
    latitude: numeric("latitude", { precision: 8, scale: 6 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),

    lifecycleState: text("lifecycle_state", { enum: ["active", "suspect", "inactive"] })
      .notNull()
      .default("active"),

    /** Consecutive ingestion cycles this station was absent from. Resets to 0 the moment it
     * reappears. Drives the active -> suspect -> inactive graduation. */
    consecutiveMissingSyncs: integer("consecutive_missing_syncs").notNull().default(0),

    /** When the *provider's* reference data last changed this record — distinct from the two
     * timestamps below, which are about our own observation of it. */
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Idempotent upsert key for ingestion (§6.6) — a station is unique per (code, source),
    // not by code alone, since a future second source could reuse the same code scheme.
    unique("station_source_code_source_unique").on(table.sourceStationCode, table.source),

    // Bounding-box prefilter for "stations near me" (§6.5). Partial: inactive stations are
    // never searched, so excluding them keeps the index smaller and every scan cheaper.
    index("station_lat_lng_active_idx")
      .on(table.latitude, table.longitude)
      .where(sql`${table.lifecycleState} <> 'inactive'`),

    check(
      "station_lifecycle_state_check",
      sql`${table.lifecycleState} in ('active', 'suspect', 'inactive')`,
    ),
  ],
);
