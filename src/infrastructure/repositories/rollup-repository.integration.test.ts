import { eq, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { describe, expect, it } from "vitest";

import { getDb } from "../db/client";
import { dailyPriceRollup, fuelPriceObservation, fuelType, station } from "../db/schema";
import type { FuelType, Station } from "../fuel-api/types";
import { sydneyDayBoundary } from "../../domain/rollup/day-boundary";
import { upsertFuelTypesFromReferenceData } from "./fuel-type-repository";
import { upsertStationsFromReferenceData } from "./station-repository";
import {
  deleteDailyRollupsForDate,
  loadDayEvents,
  loadOpeningPrices,
  loadRollupSeries,
  loadStationsDeactivatedDuring,
  upsertDailyRollups,
  type DailyRollupRow,
} from "./rollup-repository";

/**
 * Real Postgres, synthetic (own-generated) station/fuel-type fixtures, zero API quota — same
 * rolled-back-transaction pattern as repositories.integration.test.ts. Targets the two SQL
 * constructs that are new and easy to get subtly wrong: `selectDistinctOn` (loadOpeningPrices)
 * and the tuple-OR delete (deleteDailyRollupsForDate) — neither has a plain-SQL analogue
 * elsewhere in this codebase to lean on, so this is the only place they get checked against a
 * real query planner rather than a mock.
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

async function insertObservation(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  args: {
    stationId: string;
    fuelTypeId: string;
    priceTenthsCpl: number;
    sourceReportedAt: Date;
    retrievedAt?: Date;
  },
) {
  await tx.insert(fuelPriceObservation).values({
    stationId: args.stationId,
    fuelTypeId: args.fuelTypeId,
    priceTenthsCpl: args.priceTenthsCpl,
    sourceReportedAt: args.sourceReportedAt,
    retrievedAt: args.retrievedAt ?? args.sourceReportedAt,
    source: "NSW_FUEL_API",
    contentHash: `test-${Math.random().toString(36).slice(2)}-${Date.now()}-${Math.random()}`,
  });
}

describe("rollup-repository against real Postgres", () => {
  it("loadOpeningPrices picks the most recent pre-dayStart observation per pair, and resolves a tie by retrieved_at (case D)", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], new Date());
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

        const { dayStart } = sydneyDayBoundary("2026-06-15");
        const tiedAt = sydney(2026, 6, 10, 9, 0, 0);

        // Older candidate — must lose to the more recent one below regardless of insert order.
        await insertObservation(tx, {
          stationId,
          fuelTypeId,
          priceTenthsCpl: 1000,
          sourceReportedAt: sydney(2026, 6, 5, 9, 0, 0),
        });
        // Case D: two rows at the exact same sourceReportedAt — later retrievedAt must win.
        await insertObservation(tx, {
          stationId,
          fuelTypeId,
          priceTenthsCpl: 1400,
          sourceReportedAt: tiedAt,
          retrievedAt: sydney(2026, 6, 10, 9, 0, 5),
        });
        await insertObservation(tx, {
          stationId,
          fuelTypeId,
          priceTenthsCpl: 1500,
          sourceReportedAt: tiedAt,
          retrievedAt: sydney(2026, 6, 10, 9, 5, 0),
        });
        // On/after dayStart — must never be picked as an "opening" candidate.
        await insertObservation(tx, {
          stationId,
          fuelTypeId,
          priceTenthsCpl: 9999,
          sourceReportedAt: dayStart,
        });

        const openings = await loadOpeningPrices(tx, dayStart);
        const mine = openings.find((o) => o.stationId === stationId && o.fuelTypeId === fuelTypeId);

        expect(mine?.priceTenthsCpl).toBe(1500);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("loadDayEvents returns only observations inside [dayStart, dayEnd)", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], new Date());
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

        const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");

        await insertObservation(tx, {
          stationId,
          fuelTypeId,
          priceTenthsCpl: 1,
          sourceReportedAt: new Date(dayStart.getTime() - 1000), // just before — excluded
        });
        await insertObservation(tx, {
          stationId,
          fuelTypeId,
          priceTenthsCpl: 2,
          sourceReportedAt: dayStart, // inclusive lower bound
        });
        await insertObservation(tx, {
          stationId,
          fuelTypeId,
          priceTenthsCpl: 3,
          sourceReportedAt: new Date(dayEnd.getTime() - 1000), // just before dayEnd — included
        });
        await insertObservation(tx, {
          stationId,
          fuelTypeId,
          priceTenthsCpl: 4,
          sourceReportedAt: dayEnd, // exclusive upper bound
        });

        const events = await loadDayEvents(tx, dayStart, dayEnd);
        const mine = events
          .filter((e) => e.stationId === stationId && e.fuelTypeId === fuelTypeId)
          .map((e) => e.priceTenthsCpl)
          .sort((a, b) => a - b);

        expect(mine).toEqual([2, 3]);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("loadStationsDeactivatedDuring finds only inactive stations whose last_seen_at falls in the window", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], new Date());
        const [stationRow] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);
        const stationId = stationRow.id;

        const { dayStart, dayEnd } = sydneyDayBoundary("2026-06-15");
        const deactivatedAt = new Date(dayStart.getTime() + 3 * 60 * 60 * 1000);

        await tx
          .update(station)
          .set({ lifecycleState: "inactive", lastSeenAt: deactivatedAt })
          .where(eq(station.id, stationId));

        const found = await loadStationsDeactivatedDuring(tx, dayStart, dayEnd);
        expect(found.get(stationId)?.getTime()).toBe(deactivatedAt.getTime());

        // A station deactivated on some other day must not show up for this one.
        const { dayStart: otherStart, dayEnd: otherEnd } = sydneyDayBoundary("2026-06-16");
        const foundOther = await loadStationsDeactivatedDuring(tx, otherStart, otherEnd);
        expect(foundOther.has(stationId)).toBe(false);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("upsertDailyRollups fully replaces a prior row for the same (station, fuel type, day), and deleteDailyRollupsForDate removes a stale one", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], new Date());
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

        const priceDate = "2026-06-15";
        const base: DailyRollupRow = {
          stationId,
          fuelTypeId,
          priceDate,
          timeWeightedAvgTenths: 1000,
          minTenthsCpl: 1000,
          maxTenthsCpl: 1000,
          openTenthsCpl: 1000,
          closeTenthsCpl: 1000,
          observationCount: 0,
          carriedForward: true,
          openingPriceAgeDays: 1,
          partialDay: false,
          methodVersion: "v1",
          computedAt: new Date(),
        };

        await upsertDailyRollups(tx, [base]);
        // Full replace, not merge: every field changes on the second write.
        await upsertDailyRollups(tx, [
          { ...base, timeWeightedAvgTenths: 2000, observationCount: 3, methodVersion: "v2" },
        ]);

        const [row] = await tx
          .select()
          .from(dailyPriceRollup)
          .where(
            sql`${dailyPriceRollup.stationId} = ${stationId} and ${dailyPriceRollup.fuelTypeId} = ${fuelTypeId} and ${dailyPriceRollup.priceDate} = ${priceDate}`,
          );
        expect(row.timeWeightedAvgTenths).toBe(2000);
        expect(row.observationCount).toBe(3);
        expect(row.methodVersion).toBe("v2");

        const { deleted } = await deleteDailyRollupsForDate(
          tx,
          [{ stationId, fuelTypeId }],
          priceDate,
        );
        expect(deleted).toBe(1);

        const remaining = await tx
          .select()
          .from(dailyPriceRollup)
          .where(
            sql`${dailyPriceRollup.stationId} = ${stationId} and ${dailyPriceRollup.fuelTypeId} = ${fuelTypeId} and ${dailyPriceRollup.priceDate} = ${priceDate}`,
          );
        expect(remaining).toHaveLength(0);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("loadRollupSeries returns only the requested (station, fuel type)'s rows inside [sinceDate, untilDate], ascending", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], new Date());
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

        function row(priceDate: string, timeWeightedAvgTenths: number): DailyRollupRow {
          return {
            stationId,
            fuelTypeId,
            priceDate,
            timeWeightedAvgTenths,
            minTenthsCpl: timeWeightedAvgTenths,
            maxTenthsCpl: timeWeightedAvgTenths,
            openTenthsCpl: timeWeightedAvgTenths,
            closeTenthsCpl: timeWeightedAvgTenths,
            observationCount: 1,
            carriedForward: false,
            openingPriceAgeDays: 0,
            partialDay: false,
            methodVersion: "v1",
            computedAt: new Date(),
          };
        }

        await upsertDailyRollups(tx, [
          row("2026-06-13", 1900), // before the window — must be excluded
          row("2026-06-14", 2000),
          row("2026-06-15", 2010),
          row("2026-06-16", 2020),
          row("2026-06-17", 2030), // after the window — must be excluded
        ]);

        const series = await loadRollupSeries(
          tx,
          stationId,
          fuelTypeId,
          "2026-06-14",
          "2026-06-16",
        );

        expect(series.map((r) => r.priceDate)).toEqual(["2026-06-14", "2026-06-15", "2026-06-16"]);
        expect(series.map((r) => r.timeWeightedAvgTenths)).toEqual([2000, 2010, 2020]);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);
});
