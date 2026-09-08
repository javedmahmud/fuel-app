import { fromZonedTime } from "date-fns-tz";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../../infrastructure/db/client";
import {
  dailyPriceRollup,
  fuelPriceObservation,
  fuelType,
  station,
} from "../../infrastructure/db/schema";
import type { FuelType, Station } from "../../infrastructure/fuel-api/types";
import { upsertFuelTypesFromReferenceData } from "../../infrastructure/repositories/fuel-type-repository";
import { upsertStationsFromReferenceData } from "../../infrastructure/repositories/station-repository";
import {
  previousSydneyDate,
  sydneyDateOf,
  sydneyDayBoundary,
} from "../../domain/rollup/day-boundary";
import { runRollupJob } from "./rollup-job";

/**
 * Real Postgres, and deliberately the job's real default date ("yesterday" relative to a real
 * `now`) — not a synthetic fixed date — because `runRollupJob` derives its own scope of which
 * (station, fuel type) pairs to process from the whole table (unlike the ingestion repos, which
 * take an explicit input list), so it necessarily processes staging's real pairs for that day
 * alongside this test's own fixture. That's the actual production shape, not an artifact of the
 * test — so assertions check only this test's own fixture row, per repositories.integration
 * .test.ts's established "don't trust table-wide counts once real data coexists" lesson, and a
 * generous timeout accounts for genuinely touching the whole real day's worth of pairs.
 */

const SYDNEY_TZ = "Australia/Sydney";
function sydney(y: number, m: number, d: number, hh: number, mm: number, ss = 0): Date {
  return fromZonedTime(new Date(y, m - 1, d, hh, mm, ss), SYDNEY_TZ);
}

function testStation(overrides: Partial<Station> = {}): Station {
  return {
    sourceStationCode: `TEST_${Math.random().toString(36).slice(2)}`,
    source: "NSW_FUEL_API",
    name: "Integration Test Station",
    brand: "Test Brand",
    addressLine: "1 Test St",
    latitude: -33.87,
    longitude: 151.21,
    state: "NSW",
    ...overrides,
  };
}

class IntentionalTestRollback extends Error {}

