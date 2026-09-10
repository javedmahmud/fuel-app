import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "../db/client";
import { ingestionRun, station } from "../db/schema";
import type { FuelType, Station } from "../fuel-api/types";
import { insertObservationsIdempotent } from "./observation-repository";
import {
  loadActiveFuelTypeCodeToId,
  upsertFuelTypesFromReferenceData,
} from "./fuel-type-repository";
import {
  loadKnownStationCodeToId,
  recordFullSyncStationPresence,
  upsertStationsFromReferenceData,
} from "./station-repository";

/**
 * Real Postgres, synthetic data — no real NSW Fuel API call, so this costs zero quota, unlike
 * fuel-api.integration.test.ts. Everything runs inside one outer transaction that's always
 * rolled back (see the IntentionalTestRollback pattern, same as schema.integration.test.ts and
 * fuel-api.integration.test.ts), so nothing here is ever actually committed to real staging —
 * safe to run repeatedly. Run manually: see vitest.integration.config.mts.
 */

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

class IntentionalTestRollback extends Error {}

afterAll(async () => {
  // getDb() is a module-level singleton shared with any other integration test file in the same
  // process — not closed here, the process exiting after the full run closes it.
});

describe("fuel-type-repository, station-repository, observation-repository against real Postgres", () => {
  it("upserts, deactivates, and reactivates fuel types by presence in the fetched set", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const codeA: FuelType = { sourceCode: `TESTFT_A_${Date.now()}`, displayName: "A" };
        const codeB: FuelType = { sourceCode: `TESTFT_B_${Date.now()}`, displayName: "B" };

        // Same reasoning as the station upsert test: `deactivated` is table-wide (correct
        // production behaviour — real ref_data syncs always send the full real list), and
        // staging already has 16 real fuel types from the hourly cron, so only `upserted` is
        // asserted exactly; the rest is checked via these two synthetic codes' own state.
        const first = await upsertFuelTypesFromReferenceData(tx, [codeA, codeB]);
        expect(first.upserted).toBe(2);

        let active = await loadActiveFuelTypeCodeToId(tx);
        expect(active.has(codeA.sourceCode)).toBe(true);
        expect(active.has(codeB.sourceCode)).toBe(true);

        // Second sync only mentions A — B should be deactivated, not deleted.
        const second = await upsertFuelTypesFromReferenceData(tx, [codeA]);
        expect(second.deactivated).toBeGreaterThanOrEqual(1);

        active = await loadActiveFuelTypeCodeToId(tx);
        expect(active.has(codeA.sourceCode)).toBe(true);
        expect(active.has(codeB.sourceCode)).toBe(false);

        // B reappears — reactivated, not left deactivated forever.
        await upsertFuelTypesFromReferenceData(tx, [codeA, codeB]);
        active = await loadActiveFuelTypeCodeToId(tx);
        expect(active.has(codeB.sourceCode)).toBe(true);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
    // Same reason as the graduation test's explicit timeout below: staging's real fuel_type/
    // station tables keep growing from the live hourly cron, and upsertFuelTypesFromReferenceData
    // scans against the whole table — confirmed live at ~4.9s and climbing, past Vitest's 5s
    // default (previously passed comfortably; growing real data pushed it over).
  }, 30_000);

  it("upserts stations from reference data and deactivates ones no longer listed", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s1 = testStation();
        const s2 = testStation();

        // NOTE on what this test does and doesn't assert: `deactivated` in the return value is
        // a table-wide count (real production behaviour, per §8.6 — a real weekly ref_data sync
        // always sends the FULL real station list, so "everything else gets deactivated" is
        // correct there). Staging already has real rows from the hourly cron, so asserting an
        // exact `deactivated` count here would be asserting on the whole table's contents, not
        // on this test's own fixtures — checked via TWO synthetic stations' own resulting rows
        // instead, which stays correct regardless of what else is in the table.
        const first = await upsertStationsFromReferenceData(tx, [s1, s2], new Date());
        expect(first.upserted).toBe(2);

        let known = await loadKnownStationCodeToId(tx);
        expect(known.has(s1.sourceStationCode)).toBe(true);
        expect(known.has(s2.sourceStationCode)).toBe(true);

        // s2 no longer in reference data — deactivated (not deleted: still resolvable for
        // historical observations, per §8.6 "stations are never deleted").
        await upsertStationsFromReferenceData(tx, [s1], new Date());
        known = await loadKnownStationCodeToId(tx);
        expect(known.has(s1.sourceStationCode)).toBe(true);
        expect(known.has(s2.sourceStationCode)).toBe(false);

        const [row] = await tx
          .select({ lifecycleState: station.lifecycleState })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s2.sourceStationCode}`);
        expect(row.lifecycleState).toBe("inactive");

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  });

  it("derives suburb/postcode from addressLine on insert, and re-derives them on conflict when the address changes", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const s = testStation({ addressLine: "101 Hector St, Sefton NSW 2162" });
        await upsertStationsFromReferenceData(tx, [s], new Date());

        const [row] = await tx
          .select({ suburb: station.suburb, postcode: station.postcode })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);
        expect(row).toEqual({ suburb: "Sefton", postcode: "2162" });

        // Re-upserted with a different address (a real, if rare, provider correction) — the
        // derived fields must track it, not keep the stale value from the first insert.
        await upsertStationsFromReferenceData(
          tx,
          [{ ...s, addressLine: "5 Example Rd, Newtown NSW 2042" }],
          new Date(),
        );
        const [updated] = await tx
          .select({ suburb: station.suburb, postcode: station.postcode })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);
        expect(updated).toEqual({ suburb: "Newtown", postcode: "2042" });

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  });

  it("leaves suburb/postcode null for an address the parser can't safely resolve, rather than guessing", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        // No comma before the suburb — genuinely ambiguous against the street name.
        const s = testStation({ addressLine: "275 Pacific Hwy Hornsby NSW 2077" });
        await upsertStationsFromReferenceData(tx, [s], new Date());

        const [row] = await tx
          .select({ suburb: station.suburb, postcode: station.postcode })
          .from(station)
          .where(sql`${station.sourceStationCode} = ${s.sourceStationCode}`);
        expect(row.suburb).toBeNull();
        expect(row.postcode).toBe("2077"); // still unambiguous, even without the comma

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  });

  it("graduates station absence active -> suspect -> suspect+alarm -> inactive, and reactivates on return — §8.6", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const present = testStation(); // stays present throughout
        const fading = testStation(); // goes missing for 3 consecutive full syncs

        await upsertStationsFromReferenceData(tx, [present, fading], new Date());

        const presentOnly = new Set([present.sourceStationCode]);

        // recordFullSyncStationPresence's returned counts are table-wide (correct for real
        // production use — full_sync genuinely does grade every known station in one pass —
        // but staging already has real rows from the hourly cron, so those counts reflect the
        // whole table, not just this test's fixtures). Checked here via the `fading` station's
        // own row instead, which stays correct regardless of what else is in the table.
        async function fadingState() {
          const [row] = await tx
            .select({
              lifecycleState: station.lifecycleState,
              consecutiveMissingSyncs: station.consecutiveMissingSyncs,
            })
            .from(station)
            .where(sql`${station.sourceStationCode} = ${fading.sourceStationCode}`);
          return row;
        }

        await recordFullSyncStationPresence(tx, presentOnly);
        expect(await fadingState()).toEqual({
          lifecycleState: "suspect",
          consecutiveMissingSyncs: 1,
        });

        await recordFullSyncStationPresence(tx, presentOnly);
        expect(await fadingState()).toEqual({
          lifecycleState: "suspect",
          consecutiveMissingSyncs: 2,
        }); // §8.6: 2nd miss also alarms, still "suspect"

        await recordFullSyncStationPresence(tx, presentOnly);
        expect(await fadingState()).toEqual({
          lifecycleState: "inactive",
          consecutiveMissingSyncs: 3,
        });

        let known = await loadKnownStationCodeToId(tx);
        expect(known.has(fading.sourceStationCode)).toBe(false); // excluded once inactive
        expect(known.has(present.sourceStationCode)).toBe(true); // never missing — unaffected

        // Confirms inactive stations don't get re-escalated past where they already are — a 4th
        // consecutive miss shouldn't keep incrementing the counter once it's already inactive.
        await recordFullSyncStationPresence(tx, presentOnly);
        expect(await fadingState()).toEqual({
          lifecycleState: "inactive",
          consecutiveMissingSyncs: 3,
        });

        // Now it reappears — full recovery, not just a partial reset.
        const bothPresent = new Set([present.sourceStationCode, fading.sourceStationCode]);
        await recordFullSyncStationPresence(tx, bothPresent);
        expect(await fadingState()).toEqual({
          lifecycleState: "active",
          consecutiveMissingSyncs: 0,
        });

        known = await loadKnownStationCodeToId(tx);
        expect(known.has(fading.sourceStationCode)).toBe(true);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
    // recordFullSyncStationPresence scans/updates against the full real station table (§8.6's
    // actual production behaviour — a full sync grades every known station in one pass) and
    // this test deliberately calls it 5 times in sequence to walk the whole graduation path.
    // Confirmed live: ~1.4s per call against ~3,300 real rows, comfortably under Vitest's 5s
    // default individually, not cumulatively across 5 calls in one test.
  }, 30_000);

  it("keeps a suspect station in loadKnownStationCodeToId — still searchable, per §8.6", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const present = testStation();
        const suspect = testStation();
        await upsertStationsFromReferenceData(tx, [present, suspect], new Date());

        await recordFullSyncStationPresence(tx, new Set([present.sourceStationCode])); // 1 miss -> suspect

        const known = await loadKnownStationCodeToId(tx);
        expect(known.has(suspect.sourceStationCode)).toBe(true); // suspect, but still known/searchable

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 15_000);

  it("inserts observations idempotently — a re-delivered price is skipped, not duplicated", async () => {
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

        const ft: FuelType = { sourceCode: `TESTFT_${Date.now()}`, displayName: "Test" };
        await upsertFuelTypesFromReferenceData(tx, [ft]);
        const fuelTypeIds = await loadActiveFuelTypeCodeToId(tx);

        const observation = {
          stationId: stationIds.get(s.sourceStationCode) as string,
          fuelTypeId: fuelTypeIds.get(ft.sourceCode) as string,
          priceTenthsCpl: 1789,
          sourceReportedAt: new Date(),
          ingestionRunId: String(run.id),
          source: "NSW_FUEL_API",
          rawPayload: { test: true },
          contentHash: `test-hash-${Date.now()}`,
        };

        const first = await insertObservationsIdempotent(tx, [observation]);
        expect(first).toEqual({ insertedCount: 1, duplicateCount: 0 });

        // Same content_hash again — simulates the exact re-delivery scenario §8.7 exists for.
        const second = await insertObservationsIdempotent(tx, [observation]);
        expect(second).toEqual({ insertedCount: 0, duplicateCount: 1 });

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  });
});
