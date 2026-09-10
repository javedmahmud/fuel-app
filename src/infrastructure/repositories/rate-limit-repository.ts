import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { rateLimitWindow } from "../db/schema";

type Db = Pick<PostgresJsDatabase, "insert">;

/**
 * Atomically increments the counter for `(key, windowStart)`, creating the row if it doesn't
 * exist yet, and returns the count *after* incrementing. One statement, not a
 * read-then-write — two concurrent requests in the same window must both genuinely increment,
 * never race and silently lose one, which is exactly what `ON CONFLICT DO UPDATE SET count =
 * count + 1` guarantees and a separate `SELECT` then `UPDATE` would not.
 */
export async function incrementRateLimitCounter(
  db: Db,
  key: string,
  windowStart: Date,
): Promise<number> {
  const [row] = await db
    .insert(rateLimitWindow)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitWindow.key, rateLimitWindow.windowStart],
      set: { count: sql`${rateLimitWindow.count} + 1` },
    })
    .returning({ count: rateLimitWindow.count });

  return row.count;
}
