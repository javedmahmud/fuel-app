import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { fuelPriceObservation } from "../db/schema";

export interface ObservationToInsert {
  stationId: string;
  fuelTypeId: string;
  priceTenthsCpl: number;
  sourceReportedAt: Date;
  ingestionRunId: string;
  source: string;
  rawPayload: unknown;
  contentHash: string;
}

/** Rows per batched insert. 8 columns × row count must stay under Postgres's ~65,535-bind-
 * parameter limit for a single statement — `full_sync` fetches ~10,566 real records (spike
 * Test 2), and 8 × 10,566 ≈ 84,500 would exceed that limit in one unchunked statement. This
 * size keeps each batch (8 × 1,000 = 8,000 params) comfortably clear of it. */
const INSERT_BATCH_SIZE = 1_000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * The only writer of `fuel_price_observation` — append-only, enforced by a DB trigger
 * (`0001_observation_append_only.sql`) as well as by this being the sole insert path. Relies on
 * the unique index on `content_hash` (db-schema branch) for idempotency: `ON CONFLICT DO
 * NOTHING` means a re-delivered price across overlapping polls is silently skipped, exactly
 * per §8.10's "Duplicate: content_hash exists -> skip silently — expected."
 *
 * Returns which rows were genuinely new — `full_sync`'s "inserted vs already-present" count is
 * the system's only self-audit for lost `new_prices` windows (§8.5), so this return value isn't
 * incidental, it's load-bearing.
 */
export async function insertObservationsIdempotent(
  db: Pick<PostgresJsDatabase, "insert">,
  observations: ObservationToInsert[],
): Promise<{ insertedCount: number; duplicateCount: number }> {
  if (observations.length === 0) {
    return { insertedCount: 0, duplicateCount: 0 };
  }

  let insertedCount = 0;
  for (const batch of chunk(observations, INSERT_BATCH_SIZE)) {
    const inserted = await db
      .insert(fuelPriceObservation)
      .values(
        batch.map((o) => ({
          stationId: o.stationId,
          fuelTypeId: o.fuelTypeId,
          priceTenthsCpl: o.priceTenthsCpl,
          sourceReportedAt: o.sourceReportedAt,
          ingestionRunId: o.ingestionRunId,
          source: o.source,
          rawPayload: o.rawPayload,
          contentHash: o.contentHash,
        })),
      )
      .onConflictDoNothing({ target: fuelPriceObservation.contentHash })
      .returning({ id: fuelPriceObservation.id });
    insertedCount += inserted.length;
  }

  return {
    insertedCount,
    duplicateCount: observations.length - insertedCount,
  };
}
