import { describe, expect, it } from "vitest";

import { getDb } from "../db/client";
import { apiResponseJournal, fuelPriceObservation, ingestionRun } from "../db/schema";
import type { FuelType, Station } from "../fuel-api/types";
import {
  loadActiveFuelTypeCodeToId,
  upsertFuelTypesFromReferenceData,
} from "./fuel-type-repository";
import { loadKnownStationCodeToId, upsertStationsFromReferenceData } from "./station-repository";
import {
  loadDegradedIngestionDates,
  loadLastRetrievedAt,
  loadRecentFullSyncInsertedCounts,
  loadUnprocessedJournalReceivedAts,
} from "./observability-repository";
import { sydneyDateOf } from "../../domain/rollup/day-boundary";

/**
 * Real Postgres, synthetic fixtures deliberately timestamped ahead of "now" (or with a
 * distinctive value) so each assertion is exact and unaffected by whatever real data the live
 * hourly cron has also written — same "check specific rows, not aggregate state" reasoning as
 * repositories.integration.test.ts, applied here as "make my fixture unambiguously the max/most
 * recent" instead. Zero API quota. Rolled-back transaction, same pattern throughout this repo.
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

describe("observability-repository against real Postgres", () => {
  it("loadLastRetrievedAt returns the true max retrieved_at, including a fixture set ahead of real data", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], new Date());
        const stationIds = await loadKnownStationCodeToId(tx);
        const stationId = stationIds.get(s.sourceStationCode) as string;

        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);
        const fuelTypeIds = await loadActiveFuelTypeCodeToId(tx);
        const fuelTypeId = fuelTypeIds.get(ft.sourceCode) as string;

        // Ahead of any real, currently-existing row — guarantees this is the true max
        // regardless of what the live hourly cron has already written.
        const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
        await tx.insert(fuelPriceObservation).values({
          stationId,
          fuelTypeId,
          priceTenthsCpl: 1789,
          sourceReportedAt: new Date(),
          retrievedAt: farFuture,
          source: "NSW_FUEL_API",
          contentHash: `test-${Math.random().toString(36).slice(2)}`,
        });

        const lastRetrievedAt = await loadLastRetrievedAt(tx);
        expect(lastRetrievedAt?.getTime()).toBe(farFuture.getTime());

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("loadUnprocessedJournalReceivedAts includes an unprocessed row and excludes a processed one", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const [run] = await tx
          .insert(ingestionRun)
          .values({ jobType: "new_prices", status: "running", startedAt: new Date() })
          .returning({ id: ingestionRun.id });

        const unprocessedAt = new Date(Date.now() - 5 * 60_000);
        await tx.insert(apiResponseJournal).values({
          ingestionRunId: run.id,
          endpoint: "/test/unprocessed",
          httpStatus: 200,
          rawBody: Buffer.from("{}"),
          status: "unprocessed",
          receivedAt: unprocessedAt,
        });
        await tx.insert(apiResponseJournal).values({
          ingestionRunId: run.id,
          endpoint: "/test/processed",
          httpStatus: 200,
          rawBody: Buffer.from("{}"),
          status: "processed",
          receivedAt: new Date(Date.now() - 5 * 60_000),
        });

        const receivedAts = await loadUnprocessedJournalReceivedAts(tx);
        expect(receivedAts.some((d) => d.getTime() === unprocessedAt.getTime())).toBe(true);
        // Exactly one row should match this specific timestamp+endpoint combination — the
        // processed row (same receivedAt, different status) must not sneak in.
        expect(receivedAts.filter((d) => d.getTime() === unprocessedAt.getTime())).toHaveLength(1);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("loadRecentFullSyncInsertedCounts returns only successful full_sync runs, most recent first", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const base = Date.now() + 365 * 24 * 60 * 60 * 1000; // ahead of any real run

        async function insertRun(
          finishedAt: Date,
          status: "success" | "failed",
          recordsPersisted: number,
        ) {
          await tx.insert(ingestionRun).values({
            jobType: "full_sync",
            status,
            startedAt: finishedAt,
            finishedAt,
            recordsPersisted,
          });
        }

        // Oldest of the three fixtures — must not appear in a limit-2 query.
        await insertRun(new Date(base), "success", 111);
        // A failed run more recent than the above — must be excluded regardless of recency.
        await insertRun(new Date(base + 1000), "failed", 999);
        // The two most recent successful runs — exactly what should come back, in this order.
        await insertRun(new Date(base + 2000), "success", 42);
        await insertRun(new Date(base + 3000), "success", 7);

        const counts = await loadRecentFullSyncInsertedCounts(tx, 2);
        expect(counts).toEqual([7, 42]);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("loadDegradedIngestionDates includes failed/partial new_prices & full_sync runs, excludes success and out-of-scope job types", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        // Ahead of any real run — this window is guaranteed to contain only this test's fixtures.
        const base = Date.now() + 400 * 24 * 60 * 60 * 1000;
        const day = (offsetMs: number) => new Date(base + offsetMs);

        async function insertRun(
          jobType: "new_prices" | "full_sync" | "ref_data" | "rollup",
          status: "success" | "failed" | "partial" | "skipped_budget" | "skipped_circuit",
          startedAt: Date,
        ) {
          await tx.insert(ingestionRun).values({ jobType, status, startedAt });
        }

        const failedDay = day(0);
        const partialDay = day(2 * 24 * 60 * 60 * 1000);
        const successDay = day(4 * 24 * 60 * 60 * 1000);
        const wrongJobTypeDay = day(6 * 24 * 60 * 60 * 1000);
        const outOfRangeDay = day(-30 * 24 * 60 * 60 * 1000); // before `since` — must be excluded

        await insertRun("new_prices", "failed", failedDay);
        await insertRun("full_sync", "partial", partialDay);
        await insertRun("new_prices", "success", successDay); // healthy — must not appear
        await insertRun("ref_data", "failed", wrongJobTypeDay); // wrong job type — must not appear
        await insertRun("new_prices", "failed", outOfRangeDay);

        const since = day(-1 * 24 * 60 * 60 * 1000);
        const until = day(10 * 24 * 60 * 60 * 1000);
        const degradedDates = await loadDegradedIngestionDates(tx, since, until);

        expect(degradedDates.has(sydneyDateOf(failedDay))).toBe(true);
        expect(degradedDates.has(sydneyDateOf(partialDay))).toBe(true);
        expect(degradedDates.has(sydneyDateOf(successDay))).toBe(false);
        expect(degradedDates.has(sydneyDateOf(wrongJobTypeDay))).toBe(false);
        expect(degradedDates.has(sydneyDateOf(outOfRangeDay))).toBe(false);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);
});
