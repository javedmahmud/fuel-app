import { sql } from "drizzle-orm";
import { numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { fuelType } from "./fuel-type";

/**
 * Milestone 3 — accounts don't exist in the MVP (`19_APPROVAL_CHECKLIST.md` §4.8, "No
 * authentication initially"). Built now anyway because Sprint 1's scope is the full ERD
 * (`20_SPRINT_PLAN.md` §20.4) — schema arrives before the feature that needs it, per the
 * expand/contract migration philosophy in `14_DEPLOYMENT.md` §14.5.
 *
 * The ERD (`06_DATA_ARCHITECTURE.md` §6.2) specifies `citext` for case-insensitive email
 * matching. Deliberately not used here: `citext` is a Postgres extension, and this project has
 * consistently avoided extension dependencies elsewhere for portability (§6.5 rejected PostGIS
 * and cube/earthdistance for the same reason — see `14_DEPLOYMENT.md` Appendix A.5 rule 1, "no
 * vendor-specific database features"). Plain `text` plus a unique index on `lower(email)` gets
 * the same case-insensitive uniqueness guarantee without the extension.
 */
export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Null until real authentication exists (Milestone 3) — an anonymous user has no
     * provider identity yet. */
    authProviderUserId: text("auth_provider_user_id").unique(),

    email: text("email"),

    defaultFuelTypeId: uuid("default_fuel_type_id").references(() => fuelType.id),
    defaultLatitude: numeric("default_latitude", { precision: 8, scale: 6 }),
    defaultLongitude: numeric("default_longitude", { precision: 9, scale: 6 }),
    defaultLocalityLabel: text("default_locality_label"),
    maximumDetourKm: numeric("maximum_detour_km", { precision: 6, scale: 2 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    /** Soft delete — per `13_OBSERVABILITY_SECURITY_PRIVACY.md`'s privacy rules, deleting a
     * user's row outright would also destroy the audit trail of what was ever stored for
     * them. Application queries must filter `deletedAt IS NULL`; enforcing that is a
     * repository-layer concern, not this schema's. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Case-insensitive uniqueness without the citext extension — see the module comment.
    // Partial: doesn't need to hold for soft-deleted users, so a deleted account's email can
    // be reused by a new signup.
    uniqueIndex("app_user_email_lower_unique_idx")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.deletedAt} is null`),
  ],
);
