/**
 * `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.9: "Rate limiting uses Postgres-backed fixed-window
 * counters. At this scale Redis would add a service and a failure mode to solve a problem that
 * does not exist." A fixed window (not sliding/token-bucket) — simplest correct implementation
 * for this scale, and what the doc specifically names. `now` is always a parameter (`src/domain
 * /README.md`'s "no clock" rule) — the infrastructure layer supplies it and does the actual DB
 * upsert; this module only decides which window a request falls into and whether a count is
 * over the limit.
 */

/** Floors `now` to the start of its `windowSeconds`-wide fixed window, in UTC epoch terms — e.g.
 * with a 60s window, 14:32:47 and 14:32:01 both floor to 14:32:00; 14:33:00 starts a new window.
 * Epoch-aligned (not aligned to when the first request in a window happened), which is what
 * makes it a genuinely *fixed* window shared correctly across concurrent requests/replicas. */
export function computeWindowStart(now: Date, windowSeconds: number): Date {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

export function isWithinRateLimit(countAfterIncrement: number, maxRequests: number): boolean {
  return countAfterIncrement <= maxRequests;
}
