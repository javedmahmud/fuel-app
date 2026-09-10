import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../infrastructure/db/client";
import { fuelPriceObservation, fuelType, station } from "../infrastructure/db/schema";
import type { FuelType, Station } from "../infrastructure/fuel-api/types";
import { upsertFuelTypesFromReferenceData } from "../infrastructure/repositories/fuel-type-repository";
import { upsertStationsFromReferenceData } from "../infrastructure/repositories/station-repository";
import { handleStationDetailRequest } from "./handle-station-detail-request";

/**
 * Contract tests for `GET /api/v1/stations/{stationId}` (`21_DETAILED_DESIGN.md` §21.1, UC-05).
 * Same rolled-back-transaction pattern as `handle-search-request.integration.test.ts` — calls
 * the handler directly rather than the real `GET`, for the same reason (no permanent writes to
 * staging).
 */

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

class IntentionalTestRollback extends Error {}

function testStation(overrides: Partial<Station> = {}): Station {
  return {
    sourceStationCode: `TEST_${Math.random().toString(36).slice(2)}`,
    source: "NSW_FUEL_API",
    name: "Contract Test Station",
    brand: "Acme",
    addressLine: "1 Test St, Testville NSW 2000",
    latitude: -33.87,
    longitude: 151.21,
    state: "NSW",
    ...overrides,
  };
}

async function seedStationWithPrice(
  tx: Tx,
  overrides: Partial<Station> = {},
  opts: { priceTenthsCpl?: number; sourceReportedAt?: Date } = {},
) {
  const s = testStation(overrides);
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

  await tx.insert(fuelPriceObservation).values({
    stationId: stationRow.id,
    fuelTypeId: ftRow.id,
    priceTenthsCpl: opts.priceTenthsCpl ?? 1900,
    sourceReportedAt: opts.sourceReportedAt ?? new Date(),
    source: "NSW_FUEL_API",
    contentHash: `test-${Math.random().toString(36).slice(2)}`,
  });

  return { stationId: stationRow.id as string, fuelTypeCode: ft.sourceCode, station: s };
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

describe("handleStationDetailRequest against real Postgres", () => {
  it("200s with name/brand/address/location and a priced fuel type, freshness band 'current'", async () => {
    await withRollback(async (tx) => {
      const now = new Date();
      const { stationId, station: s } = await seedStationWithPrice(
        tx,
        {},
        { priceTenthsCpl: 1899, sourceReportedAt: now },
      );

      const result = await handleStationDetailRequest(tx, stationId, new URLSearchParams(), now);

      expect(result.status).toBe(200);
      const body = result.body as {
        stationId: string;
        name: string;
        brand: string | null;
        address: { line: string | null; suburb: string | null; postcode: string | null };
        distanceKm: number | null;
        prices: Array<{
          fuelType: string;
          price: { centsPerLitre: number };
          freshnessBand: string;
        }>;
      };
      expect(body.stationId).toBe(stationId);
      expect(body.name).toBe(s.name);
      expect(body.brand).toBe(s.brand);
      expect(body.address.line).toBe(s.addressLine);
      // Parsed from addressLine at upsert time (feature/station-address-parser) — comma-
      // delimited addresses like this fixture's resolve reliably (see that branch's own module
      // comment on `domain/station/parse-address.ts` for the confirmed-live hit rates).
      expect(body.address.suburb).toBe("Testville");
      expect(body.address.postcode).toBe("2000");
      expect(body.distanceKm).toBeNull(); // no lat/lng supplied
      expect(body.prices).toHaveLength(1);
      expect(body.prices[0].price.centsPerLitre).toBeCloseTo(189.9);
      expect(body.prices[0].freshnessBand).toBe("current");
    });
  }, 30_000);

  it("computes distanceKm when lat/lng are supplied", async () => {
    await withRollback(async (tx) => {
      const origin = { latitude: -33.87, longitude: 151.21 };
      const { stationId } = await seedStationWithPrice(tx, {
        latitude: origin.latitude + 0.01,
        longitude: origin.longitude + 0.01,
      });

      const result = await handleStationDetailRequest(
        tx,
        stationId,
        new URLSearchParams({ lat: String(origin.latitude), lng: String(origin.longitude) }),
        new Date(),
      );

      expect(result.status).toBe(200);
      const body = result.body as { distanceKm: number | null };
      expect(body.distanceKm).not.toBeNull();
      expect(body.distanceKm as number).toBeGreaterThan(0);
      expect(body.distanceKm as number).toBeLessThan(5);
    });
  }, 30_000);

  it("uses the long_unchanged freshness band for a price older than 7 days", async () => {
    await withRollback(async (tx) => {
      const now = new Date();
      const oldPrice = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      const { stationId } = await seedStationWithPrice(
        tx,
        {},
        { priceTenthsCpl: 1800, sourceReportedAt: oldPrice },
      );

      const result = await handleStationDetailRequest(tx, stationId, new URLSearchParams(), now);

      expect(result.status).toBe(200);
      const body = result.body as { prices: Array<{ freshnessBand: string }> };
      expect(body.prices[0].freshnessBand).toBe("long_unchanged");
    });
  }, 30_000);

  it("400s for a malformed stationId", async () => {
    await withRollback(async (tx) => {
      const result = await handleStationDetailRequest(
        tx,
        "not-a-uuid",
        new URLSearchParams(),
        new Date(),
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: "invalid_station_id" });
    });
  }, 30_000);

  it("400s when only one of lat/lng is supplied", async () => {
    await withRollback(async (tx) => {
      const { stationId } = await seedStationWithPrice(tx);
      const result = await handleStationDetailRequest(
        tx,
        stationId,
        new URLSearchParams({ lat: "-33.87" }),
        new Date(),
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: "invalid_query" });
    });
  }, 30_000);

  it("404s for a well-formed but nonexistent stationId", async () => {
    await withRollback(async (tx) => {
      const result = await handleStationDetailRequest(
        tx,
        "00000000-0000-0000-0000-000000000000",
        new URLSearchParams(),
        new Date(),
      );
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ error: "station_not_found" });
    });
  }, 30_000);

  it("returns an empty prices array for a real station with no observations at all", async () => {
    await withRollback(async (tx) => {
      const s = testStation();
      await upsertStationsFromReferenceData(tx, [s], new Date());
      const [stationRow] = await tx
        .select({ id: station.id })
        .from(station)
        .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);

      const result = await handleStationDetailRequest(
        tx,
        stationRow.id,
        new URLSearchParams(),
        new Date(),
      );

      expect(result.status).toBe(200);
      const body = result.body as { prices: unknown[] };
      expect(body.prices).toEqual([]);
    });
  }, 30_000);
});
