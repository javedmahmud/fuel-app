import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../infrastructure/db/client";
import { fuelPriceObservation, fuelType, station } from "../infrastructure/db/schema";
import type { FuelType, Station } from "../infrastructure/fuel-api/types";
import { upsertFuelTypesFromReferenceData } from "../infrastructure/repositories/fuel-type-repository";
import { upsertStationsFromReferenceData } from "../infrastructure/repositories/station-repository";
import { handleCommuteRequest } from "./handle-commute-request";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Contract tests for `POST /api/v1/commute` (`21_DETAILED_DESIGN.md` §21.1). Calls
 * `handleCommuteRequest` directly with a rolled-back transaction — the same pattern every other
 * `handle-*-request.integration.test.ts` in this codebase uses — rather than the exported `POST`,
 * which is intentionally a thin wrapper around this function precisely so it can be tested this
 * way without leaking real rows (`recommendation_log`, `rate_limit_window`) into staging.
 */

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

// Sydney -> Canberra — same real corridor used throughout this branch's other tests.
const sydney = { lat: -33.8688, lng: 151.2093 };
const canberra = { lat: -35.3081, lng: 149.1244 };

async function seedOnRouteStation(tx: Tx) {
  const goulburn = testStation({ latitude: -34.7539, longitude: 149.7161 });
  await upsertStationsFromReferenceData(tx, [goulburn], new Date());

  const [goulburnRow] = await tx
    .select({ id: station.id })
    .from(station)
    .where(sql`${station.sourceStationCode} = ${goulburn.sourceStationCode}`);

  const ft: FuelType = {
    sourceCode: `TESTFT_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    displayName: "Test",
  };
  await upsertFuelTypesFromReferenceData(tx, [ft]);
  const [ftRow] = await tx
    .select({ id: fuelType.id })
    .from(fuelType)
    .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);

  await tx.insert(fuelPriceObservation).values({
    stationId: goulburnRow.id,
    fuelTypeId: ftRow.id,
    priceTenthsCpl: 1799,
    sourceReportedAt: new Date(),
    source: "NSW_FUEL_API",
    contentHash: `test-${Math.random().toString(36).slice(2)}`,
  });

  return { stationId: goulburnRow.id, fuelTypeCode: ft.sourceCode };
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

describe("handleCommuteRequest against real Postgres", () => {
  it("200s with a ranked list, rich fields only on the recommended entry", async () => {
    await withRollback(async (tx) => {
      const { stationId, fuelTypeCode } = await seedOnRouteStation(tx);

      const result = await handleCommuteRequest(
        tx,
        { origin: sydney, destination: canberra, fuelType: fuelTypeCode, maxDetourKm: 20 },
        "203.0.113.30",
        new Date(),
      );

      expect(result.status).toBe(200);
      const body = result.body as {
        results: Array<{
          stationId: string;
          reasonCodes: string[];
          confidence: unknown;
          explanation: string | null;
          metrics: { fuelCost: number; driveCost: number; effectiveCost: number };
        }>;
        engineVersion: string;
        generatedAt: string;
      };
      expect(body.results).toHaveLength(1);
      const recommended = body.results[0];
      expect(recommended.stationId).toBe(stationId);
      expect(recommended.reasonCodes.length).toBeGreaterThan(0);
      expect(recommended.confidence).not.toBeNull();
      expect(typeof recommended.explanation).toBe("string");
      // fuelCost + driveCost must reconstruct effectiveCost, same honest-breakdown property
      // /search's response has — real feedback that motivated this split in the first place.
      expect(recommended.metrics.fuelCost + recommended.metrics.driveCost).toBeCloseTo(
        recommended.metrics.effectiveCost,
        2,
      );
      expect(typeof body.engineVersion).toBe("string");
    });
  }, 30_000);

  it("400s when origin is outside the NSW/TAS bounding box", async () => {
    await withRollback(async (tx) => {
      const result = await handleCommuteRequest(
        tx,
        {
          origin: { lat: 51.5, lng: -0.12 }, // London
          destination: canberra,
          fuelType: "91",
          maxDetourKm: 20,
        },
        "203.0.113.31",
        new Date(),
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: expect.stringContaining("origin") });
    });
  }, 30_000);

  it("400s when destination is outside the NSW/TAS bounding box", async () => {
    await withRollback(async (tx) => {
      const result = await handleCommuteRequest(
        tx,
        {
          origin: sydney,
          destination: { lat: 51.5, lng: -0.12 },
          fuelType: "91",
          maxDetourKm: 20,
        },
        "203.0.113.32",
        new Date(),
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: expect.stringContaining("destination") });
    });
  }, 30_000);

  it("400s when maxDetourKm is missing — required per UC-02, unlike /search's optional radiusKm", async () => {
    await withRollback(async (tx) => {
      const result = await handleCommuteRequest(
        tx,
        { origin: sydney, destination: canberra, fuelType: "91" },
        "203.0.113.33",
        new Date(),
      );
      expect(result.status).toBe(400);
    });
  }, 30_000);

  it("400s when maxDetourKm exceeds the cap", async () => {
    await withRollback(async (tx) => {
      const result = await handleCommuteRequest(
        tx,
        { origin: sydney, destination: canberra, fuelType: "91", maxDetourKm: 500 },
        "203.0.113.34",
        new Date(),
      );
      expect(result.status).toBe(400);
    });
  }, 30_000);

  it("400s for an unknown fuel type", async () => {
    await withRollback(async (tx) => {
      const result = await handleCommuteRequest(
        tx,
        {
          origin: sydney,
          destination: canberra,
          fuelType: "NOT_A_REAL_FUEL_TYPE",
          maxDetourKm: 20,
        },
        "203.0.113.35",
        new Date(),
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: expect.stringContaining("Unknown fuel type") });
    });
  }, 30_000);

  it("200s with an empty results array when nothing is near the route, rather than an error", async () => {
    await withRollback(async (tx) => {
      const ft: FuelType = { sourceCode: `TESTFT_EMPTY_${Date.now()}`, displayName: "Test" };
      await upsertFuelTypesFromReferenceData(tx, [ft]);

      const result = await handleCommuteRequest(
        tx,
        {
          // A "commute" between two points nowhere near any station — Uluru to Alice Springs is
          // real Australian geography but well outside the NSW/TAS bounding box... use two
          // points that ARE inside the box but far from any real or synthetic fixture instead.
          origin: { lat: -37.5, lng: 143.5 }, // far west NSW/VIC border area
          destination: { lat: -37.0, lng: 144.0 },
          fuelType: ft.sourceCode,
          maxDetourKm: 5,
        },
        "203.0.113.36",
        new Date(),
      );
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        results: [],
        engineVersion: null,
        generatedAt: expect.any(String),
      });
    });
  }, 30_000);

  it("429s with a Retry-After header once the per-IP rate limit is exceeded", async () => {
    await withRollback(async (tx) => {
      const ip = `203.0.113.${Math.floor(Math.random() * 100) + 100}`;
      const now = new Date();
      // An unknown fuel type 400s right after the rate-limit check with no further DB work
      // (fuel type lookup is a single, cheap query) — keeps each of the 61 requests fast,
      // matching handle-search-request.integration.test.ts's own rate-limit test shape.
      const body = {
        origin: sydney,
        destination: canberra,
        fuelType: "NOT_A_REAL_FUEL_TYPE",
        maxDetourKm: 20,
      };

      const results = await Promise.all(
        Array.from({ length: 61 }, () => handleCommuteRequest(tx, body, ip, now)),
      );

      const rejected = results.filter((r) => r.status === 429);
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected[0]?.headers?.["Retry-After"]).toBe("60");
      expect(rejected[0]?.body).toEqual({ error: "Too many requests." });
      expect(results.filter((r) => r.status === 400)).toHaveLength(61 - rejected.length);
    });
  }, 60_000);

  it("rejects a malformed body (missing required fields) with a 400", async () => {
    await withRollback(async (tx) => {
      const result = await handleCommuteRequest(
        tx,
        { not: "a valid commute body" },
        "203.0.113.37",
        new Date(),
      );
      expect(result.status).toBe(400);
    });
  }, 30_000);
});
