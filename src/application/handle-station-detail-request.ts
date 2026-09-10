/**
 * `21_DETAILED_DESIGN.md` §21.1: "`GET /api/v1/stations/{stationId}` — UC-05. Station detail —
 * code, name, brand, address, location, current prices per fuel type, freshness band per §9.5,
 * provenance (source + timestamp, per §13.16), distance from the caller's last-known point if
 * supplied." Same "thin route, testable core" split as `handle-search-request.ts` — returns a
 * plain `{status, body}` a test can assert on directly, with an injected `db` (a rolled-back
 * transaction in tests) rather than the real pool.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { haversineDistanceKm } from "../domain/calculation/geo";
import { priceAgeBand } from "../domain/calculation/freshness";
import type { LatLng } from "../domain/calculation/types";
import { loadActiveFuelTypes } from "../infrastructure/repositories/fuel-type-repository";
import {
  loadCurrentPricesForStation,
  loadStationById,
} from "../infrastructure/repositories/station-detail-repository";
import type { HandlerResult } from "./http-handler-result";

type Db = Pick<PostgresJsDatabase, "select" | "selectDistinctOn">;

const stationIdSchema = z.string().uuid();

const querySchema = z
  .object({
    lat: z.coerce.number().optional(),
    lng: z.coerce.number().optional(),
  })
  .refine((data) => (data.lat === undefined) === (data.lng === undefined), {
    message: "lat and lng must be provided together.",
  });

function errorResult(status: number, error: string, message: string): HandlerResult {
  return { status, body: { error, message } };
}

export async function handleStationDetailRequest(
  db: Db,
  rawStationId: string,
  searchParams: URLSearchParams,
  now: Date,
): Promise<HandlerResult> {
  const stationIdParsed = stationIdSchema.safeParse(rawStationId);
  if (!stationIdParsed.success) {
    return errorResult(400, "invalid_station_id", "stationId must be a valid UUID.");
  }
  const stationId = stationIdParsed.data;

  const queryParsed = querySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!queryParsed.success) {
    return errorResult(
      400,
      "invalid_query",
      queryParsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const detail = await loadStationById(db, stationId);
  if (!detail) {
    return errorResult(404, "station_not_found", `No station with id "${stationId}".`);
  }

  const [currentPrices, fuelTypes] = await Promise.all([
    loadCurrentPricesForStation(db, stationId),
    loadActiveFuelTypes(db),
  ]);

  const prices = [...currentPrices.entries()]
    .map(([fuelTypeId, price]) => {
      const fuelType = fuelTypes.get(fuelTypeId);
      if (!fuelType) return null; // a price for a fuel type the provider has since delisted
      return {
        fuelType: fuelType.sourceCode,
        fuelTypeDisplayName: fuelType.displayName,
        price: {
          centsPerLitre: price.priceTenthsCpl / 10,
          lastUpdated: price.sourceReportedAt.toISOString(),
        },
        // §9.5's station-detail-facing band ("Price set 6 hours ago" / "unchanged for 3 days" /
        // "confirm at the pump") — deliberately not `pipelineHealthBand`, a different question.
        freshnessBand: priceAgeBand(price.sourceReportedAt, now),
        source: "NSW Fuel API",
        sourceObservedAt: price.sourceReportedAt.toISOString(),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => a.fuelType.localeCompare(b.fuelType));

  let distanceKm: number | null = null;
  if (queryParsed.data.lat !== undefined && queryParsed.data.lng !== undefined) {
    const from: LatLng = { latitude: queryParsed.data.lat, longitude: queryParsed.data.lng };
    distanceKm = haversineDistanceKm(from, detail.location);
  }

  return {
    status: 200,
    body: {
      stationId: detail.id,
      name: detail.name,
      brand: detail.brand,
      address: {
        line: detail.addressLine,
        suburb: detail.suburb,
        postcode: detail.postcode,
        state: detail.state,
      },
      location: detail.location,
      distanceKm,
      prices,
    },
  };
}
