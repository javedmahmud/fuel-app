import { fromZonedTime } from "date-fns-tz";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../infrastructure/db/client";
import { fuelPriceObservation, fuelType, ingestionRun, station } from "../infrastructure/db/schema";
import type { FuelType, Station } from "../infrastructure/fuel-api/types";
import { sydneyDateRangeEndingAt } from "../domain/rollup/day-boundary";
import { upsertFuelTypesFromReferenceData } from "../infrastructure/repositories/fuel-type-repository";
import {
  upsertDailyRollups,
  type DailyRollupRow,
} from "../infrastructure/repositories/rollup-repository";
import { upsertStationsFromReferenceData } from "../infrastructure/repositories/station-repository";
import { handleStationHistoryRequest } from "./handle-station-history-request";

/**
 * Contract tests for `GET /api/v1/stations/{stationId}/history` (`21_DETAILED_DESIGN.md` §21.1,
 * UC-06). Same rolled-back-transaction pattern as the other `handle-*-request.integration.test.ts`
 * files. `now` is a fixed instant throughout — the handler's own "window ends yesterday, not
 * today" rule (see the handler's module comment) makes the exact date matter for every fixture.
 */

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

const SYDNEY_TZ = "Australia/Sydney";
function sydney(y: number, m: number, d: number, hh: number, mm: number, ss = 0): Date {
  return fromZonedTime(new Date(y, m - 1, d, hh, mm, ss), SYDNEY_TZ);
}

// A fixed "now" — 2026-06-20, mid-morning Sydney time. The window "ends yesterday", so every
// fixture below is dated relative to 2026-06-19.
const NOW = sydney(2026, 6, 20, 10, 0, 0);
const LATEST_COMPLETE_DAY = "2026-06-19";

class IntentionalTestRollback extends Error {}

function testStation(overrides: Partial<Station> = {}): Station {
  return {
    sourceStationCode: `TEST_${Math.random().toString(36).slice(2)}`,
    source: "NSW_FUEL_API",
    name: "Contract Test Station",
    brand: "Acme",
    addressLine: "1 Test St",
    latitude: -33.87,
    longitude: 151.21,
    state: "NSW",
    ...overrides,
  };
}

