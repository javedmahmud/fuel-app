import { numeric, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { appUser } from "./app-user";

/**
 * One vehicle profile per user (`APP_USER ||--o| VEHICLE_PROFILE`, §6.2 — optional, not
 * required). Feeds `effective_cost` when tank state is known; most users won't fill this in,
 * which is why comparison mode (a 40 L reference volume) exists as the default path.
 */
export const vehicleProfile = pgTable("vehicle_profile", {
  id: uuid("id").primaryKey().defaultRandom(),

  userId: uuid("user_id")
    .notNull()
    .references(() => appUser.id),

  tankCapacityLitres: numeric("tank_capacity_litres", { precision: 6, scale: 2 }),
  consumptionLPer100km: numeric("consumption_l_per_100km", { precision: 5, scale: 2 }),

  /** 0-1, nullable — "how full is the tank right now." Null means unknown, which is the
   * common case and why comparison mode exists (`09_CALCULATION_ENGINE.md` §9.4.4). */
  currentFuelFraction: numeric("current_fuel_fraction", { precision: 3, scale: 2 }),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
