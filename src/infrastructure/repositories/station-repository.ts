import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { parseSuburbAndPostcodeFromAddress } from "../../domain/station/parse-address";
import { station } from "../db/schema";
import type { Station } from "../fuel-api/types";

type Db = Pick<PostgresJsDatabase, "select" | "insert" | "update">;

const MISSING_SYNCS_BEFORE_INACTIVE = 3; // §8.6: "3+ -> inactive"

/** Rows per batched upsert statement. ~3,300 real NSW stations at ~10 columns each is well
 * under Postgres's ~65,535-bind-parameter limit even in one statement — this chunk size is
 * about keeping individual statements a sane size, not working around that limit. */
const UPSERT_BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * `ref_data` job (weekly): reference data is the authority on *existence* —
 * `08_INGESTION_ARCHITECTURE.md` §8.6. Upserts every listed station as active, then deactivates
 * anything previously known that the provider no longer lists. Never deletes — deactivation
 * preserves price history for UC-06 and keeps historical observations resolvable.
 */
export async function upsertStationsFromReferenceData(
  db: Db,
  stations: Station[],
  now: Date,
): Promise<{ upserted: number; deactivated: number }> {
  if (stations.length === 0) {
    return { upserted: 0, deactivated: 0 };
  }

  // Batched, not one upsert per station — the original one-row-at-a-time loop took over half an
  // hour against the real ~3,300-station NSW dataset (confirmed live: ~1.5-2 rows/second), which
  // is a real problem for a job meant to run weekly, hold the advisory lock, and finish
  // reliably. `excluded.<column>` is the standard Postgres multi-row-upsert pattern — every row
  // in the batch keeps its own values in the conflict branch, same semantics as the per-row
  // loop, just one round trip per chunk instead of one per station.
  for (const batch of chunk(stations, UPSERT_BATCH_SIZE)) {
    await db
      .insert(station)
      .values(
        batch.map((s) => {
          // The NSW Fuel API has no separate suburb/postcode field — only `s.addressLine`
          // (`domain/station/parse-address.ts`'s own module comment has the full rationale and
          // confirmed-live hit rates). Derived here, not carried on `Station` itself: `Station`
          // represents what the API actually returned, and this is exactly the same "derived,
          // DB-only field" treatment `lifecycleState`/`consecutiveMissingSyncs` already get in
          // this same function.
          const { suburb, postcode } = parseSuburbAndPostcodeFromAddress(s.addressLine);
          return {
            sourceStationCode: s.sourceStationCode,
            source: s.source,
            name: s.name,
            brand: s.brand,
            addressLine: s.addressLine,
            suburb,
            postcode,
            latitude: String(s.latitude),
            longitude: String(s.longitude),
            state: s.state,
            lifecycleState: "active" as const,
            consecutiveMissingSyncs: 0,
            sourceUpdatedAt: now,
            firstSeenAt: now,
            lastSeenAt: now,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [station.sourceStationCode, station.source],
        set: {
          name: sql`excluded.name`,
          brand: sql`excluded.brand`,
          addressLine: sql`excluded.address_line`,
          suburb: sql`excluded.suburb`,
          postcode: sql`excluded.postcode`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          state: sql`excluded.state`,
          // Reappearing in reference data is unambiguous evidence of existence — reactivate
          // regardless of what full_sync's price-absence graduation had previously set.
          lifecycleState: sql`excluded.lifecycle_state`,
          consecutiveMissingSyncs: sql`excluded.consecutive_missing_syncs`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });
  }

  const currentCodes = stations.map((s) => s.sourceStationCode);
  const deactivated = await db
    .update(station)
    .set({ lifecycleState: "inactive" })
    .where(
      and(notInArray(station.sourceStationCode, currentCodes), eq(station.source, "NSW_FUEL_API")),
    )
    .returning({ id: station.id });

  return { upserted: stations.length, deactivated: deactivated.length };
}

export interface StationGraduationResult {
  reactivated: number;
  markedSuspect: number;
  markedSuspectWithAlarm: number;
  markedInactive: number;
}

/**
 * `full_sync` job: the graduated absence tracking from §8.6 — a station missing from one price
 * response is weak evidence, not an instant deactivation. `presentStationCodes` is every
 * station code seen in this full sync's price data.
 *
 * Only ever escalates a station's *lifecycle_state* via this path, never past what reference
 * data itself has already said — a station reference data has removed entirely stays
 * `inactive` regardless of what a later `/prices` response happens to still mention (a stale
 * cached price on NSW's side, not evidence the station still exists).
 *
 * Two bulk `UPDATE ... RETURNING` statements, not a per-row loop — the original row-by-row
 * version had the identical performance problem `upsertStationsFromReferenceData` did (same
 * class of bug, found the same way: it was still running, unfinished, well past when a
 * ~3,300-row real dataset should have completed). `consecutive_missing_syncs = consecutive_
 * missing_syncs + 1` is a *relative* update, so the new value for every missing station can be
 * computed by Postgres itself in one statement — no need to fetch each row's prior value into
 * JS first the way a per-row "increment this specific counter" loop would.
 */
export async function recordFullSyncStationPresence(
  db: Db,
  presentStationCodes: ReadonlySet<string>,
): Promise<StationGraduationResult> {
  const presentCodesArray = Array.from(presentStationCodes);

  // Everything absent from this run, not already inactive: bump the counter, and let Postgres
  // decide suspect-vs-inactive from the *new* count in the same statement.
  const escalated = await db
    .update(station)
    .set({
      consecutiveMissingSyncs: sql`${station.consecutiveMissingSyncs} + 1`,
      lifecycleState: sql`case when ${station.consecutiveMissingSyncs} + 1 >= ${MISSING_SYNCS_BEFORE_INACTIVE} then 'inactive' else 'suspect' end`,
    })
    .where(
      and(
        eq(station.source, "NSW_FUEL_API"),
        // presentCodesArray can be empty (a full sync that returned zero prices) — notInArray
        // against an empty list is vacuously true for every row in plain SQL, which is exactly
        // the right behaviour here (nothing present means everything else escalates), but
        // Drizzle's notInArray needs at least one value to build valid SQL, so guard explicitly.
        presentCodesArray.length > 0
          ? notInArray(station.sourceStationCode, presentCodesArray)
          : sql`true`,
        notInArray(station.lifecycleState, ["inactive"]),
      ),
    )
    .returning({
      consecutiveMissingSyncs: station.consecutiveMissingSyncs,
      lifecycleState: station.lifecycleState,
    });

  // Present, and previously missing/suspect: full reset, one statement for every such station.
  const reactivated =
    presentCodesArray.length > 0
      ? await db
          .update(station)
          .set({ consecutiveMissingSyncs: 0, lifecycleState: "active", lastSeenAt: new Date() })
          .where(
            and(
              eq(station.source, "NSW_FUEL_API"),
              inArray(station.sourceStationCode, presentCodesArray),
              sql`(${station.consecutiveMissingSyncs} > 0 or ${station.lifecycleState} = 'suspect')`,
            ),
          )
          .returning({ id: station.id })
      : [];

  const result: StationGraduationResult = {
    reactivated: reactivated.length,
    markedSuspect: 0,
    markedSuspectWithAlarm: 0,
    markedInactive: 0,
  };
  for (const row of escalated) {
    if (row.lifecycleState === "inactive") {
      result.markedInactive++;
    } else if (row.consecutiveMissingSyncs >= 2) {
      result.markedSuspectWithAlarm++; // §8.6: "2 -> suspect. Alarm raised."
    } else {
      result.markedSuspect++;
    }
  }
  return result;
}

/**
 * Code -> id, for quality-gate lookups and FK resolution when persisting observations.
 * Excludes only `inactive` stations — `suspect` ones are deliberately included: §8.6 says
 * suspect stations are "still searchable," a degraded-confidence flag, not an ingestion cutoff.
 * Excluding them here would reject their price data via the quality gate, which would also be
 * self-defeating: a suspect station's only path back to `active` is `full_sync` observing it
 * present again, and that pathway doesn't depend on this map — but there's no reason to also
 * throw away perfectly good price data for a station that's merely under closer watch.
 */
export async function loadKnownStationCodeToId(db: Pick<PostgresJsDatabase, "select">) {
  const rows = await db
    .select({ id: station.id, sourceStationCode: station.sourceStationCode })
    .from(station)
    .where(
      and(eq(station.source, "NSW_FUEL_API"), notInArray(station.lifecycleState, ["inactive"])),
    );
  return new Map(rows.map((r) => [r.sourceStationCode, r.id]));
}
