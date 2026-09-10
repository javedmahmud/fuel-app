import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { appUser } from "./app-user";
import { fuelType } from "./fuel-type";

/**
 * Milestone 3 (UC-04) — needs accounts, so this is schema-only until then, same as
 * `app_user`/`vehicle_profile`.
 */
export const priceAlert = pgTable(
  "price_alert",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    fuelTypeId: uuid("fuel_type_id")
      .notNull()
      .references(() => fuelType.id),

    centreLatitude: numeric("centre_latitude", { precision: 8, scale: 6 }).notNull(),
    centreLongitude: numeric("centre_longitude", { precision: 9, scale: 6 }).notNull(),
    radiusKm: numeric("radius_km", { precision: 5, scale: 2 }).notNull(),

    targetPriceTenthsCpl: integer("target_price_tenths_cpl").notNull(),

    status: text("status", {
      enum: ["active", "triggered", "expired", "disabled"],
    })
      .notNull()
      .default("active"),

    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  },
  (table) => [
    // Alert evaluation sweep (§6.6) — only ever needs to scan active alerts, and only those
    // for a given fuel type at a time, so the partial index excludes everything else.
    index("alert_active_fuel_type_idx")
      .on(table.status, table.fuelTypeId)
      .where(sql`${table.status} = 'active'`),

    check(
      "price_alert_status_check",
      sql`${table.status} in ('active', 'triggered', 'expired', 'disabled')`,
    ),
  ],
);
