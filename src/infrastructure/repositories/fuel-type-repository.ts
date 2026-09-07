import { eq, notInArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { fuelType } from "../db/schema";
import type { FuelType } from "../fuel-api/types";

type Db = Pick<PostgresJsDatabase, "select" | "insert" | "update">;

/**
 * `ref_data` job — weekly sync of the small, slow-changing fuel-type table
 * (`06_DATA_ARCHITECTURE.md` §6.3). Upserts every fetched type as active, then deactivates
 * anything previously known that the provider stopped listing — mirroring the same "reference
 * data is the authority on existence" principle §8.6 states for stations, just without the
 * graduated suspect/inactive states stations need (fuel types don't have a per-price absence
 * signal the way stations do — either the provider lists a code or it doesn't).
 */
export async function upsertFuelTypesFromReferenceData(
  db: Db,
  fuelTypes: FuelType[],
): Promise<{ upserted: number; deactivated: number }> {
  if (fuelTypes.length === 0) {
    return { upserted: 0, deactivated: 0 };
  }

  for (const ft of fuelTypes) {
    await db
      .insert(fuelType)
      .values({
        sourceCode: ft.sourceCode,
        displayName: ft.displayName,
        // category isn't derivable from the reference-data response — 06_DATA_ARCHITECTURE.md
        // §6.2 lists it as our own classification, not a vendor field. Defaults to "other";
        // categorising real codes is a small follow-up, not blocking persistence itself.
        category: "other",
        isActive: true,
      })
      .onConflictDoUpdate({
        target: fuelType.sourceCode,
        set: { displayName: ft.displayName, isActive: true },
      });
  }

  const currentCodes = fuelTypes.map((ft) => ft.sourceCode);
  const deactivated = await db
    .update(fuelType)
    .set({ isActive: false })
    .where(notInArray(fuelType.sourceCode, currentCodes))
    .returning({ id: fuelType.id });

  return { upserted: fuelTypes.length, deactivated: deactivated.length };
}

/** Code -> id, for quality-gate lookups and FK resolution when persisting observations. Only
 * active fuel types — an inactive one shouldn't validate new incoming prices against it. */
export async function loadActiveFuelTypeCodeToId(db: Pick<PostgresJsDatabase, "select">) {
  const rows = await db
    .select({ id: fuelType.id, sourceCode: fuelType.sourceCode })
    .from(fuelType)
    .where(eq(fuelType.isActive, true));
  return new Map(rows.map((r) => [r.sourceCode, r.id]));
}
