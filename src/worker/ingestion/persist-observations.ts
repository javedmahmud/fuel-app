import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { ingestionRun } from "../../infrastructure/db/schema";
import { contentHashForObservation } from "../../infrastructure/ingestion/content-hash";
import {
  applyQualityGates,
  isNonPricedFuelType,
  type QualityGateReason,
} from "../../infrastructure/ingestion/quality-gates";
import type { PriceObservation } from "../../infrastructure/fuel-api/types";
import { insertObservationsIdempotent } from "../../infrastructure/repositories/observation-repository";
import { loadActiveFuelTypeCodeToId } from "../../infrastructure/repositories/fuel-type-repository";
import { loadKnownStationCodeToId } from "../../infrastructure/repositories/station-repository";

type Db = Pick<PostgresJsDatabase, "select" | "insert" | "update">;

export interface PersistObservationsResult {
  insertedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  rejectedByReason: Partial<Record<QualityGateReason, number>>;
  /** Records filtered out before ever reaching applyQualityGates because they're a known
   * non-priced fuel-type placeholder (e.g. "EV") — see quality-gates.ts's
   * isNonPricedFuelType. Deliberately NOT part of rejectedCount/rejectedByReason: they were
   * never price data to begin with, not price data that failed a check, so folding them into
   * "rejected" would keep making §8.11's rejected_pct alarm fire on every healthy run. */
  skippedNonPricedCount: number;
  /** Every station code actually seen in this batch's raw price data, regardless of whether
   * its price passed the quality gates — `full_sync`'s presence-graduation (§8.6) needs this
   * even for a station whose specific price got rejected; the station itself was still there. */
  observedStationCodes: Set<string>;
}

/**
 * Shared by `new_prices` and `full_sync` — both fetch price records from the adapter and need
 * the exact same gate → hash → idempotent-insert pipeline (§8.4's flowchart, the
 * "gates -> hash -> tx" tail). What differs between the two jobs is what happens *around* this
 * (full_sync additionally does station-presence graduation, §8.6) — not this step itself.
 */
export async function persistObservations(
  db: Db,
  observations: PriceObservation[],
  ingestionRunId: string,
  now: Date,
): Promise<PersistObservationsResult> {
  const [stationCodeToId, fuelTypeCodeToId] = await Promise.all([
    loadKnownStationCodeToId(db),
    loadActiveFuelTypeCodeToId(db),
  ]);
  const knownStationCodes = new Set(stationCodeToId.keys());
  const knownFuelTypeCodes = new Set(fuelTypeCodeToId.keys());

  const observedStationCodes = new Set<string>();
  const rejectedByReason: Partial<Record<QualityGateReason, number>> = {};
  const toInsert: Parameters<typeof insertObservationsIdempotent>[1] = [];
  let skippedNonPricedCount = 0;

  for (const observation of observations) {
    observedStationCodes.add(observation.sourceStationCode);

    // The station was still genuinely present in this response (counted above for full_sync's
    // presence-graduation, §8.6) even when its only record is a non-priced placeholder — this
    // filter is about the fuel type, not the station.
    if (isNonPricedFuelType(observation.fuelTypeSourceCode)) {
      skippedNonPricedCount++;
      continue;
    }

    const outcome = applyQualityGates(observation, { knownStationCodes, knownFuelTypeCodes, now });
    if (!outcome.accepted) {
      rejectedByReason[outcome.reason] = (rejectedByReason[outcome.reason] ?? 0) + 1;
      continue;
    }

    // sourceReportedAt is guaranteed defined here — applyQualityGates already rejected any
    // observation where it was undefined (the "source_reported_at_insane" gate).
    const sourceReportedAt = observation.sourceReportedAt as Date;
    toInsert.push({
      stationId: stationCodeToId.get(observation.sourceStationCode) as string,
      fuelTypeId: fuelTypeCodeToId.get(observation.fuelTypeSourceCode) as string,
      priceTenthsCpl: observation.priceTenthsCpl,
      sourceReportedAt,
      ingestionRunId,
      source: "NSW_FUEL_API",
      rawPayload: observation.raw,
      contentHash: contentHashForObservation(observation, "NSW_FUEL_API", sourceReportedAt),
    });
  }

  const { insertedCount, duplicateCount } = await insertObservationsIdempotent(db, toInsert);
  const rejectedCount = Object.values(rejectedByReason).reduce((sum, n) => sum + (n ?? 0), 0);

  // recordsPersisted/recordsRejected have existed on ingestion_run since the db-schema branch
  // but nothing wrote them until this — same class of gap recordsReceived had before the
  // fuel-api-adapter branch fixed it (§6.3: these columns exist specifically to answer "why is
  // this price 6 hours old," which stays unanswerable if they're always 0).
  await db
    .update(ingestionRun)
    .set({ recordsPersisted: insertedCount, recordsRejected: rejectedCount })
    .where(eq(ingestionRun.id, ingestionRunId));

  return {
    insertedCount,
    duplicateCount,
    rejectedCount,
    rejectedByReason,
    skippedNonPricedCount,
    observedStationCodes,
  };
}
