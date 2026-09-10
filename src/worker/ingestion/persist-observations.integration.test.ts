import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../../infrastructure/db/client";
import { ingestionRun, station } from "../../infrastructure/db/schema";
import type { FuelType, PriceObservation, Station } from "../../infrastructure/fuel-api/types";
import { upsertFuelTypesFromReferenceData } from "../../infrastructure/repositories/fuel-type-repository";
import {
  loadKnownStationCodeToId,
  upsertStationsFromReferenceData,
} from "../../infrastructure/repositories/station-repository";
import { persistObservations } from "./persist-observations";

/**
 * Real Postgres, synthetic data, zero API quota — same rolled-back-transaction pattern as
 * repositories.integration.test.ts. Covers persist-observations.ts's own responsibility (gate
 * -> hash -> insert, plus the "EV" non-priced-fuel-type filter added investigating a real
 * full_sync run's rejection-rate alarm) directly, rather than only indirectly through
 * jobs.test.ts's mocks. Run manually: see vitest.integration.config.mts.
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

describe("persistObservations against real Postgres", () => {
  it("skips a known non-priced fuel type (EV) without counting it as rejected, but still persists a real observation for the same station", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const [run] = await tx
          .insert(ingestionRun)
          .values({ jobType: "new_prices", status: "running", startedAt: new Date() })
          .returning({ id: ingestionRun.id });

        const s = testStation();
        await upsertStationsFromReferenceData(tx, [s], new Date());
        const stationIds = await loadKnownStationCodeToId(tx);
        expect(stationIds.has(s.sourceStationCode)).toBe(true);

        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);

        const now = new Date();
        const realPrice: PriceObservation = {
          sourceStationCode: s.sourceStationCode,
          fuelTypeSourceCode: ft.sourceCode,
          priceTenthsCpl: 1789,
          sourceReportedAt: now,
          raw: {
            stationcode: 1,
            state: "NSW",
            fueltype: ft.sourceCode,
            price: 178.9,
            lastupdated: "x",
          },
        };
        // Same station, "EV" placeholder — price=0, never a known/active fuel type in
        // reference data (matches the real API's shape: it sends this for every station).
        const evPlaceholder: PriceObservation = {
          sourceStationCode: s.sourceStationCode,
          fuelTypeSourceCode: "EV",
          priceTenthsCpl: 0,
          sourceReportedAt: now,
          raw: { stationcode: 1, state: "NSW", fueltype: "EV", price: 0, lastupdated: "x" },
        };

        const result = await persistObservations(
          tx,
          [realPrice, evPlaceholder],
          String(run.id),
          now,
        );

        expect(result.insertedCount).toBe(1);
        expect(result.skippedNonPricedCount).toBe(1);
        expect(result.rejectedCount).toBe(0);
        expect(result.rejectedByReason).toEqual({});
        // The station was still genuinely present (its EV row proves that) — full_sync's
        // presence-graduation must see it regardless of the fuel-type filter.
        expect(result.observedStationCodes.has(s.sourceStationCode)).toBe(true);

        const [updatedRun] = await tx
          .select({
            persisted: ingestionRun.recordsPersisted,
            rejected: ingestionRun.recordsRejected,
          })
          .from(ingestionRun)
          .where(eq(ingestionRun.id, run.id));
        expect(updatedRun).toEqual({ persisted: 1, rejected: 0 });

        const [row] = await tx
          .select({ lifecycleState: station.lifecycleState })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);
        expect(row.lifecycleState).toBe("active"); // sanity: fixture actually landed

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
    // persistObservations calls loadKnownStationCodeToId, which scans the whole real station
    // table (same reason repositories.integration.test.ts's tests need explicit timeouts) —
    // confirmed live at just over 5s against staging's current ~3,300 real rows.
  }, 30_000);
});
