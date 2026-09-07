import { createHash } from "node:crypto";
import type { PriceObservation } from "../fuel-api/types";

/**
 * `08_INGESTION_ARCHITECTURE.md` §8.7: `sha256(source | station_code | fuel_code |
 * price_tenths | source_reported_at)`.
 *
 * `retrieved_at` and `ingestion_run_id` are **deliberately excluded** — they differ between
 * runs, and including either would defeat deduplication entirely: the same real-world price
 * change, re-delivered across two overlapping `/prices/new` polls, must hash identically both
 * times so `ON CONFLICT DO NOTHING` (the unique index on `content_hash`, already in the
 * db-schema branch) actually catches it. "Belongs in a test," per the doc — see
 * content-hash.test.ts.
 */
export function computeContentHash(params: {
  source: string;
  stationCode: string;
  fuelCode: string;
  priceTenthsCpl: number;
  sourceReportedAt: Date;
}): string {
  const canonical = [
    params.source,
    params.stationCode,
    params.fuelCode,
    String(params.priceTenthsCpl),
    params.sourceReportedAt.toISOString(),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/** Convenience wrapper over `computeContentHash` for an already-normalised observation — every
 * real call site has one of these, not the raw fields separately. */
export function contentHashForObservation(
  observation: PriceObservation,
  source: string,
  sourceReportedAt: Date,
): string {
  return computeContentHash({
    source,
    stationCode: observation.sourceStationCode,
    fuelCode: observation.fuelTypeSourceCode,
    priceTenthsCpl: observation.priceTenthsCpl,
    sourceReportedAt,
  });
}
