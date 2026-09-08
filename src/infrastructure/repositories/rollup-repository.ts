import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { dailyPriceRollup, fuelPriceObservation, station } from "../db/schema";
import type { RollupObservation } from "../../domain/rollup/compute-daily-rollup";
import type { SydneyDateString } from "../../domain/rollup/day-boundary";

type ReadDb = Pick<PostgresJsDatabase, "select" | "selectDistinctOn">;
type WriteDb = Pick<PostgresJsDatabase, "insert" | "delete">;

export interface ObservationPair {
  stationId: string;
  fuelTypeId: string;
}

/**
 * Every observation with `source_reported_at` inside `[dayStart, dayEnd)` — §10.3 step 2's
 * "day's change events," across every (station, fuel type) pair in one query rather than one
 * per pair. This is the only place `RollupObservation` (the pure algorithm's input shape) is
 * built from real rows, so it's the natural place to attach which pair each one belongs to.
 */
export async function loadDayEvents(
  db: ReadDb,
  dayStart: Date,
  dayEnd: Date,
): Promise<(ObservationPair & RollupObservation)[]> {
  return db
    .select({
      stationId: fuelPriceObservation.stationId,
      fuelTypeId: fuelPriceObservation.fuelTypeId,
      priceTenthsCpl: fuelPriceObservation.priceTenthsCpl,
      sourceReportedAt: fuelPriceObservation.sourceReportedAt,
      retrievedAt: fuelPriceObservation.retrievedAt,
    })
    .from(fuelPriceObservation)
    .where(
      and(
        gte(fuelPriceObservation.sourceReportedAt, dayStart),
        lt(fuelPriceObservation.sourceReportedAt, dayEnd),
      ),
    );
}

/**
 * §10.3 step 1: per (station, fuel type) pair, the single most recent observation strictly
 * before `dayStart` — however old (§10.4 case B). `DISTINCT ON` matching the existing
 * `(station_id, fuel_type_id, source_reported_at)` index (see fuel-price-observation.ts's own
 * comment on that index) lets Postgres skip-scan straight to each pair's latest row instead of
 * scanning the whole table's history every night — the same reasoning that index was already
 * built for. `retrieved_at DESC` as the tiebreak is §10.4 case D at the SQL level, ahead of the
 * pure function's own defensive dedup.
 */
export async function loadOpeningPrices(
  db: ReadDb,
  dayStart: Date,
): Promise<(ObservationPair & RollupObservation)[]> {
  return db
    .selectDistinctOn([fuelPriceObservation.stationId, fuelPriceObservation.fuelTypeId], {
      stationId: fuelPriceObservation.stationId,
      fuelTypeId: fuelPriceObservation.fuelTypeId,
      priceTenthsCpl: fuelPriceObservation.priceTenthsCpl,
      sourceReportedAt: fuelPriceObservation.sourceReportedAt,
      retrievedAt: fuelPriceObservation.retrievedAt,
    })
    .from(fuelPriceObservation)
    .where(lt(fuelPriceObservation.sourceReportedAt, dayStart))
    .orderBy(
      fuelPriceObservation.stationId,
      fuelPriceObservation.fuelTypeId,
      desc(fuelPriceObservation.sourceReportedAt),
      desc(fuelPriceObservation.retrievedAt),
    );
}

/**
 * §10.4 case F, approximated: the schema has no dedicated "deactivated at" timestamp (station
 * lifecycle only records `lifecycle_state` and `last_seen_at` — see station.ts), so this treats
 * a station's `last_seen_at` as the deactivation instant *only* when it's currently `inactive`
 * and that timestamp falls inside the day being rolled up. That's the closest honest signal
 * available: it genuinely is the last moment this system can vouch the station was still
 * present. A station that went inactive on some other day never matches this query at all
 * (nothing to truncate for a day that already has no observations, or was already handled).
 */
