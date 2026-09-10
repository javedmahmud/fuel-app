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
  loadLastRetrievedAt,
  loadRecentFullSyncInsertedCounts,
  loadUnprocessedJournalReceivedAts,
} from "./observability-repository";

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
});
