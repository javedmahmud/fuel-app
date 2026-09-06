import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { appUser } from "./app-user";
import { station } from "./station";

/**
 * One row per recommendation actually shown to someone — the raw material for the
 * recommendation-acceptance funnel in `03_DELIVERY_ROADMAP.md` §3.4, and for reproducing
 * "why did the system suggest this" after the fact.
 *
 * `userId` is nullable by design: anonymous use is the MVP's normal case (no auth yet), and
 * this table must not become a reason to require accounts.
 */
export const recommendationLog = pgTable("recommendation_log", {
  id: uuid("id").primaryKey().defaultRandom(),

  userId: uuid("user_id").references(() => appUser.id),

  /** Groups recommendations within one anonymous session without identifying a person —
   * `13_OBSERVABILITY_SECURITY_PRIVACY.md`'s privacy rules govern what this may be derived
   * from; it is not itself a design decision made by this schema. */
  sessionHash: text("session_hash"),

  recommendedStationId: uuid("recommended_station_id")
    .notNull()
    .references(() => station.id),

  /** Reproducibility: the exact inputs the calculation engine ran on, so a disputed or
   * surprising recommendation can be replayed and explained after the fact. */
  calculationInputs: jsonb("calculation_inputs").notNull(),
  outputMetrics: jsonb("output_metrics").notNull(),

  /** Reason codes are the only channel between the calculation engine and the explanation
   * layer (`21_DETAILED_DESIGN.md` §21.5) — a fixed enum elsewhere, stored here as the actual
   * codes that fired for this recommendation, never free text. */
  reasonCodes: text("reason_codes").array().notNull(),

  /** Which formula version produced this — same "recompute correctly, no lost fidelity"
   * property as `daily_price_rollup.method_version`. */
  engineVersion: text("engine_version").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