async function seedStationAndFuelType(tx: Tx) {
  const s = testStation();
  await upsertStationsFromReferenceData(tx, [s], new Date());
  const [stationRow] = await tx
    .select({ id: station.id })
    .from(station)
    .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);

  const ft: FuelType = {
    sourceCode: `TESTFT_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    displayName: "Test Unleaded",
  };
  await upsertFuelTypesFromReferenceData(tx, [ft]);
  const [ftRow] = await tx
    .select({ id: fuelType.id })
    .from(fuelType)
    .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);

  return {
    stationId: stationRow.id as string,
    fuelTypeId: ftRow.id as string,
    fuelTypeCode: ft.sourceCode,
  };
}

function rollupRow(
  stationId: string,
  fuelTypeId: string,
  priceDate: string,
  avgTenths: number,
): DailyRollupRow {
  return {
    stationId,
    fuelTypeId,
    priceDate,
    timeWeightedAvgTenths: avgTenths,
    minTenthsCpl: avgTenths - 10,
    maxTenthsCpl: avgTenths + 10,
    openTenthsCpl: avgTenths,
    closeTenthsCpl: avgTenths,
    observationCount: 1,
    carriedForward: false,
    openingPriceAgeDays: 0,
    partialDay: false,
    methodVersion: "v1",
    computedAt: new Date(),
  };
}

async function withRollback(fn: (tx: Tx) => Promise<void>) {
  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw new IntentionalTestRollback();
    });
  } catch (e) {
    if (!(e instanceof IntentionalTestRollback)) throw e;
  }
}

describe("handleStationHistoryRequest against real Postgres", () => {
  it("200s with stats/trend/series/current when there's a full window of rollup rows and no gaps", async () => {
    await withRollback(async (tx) => {
      const { stationId, fuelTypeId, fuelTypeCode } = await seedStationAndFuelType(tx);
      const dates = sydneyDateRangeEndingAt(LATEST_COMPLETE_DAY, 10);
      // Rising price each day: 1900, 1910, ..., 1990 — trend must come out "rising".
      await upsertDailyRollups(
        tx,
        dates.map((d, i) => rollupRow(stationId, fuelTypeId, d, 1900 + i * 10)),
      );
      await tx.insert(fuelPriceObservation).values({
        stationId,
        fuelTypeId,
        priceTenthsCpl: 2000,
        sourceReportedAt: NOW,
        source: "NSW_FUEL_API",
        contentHash: `test-${Math.random().toString(36).slice(2)}`,
      });

      const result = await handleStationHistoryRequest(
        tx,
        stationId,
        new URLSearchParams({ fuelType: fuelTypeCode, days: "10" }),
        NOW,
      );

      expect(result.status).toBe(200);
      const body = result.body as {
        historyDays: number;
        current: { centsPerLitre: number } | null;
        stats: {
          minCentsPerLitre: number;
          maxCentsPerLitre: number;
          averageCentsPerLitre: number;
          percentile: number | null;
        };
        trend: { direction: string };
        series: unknown[];
        coverageNote: string | null;
      };
      expect(body.historyDays).toBe(10);
      expect(body.current?.centsPerLitre).toBeCloseTo(200.0);
      expect(body.stats.minCentsPerLitre).toBeCloseTo(189.0);
      expect(body.stats.maxCentsPerLitre).toBeCloseTo(200.0);
      expect(body.trend.direction).toBe("rising");
      expect(body.series).toHaveLength(10);
      expect(body.coverageNote).toBeNull();
    });
  }, 30_000);

  it("404s with an insufficient_history body when fewer than 7 days of rollup rows exist", async () => {
    await withRollback(async (tx) => {
      const { stationId, fuelTypeId, fuelTypeCode } = await seedStationAndFuelType(tx);
      const dates = sydneyDateRangeEndingAt(LATEST_COMPLETE_DAY, 3);
      await upsertDailyRollups(
        tx,
        dates.map((d, i) => rollupRow(stationId, fuelTypeId, d, 1900 + i)),
      );

      const result = await handleStationHistoryRequest(
        tx,
        stationId,
        new URLSearchParams({ fuelType: fuelTypeCode }),
        NOW,
      );

      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({
        error: "insufficient_history",
        historyDays: 3,
        minimumRequired: 7,
      });
    });
  }, 30_000);

  it("sets coverageNote when a day in the window has no rollup row at all", async () => {
    await withRollback(async (tx) => {
      const { stationId, fuelTypeId, fuelTypeCode } = await seedStationAndFuelType(tx);
      const dates = sydneyDateRangeEndingAt(LATEST_COMPLETE_DAY, 8);
      const withGap = dates.filter((_, i) => i !== 3); // skip one day in the middle — still 7 rows
      await upsertDailyRollups(
        tx,
        withGap.map((d, i) => rollupRow(stationId, fuelTypeId, d, 1900 + i)),
      );

      const result = await handleStationHistoryRequest(
        tx,
        stationId,
        new URLSearchParams({ fuelType: fuelTypeCode, days: "8" }),
        NOW,
      );

      expect(result.status).toBe(200);
      const body = result.body as { coverageNote: string | null; historyDays: number };
      expect(body.historyDays).toBe(7);
      expect(body.coverageNote).not.toBeNull();
    });
  }, 30_000);

  it("sets coverageNote when the ingestion log shows a degraded run on a day that still has a rollup row", async () => {
    await withRollback(async (tx) => {
      const { stationId, fuelTypeId, fuelTypeCode } = await seedStationAndFuelType(tx);
      const dates = sydneyDateRangeEndingAt(LATEST_COMPLETE_DAY, 7);
      await upsertDailyRollups(
        tx,
        dates.map((d, i) => rollupRow(stationId, fuelTypeId, d, 1900 + i)),
      );
      // A failed new_prices run squarely inside the middle day of the window.
      await tx.insert(ingestionRun).values({
        jobType: "new_prices",
        status: "failed",
        startedAt: sydney(2026, 6, 15, 9, 0, 0),
      });

      const result = await handleStationHistoryRequest(
        tx,
        stationId,
        new URLSearchParams({ fuelType: fuelTypeCode, days: "7" }),
        NOW,
      );

      expect(result.status).toBe(200);
      const body = result.body as { coverageNote: string | null };
      expect(body.coverageNote).not.toBeNull();
    });
  }, 30_000);

  it("400s for an unknown fuel type", async () => {
    await withRollback(async (tx) => {
      const { stationId } = await seedStationAndFuelType(tx);
      const result = await handleStationHistoryRequest(
        tx,
        stationId,
        new URLSearchParams({ fuelType: "NOT_A_REAL_CODE" }),
        NOW,
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: "unknown_fuel_type" });
    });
  }, 30_000);

  it("400s for a malformed stationId", async () => {
    await withRollback(async (tx) => {
      const result = await handleStationHistoryRequest(
        tx,
        "not-a-uuid",
        new URLSearchParams({ fuelType: "U91" }),
        NOW,
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: "invalid_station_id" });
    });
  }, 30_000);

  it("404s station_not_found for a well-formed but nonexistent stationId, before checking history", async () => {
    await withRollback(async (tx) => {
      const result = await handleStationHistoryRequest(
        tx,
        "00000000-0000-0000-0000-000000000000",
        new URLSearchParams({ fuelType: "U91" }),
        NOW,
      );
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ error: "station_not_found" });
    });
  }, 30_000);

  it("400s when days exceeds the 90-day retention cap", async () => {
    await withRollback(async (tx) => {
      const { stationId, fuelTypeCode } = await seedStationAndFuelType(tx);
      const result = await handleStationHistoryRequest(
        tx,
        stationId,
        new URLSearchParams({ fuelType: fuelTypeCode, days: "91" }),
        NOW,
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: "invalid_query" });
    });
  }, 30_000);
});
