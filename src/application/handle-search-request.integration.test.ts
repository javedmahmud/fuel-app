import { inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../infrastructure/db/client";
import { fuelPriceObservation, fuelType, station } from "../infrastructure/db/schema";
import type { FuelType, Station } from "../infrastructure/fuel-api/types";
import { upsertFuelTypesFromReferenceData } from "../infrastructure/repositories/fuel-type-repository";
import { upsertStationsFromReferenceData } from "../infrastructure/repositories/station-repository";
import { handleSearchRequest } from "./handle-search-request";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Contract tests for `GET /api/v1/search` (`21_DETAILED_DESIGN.md` §21.1, backlog item
 * `20_SPRINT_PLAN.md` §21.8: "API contract tests for /search and /stations/* — schema validation
 * against §21.1's shapes, a response-shape break fails CI"). Calls `handleSearchRequest`
 * directly with a rolled-back transaction — this codebase's standard integration-test safety
 * pattern — rather than the exported `GET`, which is intentionally a thin wrapper around this
 * function precisely so it can be tested this way without leaking real rows (`recommendation_log`,
 * `rate_limit_window`) into staging.
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

async function seedTwoStations(tx: Tx, origin: { latitude: number; longitude: number }) {
  const cheap = testStation({
    latitude: origin.latitude + 0.001,
    longitude: origin.longitude + 0.001,
  });
  const expensive = testStation({
    latitude: origin.latitude + 0.002,
    longitude: origin.longitude + 0.002,
  });
  await upsertStationsFromReferenceData(tx, [cheap, expensive], new Date());

  const [cheapRow] = await tx
    .select({ id: station.id })
    .from(station)
    .where(sql`${station.sourceStationCode} = ${cheap.sourceStationCode}`);
  const [expensiveRow] = await tx
    .select({ id: station.id })
    .from(station)
    .where(sql`${station.sourceStationCode} = ${expensive.sourceStationCode}`);

  const ft: FuelType = {
    sourceCode: `TESTFT_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    displayName: "Test",
  };
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

  return {
    cheapStationId: cheapRow.id,
    expensiveStationId: expensiveRow.id,
    fuelTypeCode: ft.sourceCode,
  };
}

/**
 * `count` stations, closest first, each a little farther and a little more expensive than the
 * last — so "nearest" and "cheapest" agree, and the recommended (lowest effective cost) station
 * is deliberately the LAST one seeded: farthest away in `latIndex`/`lngIndex` terms but priced
 * cheap enough to still win on effective cost, so it lands past position `MAX_RESULTS` when
 * sorted by distance or price. That's the exact scenario the result cap must not break.
 */
async function seedManyStationsWithFarRecommended(
  tx: Tx,
  origin: { latitude: number; longitude: number },
  count: number,
) {
  const stations = Array.from({ length: count }, (_, i) =>
    testStation({
      latitude: origin.latitude + (i + 1) * 0.0005,
      longitude: origin.longitude + (i + 1) * 0.0005,
    }),
  );
  await upsertStationsFromReferenceData(tx, stations, new Date());

  const rows = await tx
    .select({ id: station.id, code: station.sourceStationCode })
    .from(station)
    .where(
      inArray(
        station.sourceStationCode,
        stations.map((s) => s.sourceStationCode),
      ),
    );
  const idByCode = new Map(rows.map((r) => [r.code, r.id]));

  const ft: FuelType = {
    sourceCode: `TESTFT_MANY_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    displayName: "Test",
  };
  await upsertFuelTypesFromReferenceData(tx, [ft]);
  const [ftRow] = await tx
    .select({ id: fuelType.id })
    .from(fuelType)
    .where(sql`${fuelType.sourceCode} = ${ft.sourceCode}`);

  const now = new Date();
  const observations = stations.map((s, i) => ({
    stationId: idByCode.get(s.sourceStationCode)!,
    fuelTypeId: ftRow.id,
    // All others get steadily pricier with distance; the farthest station (last index) is
    // instead the cheapest of all, so it's the true effective-cost winner despite being the
    // single farthest candidate — the one a naive "sort then slice" would drop.
    priceTenthsCpl: i === count - 1 ? 1000 : 1600 + i * 5,
    sourceReportedAt: now,
    source: "NSW_FUEL_API" as const,
    contentHash: `test-${Math.random().toString(36).slice(2)}`,
  }));
  await tx.insert(fuelPriceObservation).values(observations);

  const farStationId = idByCode.get(stations[count - 1].sourceStationCode)!;
  return { fuelTypeCode: ft.sourceCode, recommendedStationId: farStationId };
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

describe("handleSearchRequest against real Postgres", () => {
  it("200s with a ranked list for a lat/lng search, rich fields only on the recommended entry", async () => {
    await withRollback(async (tx) => {
      const origin = { latitude: -33.5, longitude: 151.05 };
      const { cheapStationId, expensiveStationId, fuelTypeCode } = await seedTwoStations(
        tx,
        origin,
      );

      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({
          lat: String(origin.latitude),
          lng: String(origin.longitude),
          fuelType: fuelTypeCode,
        }),
        "203.0.113.10",
        new Date(),
      );

      expect(result.status).toBe(200);
      const body = result.body as {
        results: unknown[];
        engineVersion: string;
        generatedAt: string;
      };
      expect(body.results).toHaveLength(2);
      expect(typeof body.engineVersion).toBe("string");
      expect(typeof body.generatedAt).toBe("string");

      const results = body.results as Array<{
        stationId: string;
        reasonCodes: string[];
        confidence: unknown;
        explanation: string | null;
        metrics: {
          fuelCost: number;
          driveCost: number;
          effectiveCost: number;
          estimatedSaving: number | null;
        };
      }>;
      const recommended = results.find((r) => r.stationId === cheapStationId);
      const other = results.find((r) => r.stationId === expensiveStationId);
      expect(recommended).toBeDefined();
      expect(other).toBeDefined();
      expect(recommended?.reasonCodes.length).toBeGreaterThan(0);
      expect(recommended?.confidence).not.toBeNull();
      expect(recommended?.metrics.estimatedSaving).not.toBeNull();
      expect(typeof recommended?.explanation).toBe("string");
      expect(recommended?.explanation?.length).toBeGreaterThan(0);
      // fuelCost + driveCost must always reconstruct effectiveCost — the whole point of exposing
      // the breakdown is that it's an honest split of the same total, not a second, different
      // number (feedback: "trip cost should be broken to fuel cost and trip cost").
      for (const r of [recommended, other]) {
        expect(r?.metrics.fuelCost).toBeGreaterThan(0);
        expect(r?.metrics.driveCost).toBeGreaterThanOrEqual(0);
        expect((r?.metrics.fuelCost ?? 0) + (r?.metrics.driveCost ?? 0)).toBeCloseTo(
          r?.metrics.effectiveCost ?? -1,
          2,
        );
      }
      expect(other?.reasonCodes).toEqual([]);
      expect(other?.confidence).toBeNull();
      expect(other?.metrics.estimatedSaving).toBeNull();
      expect(other?.explanation).toBeNull();
    });
  }, 30_000);

  it("resolves a real locality name to coordinates and finds nearby fixtures", async () => {
    await withRollback(async (tx) => {
      // Rouse Hill NSW — a real entry in the shipped locality dataset.
      const origin = { latitude: -33.67756950639191, longitude: 150.90756808613676 };
      const { fuelTypeCode } = await seedTwoStations(tx, origin);

      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({ locality: "Rouse Hill", fuelType: fuelTypeCode }),
        "203.0.113.10",
        new Date(),
      );

      expect(result.status).toBe(200);
      const body = result.body as { results: unknown[] };
      expect(body.results).toHaveLength(2);
    });
  }, 30_000);

  it("resolves a real postcode to coordinates and finds nearby fixtures", async () => {
    await withRollback(async (tx) => {
      // Postcode 2000 (Sydney CBD) — a real entry in the shipped postcode dataset.
      const origin = { latitude: -33.869758254479656, longitude: 151.2099799680103 };
      const { fuelTypeCode } = await seedTwoStations(tx, origin);

      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({ locality: "2000", fuelType: fuelTypeCode }),
        "203.0.113.10",
        new Date(),
      );

      expect(result.status).toBe(200);
      const body = result.body as { results: unknown[] };
      expect(body.results).toHaveLength(2);
    });
  }, 30_000);

  it("400s for an unresolvable locality, without touching the search pipeline", async () => {
    await withRollback(async (tx) => {
      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({ locality: "Not A Real Place At All", fuelType: "91" }),
        "203.0.113.10",
        new Date(),
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: expect.stringContaining("Could not resolve") });
    });
  }, 30_000);

  it("400s for lat/lng outside the NSW/TAS bounding box", async () => {
    await withRollback(async (tx) => {
      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({ lat: "51.5", lng: "-0.12", fuelType: "91" }), // London
        "203.0.113.10",
        new Date(),
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: expect.stringContaining("bounding box") });
    });
  }, 30_000);

  it("400s when neither lat/lng nor locality is provided", async () => {
    await withRollback(async (tx) => {
      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({ fuelType: "91" }),
        "203.0.113.10",
        new Date(),
      );
      expect(result.status).toBe(400);
    });
  }, 30_000);

  it("400s for an unknown fuel type", async () => {
    await withRollback(async (tx) => {
      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({ lat: "-33.5", lng: "151.05", fuelType: "NOT_A_REAL_FUEL_TYPE" }),
        "203.0.113.10",
        new Date(),
      );
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: expect.stringContaining("Unknown fuel type") });
    });
  }, 30_000);

  it("200s with an empty results array when nothing is nearby, rather than an error", async () => {
    await withRollback(async (tx) => {
      const ft: FuelType = { sourceCode: `TESTFT_EMPTY_${Date.now()}`, displayName: "Test" };
      await upsertFuelTypesFromReferenceData(tx, [ft]);

      // Middle of the Tasman Sea, but still inside the generous NSW/TAS bounding box.
      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({ lat: "-40.0", lng: "154.0", fuelType: ft.sourceCode }),
        "203.0.113.10",
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
    // Fired concurrently (not a sequential loop) — 61 sequential round trips against real
    // staging is slow enough to blow past vitest's default timeout, and concurrency is also
    // the realistic shape of a burst. Order doesn't matter for a shared fixed-window counter:
    // only the final count does, so asserting "at least one 429 among 61 issued in one window"
    // is exactly as strong a contract check as asserting it on a specific request.
    await withRollback(async (tx) => {
      const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
      const now = new Date();
      // An unresolvable locality 400s right after the rate-limit check, with no further DB
      // work (locality/postcode resolution is a pure in-memory lookup) — keeps each of the 61
      // requests down to a single round trip against real staging instead of also touching
      // runSearch's own queries, which is what this test needs to stay well inside its timeout.
      const params = new URLSearchParams({ locality: "Not A Real Place At All", fuelType: "91" });

      const results = await Promise.all(
        Array.from({ length: 61 }, () => handleSearchRequest(tx, params, ip, now)),
      );

      const rejected = results.filter((r) => r.status === 429);
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected[0]?.headers?.["Retry-After"]).toBe("60");
      expect(rejected[0]?.body).toEqual({ error: "Too many requests." });
      expect(results.filter((r) => r.status === 400)).toHaveLength(61 - rejected.length);
    });
  }, 60_000);

  it("caps the response at 50 results (§13.9's result cap), default effectiveCost sort", async () => {
    await withRollback(async (tx) => {
      const origin = { latitude: -33.5, longitude: 151.05 };
      const { fuelTypeCode } = await seedManyStationsWithFarRecommended(tx, origin, 55);

      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({
          lat: String(origin.latitude),
          lng: String(origin.longitude),
          fuelType: fuelTypeCode,
        }),
        "203.0.113.20",
        new Date(),
      );

      expect(result.status).toBe(200);
      const body = result.body as { results: unknown[] };
      expect(body.results).toHaveLength(50);
    });
  }, 30_000);

  it("keeps the recommended entry in a capped response even when it would otherwise be sliced off by sort=distance", async () => {
    await withRollback(async (tx) => {
      const origin = { latitude: -33.5, longitude: 151.05 };
      const { fuelTypeCode, recommendedStationId } = await seedManyStationsWithFarRecommended(
        tx,
        origin,
        55,
      );

      const result = await handleSearchRequest(
        tx,
        new URLSearchParams({
          lat: String(origin.latitude),
          lng: String(origin.longitude),
          fuelType: fuelTypeCode,
          sort: "distance",
        }),
        "203.0.113.21",
        new Date(),
      );

      expect(result.status).toBe(200);
      const body = result.body as {
        results: Array<{
          stationId: string;
          reasonCodes: string[];
          confidence: unknown;
          explanation: string | null;
        }>;
      };
      expect(body.results).toHaveLength(50);
      const recommended = body.results.find((r) => r.stationId === recommendedStationId);
      expect(recommended).toBeDefined();
      expect(recommended?.reasonCodes.length).toBeGreaterThan(0);
      expect(recommended?.confidence).not.toBeNull();
      expect(typeof recommended?.explanation).toBe("string");
    });
  }, 30_000);
});
