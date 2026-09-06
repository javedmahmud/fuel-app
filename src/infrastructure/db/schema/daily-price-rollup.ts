import {
  boolean,
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { fuelType } from "./fuel-type";
import { station } from "./station";

/**
 * One row per (station, fuel type, day) — a **cache, not a source**. Droppable and fully
 * rebuildable from `fuel_price_observation` at any time with no data loss, because it's
 * derived (`06_DATA_ARCHITECTURE.md` §6.1, §6.3). Exists because UC-06's 90-day trend charts
 * would otherwise scan millions of raw rows per request.
 *
 * Field meanings are `10_PRICE_HISTORY_METHOD.md` §10.5's algorithm output, not independently
 * decided here — this table is that document's storage contract.
 */
export const dailyPriceRollup = pgTable(
  "daily_price_rollup",
  {
    stationId: uuid("station_id")
      .notNull()
      .references(() => station.id),
    fuelTypeId: uuid("fuel_type_id")
      .notNull()
      .references(() => fuelType.id),

    /** Calendar day in Australia/Sydney — not UTC. See `10_PRICE_HISTORY_METHOD.md` §10.6 on
     * why day boundaries must be computed in local time, and why DST days aren't 86,400s. */
    priceDate: date("price_date").notNull(),

    /** The figure multi-day averages actually use — §10.3's interval reconstruction, not a
     * naive mean of observations (that's the exact bug v1 warned about and this table fixes). */
    timeWeightedAvgTenths: integer("time_weighted_avg_tenths"),

    minTenthsCpl: integer("min_tenths_cpl"),
    maxTenthsCpl: integer("max_tenths_cpl"),

    /** Effective at day_start — possibly carried forward from a prior day if nothing changed. */
    openTenthsCpl: integer("open_tenths_cpl"),
    /** Effective at day_end. Used for trend regression. */
    closeTenthsCpl: integer("close_tenths_cpl"),

    /** 0 is valid and common (§10.4 case A — a station simply didn't change price that day),
     * not an error state. */
    observationCount: integer("observation_count").notNull().default(0),

    /** True when the opening price came from a prior day rather than an observation made on
     * this day itself. */
    carriedForward: boolean("carried_forward").notNull().default(false),

    /** Feeds confidence scoring (§9.7) — an old carried-forward opening price is weaker
     * evidence than one set that same day. */
    openingPriceAgeDays: integer("opening_price_age_days"),

    /** Station deactivated mid-day (§10.4 case F). Excluded from multi-day aggregates. */
    partialDay: boolean("partial_day").notNull().default(false),

    /** Which version of the rollup algorithm produced this row — the analogue of
     * `engine_version` in the calculation engine. Incrementing it and recomputing is safe
     * only because this table is derived and rebuildable (ADR-003's append-only payoff). */
    methodVersion: text("method_version").notNull(),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Composite PK per §6.6 — also serves as the index history/percentile queries need
    // (station_id, fuel_type_id, price_date DESC).
    primaryKey({ columns: [table.stationId, table.fuelTypeId, table.priceDate] }),
  ],
);
