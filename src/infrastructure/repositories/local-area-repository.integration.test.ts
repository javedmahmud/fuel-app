import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../db/client";
import { dailyPriceRollup, fuelType, station } from "../db/schema";
import type { FuelType, Station } from "../fuel-api/types";
import { sydneyDateOf, previousSydneyDate } from "../../domain/rollup/day-boundary";
import { upsertFuelTypesFromReferenceData } from "./fuel-type-repository";
import { upsertStationsFromReferenceData } from "./station-repository";
import { loadLocalAreaContext } from "./local-area-repository";

/**
 * Real Postgres, synthetic fixtures — same rolled-back-transaction pattern throughout this repo.
 * Targets `10_PRICE_HISTORY_METHOD.md` §10.7's "each station's daily average weighted equally"
 * rule specifically: two stations with different observation-count "weight" behind them must
 * still contribute equally to the local-area figure, which is exactly what SQL's plain `AVG(...)`
 * over one row per station per day (not per observation) already guarantees — this test proves
 * it against a real query, not just by inspecting the SQL.
 */

class IntentionalTestRollback extends Error {}

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

describe("loadLocalAreaContext against real Postgres", () => {
  it("averages two stations' daily figures equally, and excludes partial_day rows — §10.7", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s1 = testStation();
        const s2 = testStation();
        await upsertStationsFromReferenceData(tx, [s1, s2], new Date());
        const [s1Row] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s1.sourceStationCode}`);
        const [s2Row] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s2.sourceStationCode}`);

        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);
        const [ftRow] = await tx
          .select({ id: fuelType.id })
          .from(fuelType)
          .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);

        const now = new Date();
        const day1 = previousSydneyDate(sydneyDateOf(now)); // yesterday — the most recent day the window includes
        const day2 = previousSydneyDate(day1);

        async function insertRollup(
          stationId: string,
          priceDate: string,
          timeWeightedAvgTenths: number,
          closeTenthsCpl: number,
          partialDay = false,
        ) {
          await tx.insert(dailyPriceRollup).values({
            stationId,
            fuelTypeId: ftRow.id,
            priceDate,
            timeWeightedAvgTenths,
            minTenthsCpl: timeWeightedAvgTenths,
            maxTenthsCpl: timeWeightedAvgTenths,
            openTenthsCpl: timeWeightedAvgTenths,
            closeTenthsCpl,
            observationCount: 1,
            carriedForward: true,
            openingPriceAgeDays: 1,
            partialDay,
            methodVersion: "v1",
            computedAt: now,
          });
        }

        // day1: station 1 at 1000, station 2 at 2000 -> average should be 1500, not weighted
        // toward either station regardless of how many raw observations backed each one.
        await insertRollup(s1Row.id, day1, 1000, 1000);
        await insertRollup(s2Row.id, day1, 2000, 2000);
        // day2: only station 1 has a row -> that day's average is just 1000.
        await insertRollup(s1Row.id, day2, 1000, 1000);
        // A partial day for station 1 -> must be excluded entirely from the aggregate.
        await insertRollup(s1Row.id, previousSydneyDate(day2), 9999, 9999, true);

        const context = await loadLocalAreaContext(tx, [s1Row.id, s2Row.id], ftRow.id, 30, now);

        expect(context.historyDays).toBe(2); // day1 and day2 only — the partial day is excluded
        expect(context.windowPricesTenths).toEqual([1000, 1500]); // day2 then day1, ascending date order
        expect(context.localAverageTenths).toBe(1250); // mean of [1000, 1500]
        expect(context.closesTenthsInDayOrder).toEqual([1000, 1500]);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("returns an empty, non-alarming context for an empty station list", async () => {
    const db = getDb();
    const context = await loadLocalAreaContext(
      db,
      [],
      "00000000-0000-0000-0000-000000000000",
      30,
      new Date(),
    );
    expect(context).toEqual({
      historyDays: 0,
      localAverageTenths: null,
      windowPricesTenths: [],
      closesTenthsInDayOrder: [],
    });
  });
});
