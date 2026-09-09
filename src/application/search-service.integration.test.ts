import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../infrastructure/db/client";
import {
  fuelPriceObservation,
  fuelType,
  recommendationLog,
  station,
} from "../infrastructure/db/schema";
import type { FuelType, Station } from "../infrastructure/fuel-api/types";
import { upsertFuelTypesFromReferenceData } from "../infrastructure/repositories/fuel-type-repository";
import { upsertStationsFromReferenceData } from "../infrastructure/repositories/station-repository";
import { runSearch } from "./search-service";

/**
 * Real Postgres, synthetic fixtures, zero API quota — end-to-end through every layer this
 * branch adds: the search query, the local-area aggregate, `rankCandidates` (from
 * feature/calc-engine-core), and the `recommendation_log` write. Built against a real search
 * area rather than mocks, per `20_SPRINT_PLAN.md` §20.6's "built against real station data."
 */

class IntentionalTestRollback extends Error {}

function testStation(overrides: Partial<Station> = {}): Station {
  return {
    sourceStationCode: `TEST_${Math.random().toString(36).slice(2)}`,
    source: "NSW_FUEL_API",
    name: "Integration Test Station",
    brand: "Acme",
    addressLine: "1 Test St",
    latitude: -33.87,
    longitude: 151.21,
    state: "NSW",
    ...overrides,
  };
}

describe("runSearch against real Postgres", () => {
  it("finds, ranks, and persists a real recommendation from real nearby fixtures", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const origin = { latitude: -33.87, longitude: 151.21 };
        const cheap = testStation({ latitude: -33.871, longitude: 151.211 });
        const expensive = testStation({ latitude: -33.872, longitude: 151.212 });
        await upsertStationsFromReferenceData(tx, [cheap, expensive], new Date());

        const [cheapRow] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${cheap.sourceStationCode}`);
        const [expensiveRow] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${expensive.sourceStationCode}`);

        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);
        const [ftRow] = await tx
          .select({ id: fuelType.id })
          .from(fuelType)
          .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);

        const now = new Date();
        await tx.insert(fuelPriceObservation).values([
          {
            stationId: cheapRow.id,
            fuelTypeId: ftRow.id,
            priceTenthsCpl: 1650,
            sourceReportedAt: now,
            source: "NSW_FUEL_API",
            contentHash: `test-${Math.random().toString(36).slice(2)}`,
          },
          {
            stationId: expensiveRow.id,
            fuelTypeId: ftRow.id,
            priceTenthsCpl: 1950,
            sourceReportedAt: now,
            source: "NSW_FUEL_API",
            contentHash: `test-${Math.random().toString(36).slice(2)}`,
          },
        ]);

        const outcome = await runSearch(tx, {
          origin,
          maxDetourKm: 10,
          fuelTypeCode: ft.sourceCode,
          vehicleProfile: null,
          now,
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error("unreachable");
        expect(outcome.value.result.recommended.stationId).toBe(cheapRow.id);
        expect(outcome.value.result.mode).toBe("comparison");
        expect(outcome.value.result.reasonCodes.length).toBeGreaterThan(0);

        const [loggedRow] = await tx
          .select()
          .from(recommendationLog)
          .where(sql`${recommendationLog.id} = ${outcome.value.recommendationLogId}`);
        expect(loggedRow).toBeDefined();
        expect(loggedRow.recommendedStationId).toBe(cheapRow.id);
        expect(loggedRow.engineVersion).toBe(outcome.value.result.engineVersion);
        expect(loggedRow.reasonCodes).toEqual(outcome.value.result.reasonCodes);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("returns unknown_fuel_type for a fuel type code that doesn't exist, without writing anything", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const outcome = await runSearch(tx, {
          origin: { latitude: -33.87, longitude: 151.21 },
          maxDetourKm: 10,
          fuelTypeCode: "NOT_A_REAL_FUEL_TYPE_CODE",
          vehicleProfile: null,
          now: new Date(),
        });
        expect(outcome).toEqual({ ok: false, error: { type: "unknown_fuel_type" } });

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("returns no_eligible_candidates when nothing real fuel type exists but no station is nearby, without writing anything", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const ft: FuelType = { sourceCode: `TESTFT_EMPTY_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);

        // A search point in the middle of the Tasman Sea — no real or synthetic station is
        // ever going to be within 1km of this, deliberately.
        const outcome = await runSearch(tx, {
          origin: { latitude: -40.0, longitude: 160.0 },
          maxDetourKm: 2,
          fuelTypeCode: ft.sourceCode,
          vehicleProfile: null,
          now: new Date(),
        });
        expect(outcome).toEqual({ ok: false, error: { type: "no_eligible_candidates" } });

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);
});