describe("runRollupJob against real Postgres", () => {
  it("computes and writes a correct rollup row for a synthetic station/fuel-type on the job's real default day (yesterday)", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const now = new Date();
        const targetDate = previousSydneyDate(sydneyDateOf(now));
        const { dayStart } = sydneyDayBoundary(targetDate);
        // Parse the target date's own y/m/d back out, so the fixture's observations land on
        // whatever "yesterday" actually is when this test runs, not a hardcoded date.
        const [y, m, d] = targetDate.split("-").map(Number);

        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], now);
        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);

        const [stationRow] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);
        const stationId = stationRow.id;
        const [ftRow] = await tx
          .select({ id: fuelType.id })
          .from(fuelType)
          .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);
        const fuelTypeId = ftRow.id;

        async function insertObs(priceTenthsCpl: number, sourceReportedAt: Date) {
          await tx.insert(fuelPriceObservation).values({
            stationId,
            fuelTypeId,
            priceTenthsCpl,
            sourceReportedAt,
            source: "NSW_FUEL_API",
            contentHash: `test-${Math.random().toString(36).slice(2)}-${Date.now()}-${Math.random()}`,
          });
        }

        // Opening price, carried from the day before targetDate.
        await insertObs(1800, sydney(y, m, d - 1, 20, 0, 0));
        // Noon change on targetDate — an exact 50/50 split of a normal (non-DST) day.
        await insertObs(1600, sydney(y, m, d, 12, 0, 0));

        const result = await runRollupJob(tx, now, targetDate);

        expect(result.priceDate).toBe(targetDate);
        // Real staging data may or may not have other pairs for this day — assert only that
        // this test's own pair was among what got processed and written.
        expect(result.pairsProcessed).toBeGreaterThanOrEqual(1);
        expect(result.rowsWritten).toBeGreaterThanOrEqual(1);

        const [row] = await tx
          .select()
          .from(dailyPriceRollup)
          .where(
            sql`${dailyPriceRollup.stationId} = ${stationId} and ${dailyPriceRollup.fuelTypeId} = ${fuelTypeId} and ${dailyPriceRollup.priceDate} = ${targetDate}`,
          );

        expect(row).toBeDefined();
        expect(row.openTenthsCpl).toBe(1800);
        expect(row.closeTenthsCpl).toBe(1600);
        expect(row.timeWeightedAvgTenths).toBe(1700); // exact 50/50 split of 1800 and 1600
        expect(row.observationCount).toBe(1);
        expect(row.carriedForward).toBe(true);
        expect(row.partialDay).toBe(false);
        expect(row.methodVersion).toBe("v1");

        // Sanity: dayStart really is the calendar day this test believes it is, so a failure
        // above is a real bug, not a timezone-arithmetic mistake in the test itself.
        expect(sydneyDateOf(dayStart)).toBe(targetDate);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 60_000);

  it("is idempotent — recomputing the same day twice produces the same row (§10.8 full replace)", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const now = new Date();
        const targetDate = previousSydneyDate(sydneyDateOf(now));
        const [y, m, d] = targetDate.split("-").map(Number);

        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], now);
        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);
        const [stationRow] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);
        const stationId = stationRow.id;
        const [ftRow] = await tx
          .select({ id: fuelType.id })
          .from(fuelType)
          .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);
        const fuelTypeId = ftRow.id;

        await tx.insert(fuelPriceObservation).values({
          stationId,
          fuelTypeId,
          priceTenthsCpl: 1234,
          sourceReportedAt: sydney(y, m, d - 2, 9, 0, 0),
          source: "NSW_FUEL_API",
          contentHash: `test-${Math.random().toString(36).slice(2)}`,
        });

        await runRollupJob(tx, now, targetDate);
        const [first] = await tx
          .select()
          .from(dailyPriceRollup)
          .where(
            sql`${dailyPriceRollup.stationId} = ${stationId} and ${dailyPriceRollup.fuelTypeId} = ${fuelTypeId} and ${dailyPriceRollup.priceDate} = ${targetDate}`,
          );

        await runRollupJob(tx, now, targetDate);
        const [second] = await tx
          .select()
          .from(dailyPriceRollup)
          .where(
            sql`${dailyPriceRollup.stationId} = ${stationId} and ${dailyPriceRollup.fuelTypeId} = ${fuelTypeId} and ${dailyPriceRollup.priceDate} = ${targetDate}`,
          );

        expect(second.timeWeightedAvgTenths).toBe(first.timeWeightedAvgTenths);
        expect(second.observationCount).toBe(first.observationCount);
        expect(second.computedAt.getTime()).toBeGreaterThanOrEqual(first.computedAt.getTime());

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 60_000);

  it("skips a pair whose only observation is its first-ever, on the target day itself (case C) — no row written", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const now = new Date();
        const targetDate = previousSydneyDate(sydneyDateOf(now));
        const { dayStart } = sydneyDayBoundary(targetDate);

        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], now);
        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);
        const [stationRow] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);
        const stationId = stationRow.id;
        const [ftRow] = await tx
          .select({ id: fuelType.id })
          .from(fuelType)
          .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);
        const fuelTypeId = ftRow.id;

        // Nothing before dayStart at all — this pair's very first observation is today.
        await tx.insert(fuelPriceObservation).values({
          stationId,
          fuelTypeId,
          priceTenthsCpl: 1500,
          sourceReportedAt: new Date(dayStart.getTime() + 60 * 60 * 1000),
          source: "NSW_FUEL_API",
          contentHash: `test-${Math.random().toString(36).slice(2)}`,
        });

        const result = await runRollupJob(tx, now, targetDate);
        expect(result.skippedByReason.no_prior_observation ?? 0).toBeGreaterThanOrEqual(1);

        const rows = await tx
          .select()
          .from(dailyPriceRollup)
          .where(
            sql`${dailyPriceRollup.stationId} = ${stationId} and ${dailyPriceRollup.fuelTypeId} = ${fuelTypeId} and ${dailyPriceRollup.priceDate} = ${targetDate}`,
          );
        expect(rows).toHaveLength(0);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 60_000);
});
