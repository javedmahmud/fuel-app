import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.9: "Rate limiting uses Postgres-backed fixed-window
 * counters. At this scale Redis would add a service and a failure mode to solve a problem that
 * does not exist." One row per (rate-limit key, fixed window) — `key` encodes both the endpoint
 * and the caller, e.g. `search:203.0.113.5`, so different endpoints get independent budgets for
 * the same IP. `windowStart` is the epoch-aligned start of that window
 * (`domain/rate-limit/rate-limit.ts`'s `computeWindowStart`), not "when this IP first hit this
 * window" — what makes it a genuinely fixed window rather than a per-caller sliding one.
 *
 * No retention/cleanup job exists yet for this table — the same class of known, documented gap
 * as the worker's `retention` job stub (§6.8's policy exists for other tables; this one doesn't
 * have an assigned policy yet). Rows are small and the window granularity is coarse (60s), but
 * this will grow unboundedly without a future cleanup pass.
 */
export const rateLimitWindow = pgTable(
  "rate_limit_window",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStart] })],
);
