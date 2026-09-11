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
import { runCommute } from "./commute-service";

/**
 * Real Postgres, synthetic fixtures, zero API quota — end-to-end through every layer this branch
 * adds: the corridor query, the local-area aggregate, `rankCandidates` wired to
 * `feature/commute-geometry`'s `corridorDetourKm` strategy, and the `recommendation_log` write.
 * Deliberate mirror of `search-service.integration.test.ts`'s own structure.
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

describe("runCommute against real Postgres", () => {
  it("finds, ranks (by real corridor detour, not origin-radial), and persists a real recommendation", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        // Sydney -> Canberra. Goulburn (near-route) is cheaper AND on-route; a same-priced
        // station much closer to Sydney by straight-line distance but off-route (Wollongong)
        // must lose despite that — this is the actual scenario this whole branch exists for,
        // proven here through the real HTTP-adjacent orchestration layer, not just the pure
        // domain function (already covered by rank-candidates.test.ts's own end-to-end test).
        const origin = { latitude: -33.8688, longitude: 151.2093 };
        const destination = { latitude: -35.3081, longitude: 149.1244 };
        const goulburn = testStation({ latitude: -34.7539, longitude: 149.7161 });
        const wollongong = testStation({ latitude: -34.4278, longitude: 150.8931 });
        await upsertStationsFromReferenceData(tx, [goulburn, wollongong], new Date());

        const [goulburnRow] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${goulburn.sourceStationCode}`);
        const [wollongongRow] = await tx
          .select({ id: station.id })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${wollongong.sourceStationCode}`);

        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);
        const [ftRow] = await tx
          .select({ id: fuelType.id })
          .from(fuelType)
          .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);

        const now = new Date();
        await tx.insert(fuelPriceObservation).values([
          {
            stationId: goulburnRow.id,
            fuelTypeId: ftRow.id,
            priceTenthsCpl: 1799,
            sourceReportedAt: now,
            source: "NSW_FUEL_API",
            contentHash: `test-${Math.random().toString(36).slice(2)}`,
          },
          {
            stationId: wollongongRow.id,
            fuelTypeId: ftRow.id,
            priceTenthsCpl: 1799, // same price — detour is the only differentiator
            sourceReportedAt: now,
            source: "NSW_FUEL_API",
            contentHash: `test-${Math.random().toString(36).slice(2)}`,
          },
        ]);

        const outcome = await runCommute(tx, {
          origin,
          destination,
          maxDetourKm: 50,
          fuelTypeCode: ft.sourceCode,
          vehicleProfile: null,
          now,
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error("unreachable");
        expect(outcome.value.result.recommended.stationId).toBe(goulburnRow.id);
        expect(outcome.value.result.mode).toBe("comparison");
        expect(outcome.value.result.reasonCodes.length).toBeGreaterThan(0);

        const [loggedRow] = await tx
          .select()
          .from(recommendationLog)
          .where(sql`${recommendationLog.id} = ${outcome.value.recommendationLogId}`);
        expect(loggedRow).toBeDefined();
        expect(loggedRow.recommendedStationId).toBe(goulburnRow.id);
        expect(loggedRow.engineVersion).toBe(outcome.value.result.engineVersion);

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
        const outcome = await runCommute(tx, {
          origin: { latitude: -33.8688, longitude: 151.2093 },
          destination: { latitude: -35.3081, longitude: 149.1244 },
          maxDetourKm: 20,
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

  it("returns no_eligible_candidates for a real fuel type but a route with no nearby station", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const ft: FuelType = { sourceCode: `TESTFT_EMPTY_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);

        // A "commute" entirely within the middle of the Tasman Sea — no real or synthetic
        // station is ever going to be near this corridor, deliberately.
        const outcome = await runCommute(tx, {
          origin: { latitude: -40.0, longitude: 160.0 },
          destination: { latitude: -41.0, longitude: 161.0 },
          maxDetourKm: 5,
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
