/**
 * `09_CALCULATION_ENGINE.md` §9.5 — two different questions, two different metrics, confirmed
 * against Spike Test 7's real measured distribution (10,566 records: 0.0% ≤2h, 6.0% ≤24h,
 * 56.0% ≤7d, 27.9% ≤30d, 10.1% >30d old). Conflating them is the mistake §9.5 exists to
 * prevent: NSW stations report a price *when it changes*, so `source_reported_at` measures time
 * since the price last moved, not data decay — under the original 30min/120min thresholds
 * applied to it, the large majority of the real dataset would show "stale" in red, every time.
 *
 * Both threshold sets are parameters with a sensible default, never hardcoded constants — "Both
 * threshold sets remain configuration, consumed by one pure function" (§9.5's closing line) —
 * so operators can retune them without a redeploy.
 *
 * Deliberately distinct from `src/domain/observability/evaluate-ingestion-health.ts`'s
 * `evaluateIngestionLag`, even though both start from the same `retrieved_at` data: that one is
 * a boolean *operator* alarm (>90 min, §13.3); `pipelineHealthBand` below is a 3-tier *user-facing*
 * display band (§9.5's "Prices updated 12 minutes ago"), a different consumer with different
 * thresholds — not a bug that the numbers don't match.
 */

// --- "Is the system working?" — now - max(retrieved_at), shown once, globally. -------------

export interface PipelineHealthThresholds {
  healthyMaxMinutes: number;
  delayedMaxMinutes: number;
}

/** The v1 thresholds, reused here deliberately (§9.5: "the 30/120-minute thresholds fit it
 * perfectly" for this specific question, unlike when applied to source_reported_at). */
export const DEFAULT_PIPELINE_HEALTH_THRESHOLDS: PipelineHealthThresholds = {
  healthyMaxMinutes: 30,
  delayedMaxMinutes: 120,
};

export type PipelineHealthBand = "healthy" | "delayed" | "stale";

export function pipelineHealthBand(
  lastRetrievedAt: Date | null,
  now: Date,
  thresholds: PipelineHealthThresholds = DEFAULT_PIPELINE_HEALTH_THRESHOLDS,
): PipelineHealthBand {
  if (!lastRetrievedAt) return "stale"; // no data ever ingested is the least healthy state, not "healthy by default"
  const ageMinutes = (now.getTime() - lastRetrievedAt.getTime()) / 60_000;
  if (ageMinutes <= thresholds.healthyMaxMinutes) return "healthy";
  if (ageMinutes <= thresholds.delayedMaxMinutes) return "delayed";
  return "stale";
}

// --- "Is this price likely to still be right?" — now - source_reported_at, per station. ----

export interface PriceAgeThresholds {
  currentMaxHours: number;
  ageingMaxDays: number;
}

/** §9.5's proposed table: Current ≤48h (no warning), Ageing 2–7 days (subtle note),
 * Long-unchanged >7 days (explicit "confirm at the pump"). The doc's own caveat applies: the
 * order-of-magnitude correction (minutes → days) is confirmed by Test 7's real distribution;
 * these exact hour/day boundaries are reasonable, not measured to the hour. */
export const DEFAULT_PRICE_AGE_THRESHOLDS: PriceAgeThresholds = {
  currentMaxHours: 48,
  ageingMaxDays: 7,
};

export type PriceAgeBand = "current" | "ageing" | "long_unchanged";

export function priceAgeBand(
  sourceReportedAt: Date,
  now: Date,
  thresholds: PriceAgeThresholds = DEFAULT_PRICE_AGE_THRESHOLDS,
): PriceAgeBand {
  const ageHours = (now.getTime() - sourceReportedAt.getTime()) / (60 * 60 * 1000);
  if (ageHours <= thresholds.currentMaxHours) return "current";
  if (ageHours <= thresholds.ageingMaxDays * 24) return "ageing";
  return "long_unchanged";
}

/** §9.5's station-eligibility rule: "sufficiently fresh data" is measured against
 * `source_reported_at`, with a **14-day** default cutoff — not the original 120-minute one,
 * which per the doc's own analysis would exclude nearly every station from every search. Same
 * config-not-constant treatment as the two band functions above. */
export const DEFAULT_ELIGIBILITY_MAX_AGE_DAYS = 14;

export function isFreshEnoughForEligibility(
  sourceReportedAt: Date,
  now: Date,
  maxAgeDays: number = DEFAULT_ELIGIBILITY_MAX_AGE_DAYS,
): boolean {
  const ageDays = (now.getTime() - sourceReportedAt.getTime()) / (24 * 60 * 60 * 1000);
  return ageDays <= maxAgeDays;
}
