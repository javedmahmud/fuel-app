import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Reference data for fuel types (E10, U91, P95, DL, ...), sourced from
 * `GET /FuelCheckRefData/v2/fuel/lovs`. See `06_DATA_ARCHITECTURE.md` §6.2.
 *
 * Small, slow-changing table — refreshed weekly by the `ref-data` worker job
 * (`14_DEPLOYMENT.md` §14.3), not written to on every ingestion cycle.
 */
export const fuelType = pgTable(
  "fuel_type",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** The provider's own code, e.g. "E10", "U91", "P95", "DL". Never displayed directly. */
    sourceCode: text("source_code").notNull().unique(),

    /** Human-readable name shown in the UI, e.g. "Unleaded 91". */
    displayName: text("display_name").notNull(),

    /**
     * Coarse grouping for UI filtering. Not the same as sourceCode — several sourceCodes
     * can share a category (e.g. E10 and U91 are both "petrol"). The TS `enum` option gives
     * type safety in application code; the CHECK constraint below is the actual DB-level
     * enforcement per `06_DATA_ARCHITECTURE.md` §6.9 — belt and suspenders.
     */
    category: text("category", { enum: ["petrol", "diesel", "lpg", "other"] }).notNull(),

    /** Display order in fuel-type pickers — reference data doesn't arrive pre-sorted. */
    displayOrder: integer("display_order").notNull().default(0),

    /**
     * False when the provider stops listing this code in reference data. Existing
     * observations referencing it are untouched — this only affects new searches/alerts.
     */
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    check(
      "fuel_type_category_check",
      sql`${table.category} in ('petrol', 'diesel', 'lpg', 'other')`,
    ),
  ],
);