export async function loadStationsDeactivatedDuring(
  db: ReadDb,
  dayStart: Date,
  dayEnd: Date,
): Promise<Map<string, Date>> {
  const rows = await db
    .select({ id: station.id, lastSeenAt: station.lastSeenAt })
    .from(station)
    .where(
      and(
        eq(station.lifecycleState, "inactive"),
        gte(station.lastSeenAt, dayStart),
        lt(station.lastSeenAt, dayEnd),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.lastSeenAt]));
}

export interface DailyRollupRow {
  stationId: string;
  fuelTypeId: string;
  priceDate: SydneyDateString;
  timeWeightedAvgTenths: number;
  minTenthsCpl: number;
  maxTenthsCpl: number;
  openTenthsCpl: number;
  closeTenthsCpl: number;
  observationCount: number;
  carriedForward: boolean;
  openingPriceAgeDays: number;
  partialDay: boolean;
  methodVersion: string;
  computedAt: Date;
}

/** Rows per batched upsert. 13 columns keeps even a large day's worth of pairs well under
 * Postgres's ~65,535-bind-parameter limit — same reasoning as the other repositories' batching,
 * sized for readable statement sizes rather than working around that limit. */
const UPSERT_BATCH_SIZE = 1_000;
const DELETE_BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * §10.8: "Recompute is idempotent... a full replace for the affected day, never an incremental
 * adjustment." `ON CONFLICT DO UPDATE` overwriting every column (not merging) is exactly that —
 * re-running the same day with the same inputs reproduces the same row; a corrected
 * `method_version` or late-arriving observations legitimately produce a different one.
 */
export async function upsertDailyRollups(
  db: WriteDb,
  rows: DailyRollupRow[],
): Promise<{ written: number }> {
  if (rows.length === 0) return { written: 0 };

  for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
    await db
      .insert(dailyPriceRollup)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          dailyPriceRollup.stationId,
          dailyPriceRollup.fuelTypeId,
          dailyPriceRollup.priceDate,
        ],
        set: {
          timeWeightedAvgTenths: sql`excluded.time_weighted_avg_tenths`,
          minTenthsCpl: sql`excluded.min_tenths_cpl`,
          maxTenthsCpl: sql`excluded.max_tenths_cpl`,
          openTenthsCpl: sql`excluded.open_tenths_cpl`,
          closeTenthsCpl: sql`excluded.close_tenths_cpl`,
          observationCount: sql`excluded.observation_count`,
          carriedForward: sql`excluded.carried_forward`,
          openingPriceAgeDays: sql`excluded.opening_price_age_days`,
          partialDay: sql`excluded.partial_day`,
          methodVersion: sql`excluded.method_version`,
          computedAt: sql`excluded.computed_at`,
        },
      });
  }

  return { written: rows.length };
}

/**
 * For pairs that recomputed as *skipped* (§10.4 case C, or the defensive
 * deactivated-before-day case) — removes any stale row a previous run may have written for
 * this date, so the store never disagrees with the current recompute. Expected to run against a
 * small list in practice (a pair only lands here on its genuine first-ever day, or in the
 * defensive case), so a handful of OR'd tuple-equality clauses per batch is proportionate — not
 * the kind of per-row-loop cost the other repositories' bulk rewrites were about.
 */
export async function deleteDailyRollupsForDate(
  db: WriteDb,
  pairs: ObservationPair[],
  priceDate: SydneyDateString,
): Promise<{ deleted: number }> {
  if (pairs.length === 0) return { deleted: 0 };

  let deleted = 0;
  for (const batch of chunk(pairs, DELETE_BATCH_SIZE)) {
    const pairConditions = batch.map(
      (p) =>
        sql`(${dailyPriceRollup.stationId} = ${p.stationId} and ${dailyPriceRollup.fuelTypeId} = ${p.fuelTypeId})`,
    );
    const rows = await db
      .delete(dailyPriceRollup)
      .where(and(eq(dailyPriceRollup.priceDate, priceDate), or(...pairConditions)))
      .returning({ stationId: dailyPriceRollup.stationId });
    deleted += rows.length;
  }

  return { deleted };
}
