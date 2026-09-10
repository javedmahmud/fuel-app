import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { computeWindowStart, isWithinRateLimit } from "../../domain/rate-limit/rate-limit";
import { incrementRateLimitCounter } from "../repositories/rate-limit-repository";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/**
 * Composes the pure window/limit decision (`domain/rate-limit/rate-limit.ts`) with the
 * Postgres-backed counter (`repositories/rate-limit-repository.ts`) into the one call a route
 * handler actually needs. `key` should already encode both the endpoint and the caller (e.g.
 * `search:203.0.113.5`) — this function doesn't build that string itself, since what identifies
 * "the caller" is a route-specific concern (IP today; could reasonably become IP+API-key later).
 */
export async function checkRateLimit(
  db: Pick<PostgresJsDatabase, "insert">,
  key: string,
  maxRequests: number,
  windowSeconds: number,
  now: Date,
): Promise<RateLimitResult> {
  const windowStart = computeWindowStart(now, windowSeconds);
  const count = await incrementRateLimitCounter(db, key, windowStart);
  return { allowed: isWithinRateLimit(count, maxRequests), count, limit: maxRequests };
}
