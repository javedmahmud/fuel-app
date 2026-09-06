import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `07_FUEL_API_INTEGRATION.md` §7.5: the OAuth token is cached **in the database, not process
 * memory** — the worker is spawned by cron and exits after each run, so in-memory caching
 * would re-authenticate on every single poll (24 times per 12-hour token life).
 *
 * Single row, fixed id — each deployed environment (one Postgres, one Fuel API key) only ever
 * has one token to cache. Not part of the original ERD (`06_DATA_ARCHITECTURE.md` §6.2); added
 * in feature/fuel-api-adapter because §7.5's requirement needs somewhere to actually live.
 */
export const oauthTokenCache = pgTable("oauth_token_cache", {
  /** Always the literal string "singleton" — enforced in code, not a DB constraint, since
   * Drizzle has no first-class "exactly one row" constraint. */
  id: text("id").primaryKey(),
  accessToken: text("access_token").notNull(),
  /** §7.5: refresh at 80% of life (~9.5h of the ~12h token), not at literal expiry — clock skew
   * makes expiry-time refresh a source of intermittent 401s. That 80% math happens in
   * token-manager.ts; this column stores the real expiry the API returned. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
