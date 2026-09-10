import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../db/client";
import { fuelPriceObservation, fuelType, station } from "../db/schema";
import type { FuelType, Station } from "../fuel-api/types";
import { upsertFuelTypesFromReferenceData } from "./fuel-type-repository";
import { upsertStationsFromReferenceData } from "./station-repository";
import { findNearbyCandidates } from "./station-search-repository";

/**
 * Real Postgres, synthetic fixtures, zero API quota — same rolled-back-transaction pattern used
 * throughout this repo. The `cos(latitude)` correction test is the "golden test for the
 * correction specifically" `20_SPRINT_PLAN.md` §20.6 asks for: a real query, against a real
 * table, at a real high-latitude Tasmanian coordinate, proving the fix actually changes what
 * comes back — not just that the pure `boundingBox` math is right in isolation (already covered
 * in `feature/calc-engine-core`'s `geo.test.ts`).
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

async function setupStationAndFuelType(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  stationFixture: Station,
) {
  await upsertStationsFromReferenceData(tx, [stationFixture], new Date());
  const [stationRow] = await tx
    .select({ id: station.id })
    .from(station)
    .where(sql`${station.sourceStationCode} = ${stationFixture.sourceStationCode}`);

  const ft: FuelType = {
    sourceCode: `TESTFT_${Math.random().toString(36).slice(2)}`,
    displayName: "Test",
  };
  await upsertFuelTypesFromReferenceData(tx, [ft]);
  const [ftRow] = await tx
    .select({ id: fuelType.id })
    .from(fuelType)
    .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);

  return { stationId: stationRow.id, fuelTypeId: ftRow.id };
}

async function insertPrice(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  stationId: string,
  fuelTypeId: string,
  priceTenthsCpl: number,
) {
  await tx.insert(fuelPriceObservation).values({
    stationId,
    fuelTypeId,
    priceTenthsCpl,
    sourceReportedAt: new Date(),
    source: "NSW_FUEL_API",
    contentHash: `test-${Math.random().toString(36).slice(2)}`,
  });
}

describe("findNearbyCandidates against real Postgres", () => {
  it("finds a station within the radius, with the correct haversine distance", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const centre = { latitude: -33.87, longitude: 151.21 };
        const fixture = testStation({ latitude: -33.875, longitude: 151.215 }); // a few hundred metres away
        const { stationId, fuelTypeId } = await setupStationAndFuelType(tx, fixture);
        await insertPrice(tx, stationId, fuelTypeId, 1799);

        const results = await findNearbyCandidates(tx, centre, 5, fuelTypeId);
        const mine = results.find((r) => r.stationId === stationId);

        expect(mine).toBeDefined();
        expect(mine?.distanceKm).toBeLessThan(1);
        expect(mine?.price.priceTenthsCpl).toBe(1799);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("excludes a station beyond the true radius, even if it falls inside the bounding box", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const centre = { latitude: -33.87, longitude: 151.21 };
        // Diagonal offset (0.044° each way, confirmed via direct computation) — inside a naive
        // square box for a 5km radius (box half-width ~0.0449°), but the true haversine distance
        // to this near-corner point is ~6.36km — exactly what "the box is a superset of the
        // circle" means in practice. Comfortable margin either side of 5km, not a knife-edge.
        const fixture = testStation({ latitude: -33.914, longitude: 151.254 });
        const { stationId, fuelTypeId } = await setupStationAndFuelType(tx, fixture);
        await insertPrice(tx, stationId, fuelTypeId, 1799);

        const results = await findNearbyCandidates(tx, centre, 5, fuelTypeId);
        expect(results.find((r) => r.stationId === stationId)).toBeUndefined();

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("excludes an inactive station and includes a suspect one, both nearby", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const centre = { latitude: -33.87, longitude: 151.21 };
        const inactive = testStation({ latitude: -33.871, longitude: 151.211 });
        const suspect = testStation({ latitude: -33.872, longitude: 151.212 });

        const inactiveIds = await setupStationAndFuelType(tx, inactive);
        await insertPrice(tx, inactiveIds.stationId, inactiveIds.fuelTypeId, 1799);
        await tx
          .update(station)
          .set({ lifecycleState: "inactive" })
          .where(sql`${station.id} = ${inactiveIds.stationId}`);

        const suspectIds = await setupStationAndFuelType(tx, suspect);
        await insertPrice(tx, suspectIds.stationId, suspectIds.fuelTypeId, 1799);
        await tx
          .update(station)
          .set({ lifecycleState: "suspect" })
          .where(sql`${station.id} = ${suspectIds.stationId}`);

        const inactiveResults = await findNearbyCandidates(tx, centre, 5, inactiveIds.fuelTypeId);
        expect(inactiveResults.find((r) => r.stationId === inactiveIds.stationId)).toBeUndefined();

        const suspectResults = await findNearbyCandidates(tx, centre, 5, suspectIds.fuelTypeId);
        expect(suspectResults.find((r) => r.stationId === suspectIds.stationId)).toBeDefined();

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("excludes a nearby station that has no price for the requested fuel type", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const centre = { latitude: -33.87, longitude: 151.21 };
        const fixture = testStation({ latitude: -33.871, longitude: 151.211 });
        const { stationId, fuelTypeId } = await setupStationAndFuelType(tx, fixture);
        // A price for a *different* fuel type only.
        const otherFt: FuelType = {
          sourceCode: `TESTFT_OTHER_${Date.now()}`,
          displayName: "Other",
        };
        await upsertFuelTypesFromReferenceData(tx, [otherFt]);
        const [otherFtRow] = await tx
          .select({ id: fuelType.id })
          .from(fuelType)
          .where(sql`${fuelType.sourceCode} = ${otherFt.sourceCode}`);
        await insertPrice(tx, stationId, otherFtRow.id, 1799);

        const results = await findNearbyCandidates(tx, centre, 5, fuelTypeId);
        expect(results.find((r) => r.stationId === stationId)).toBeUndefined();

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);

  it("finds a real high-latitude (Tasmanian) station only because of the cos(latitude) correction — §6.5's golden test", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        // Confirmed via direct computation: at latitude -42.88 (Hobart), a 0.10° longitude
        // offset falls OUTSIDE a naive (uncorrected) 10km box (naive delta ~0.0898°) but INSIDE
        // the correct cos-corrected box (~0.1226°) — and its real haversine distance is ~8.15km,
        // genuinely within the 10km search radius. A regression to the uncorrected formula
        // would make this exact test fail by dropping the station silently.
        const centre = { latitude: -42.88, longitude: 147.33 };
        const fixture = testStation({
          latitude: -42.88,
          longitude: 147.43, // +0.10°
          state: "TAS",
        });
        const { stationId, fuelTypeId } = await setupStationAndFuelType(tx, fixture);
        await insertPrice(tx, stationId, fuelTypeId, 1799);

        const results = await findNearbyCandidates(tx, centre, 10, fuelTypeId);
        const mine = results.find((r) => r.stationId === stationId);

        expect(mine).toBeDefined();
        expect(mine?.distanceKm).toBeCloseTo(8.148146588210025, 3);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 30_000);
});
