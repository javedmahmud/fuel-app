import { parseLastUpdated } from "./timestamps";
import type {
  FuelType,
  PriceObservation,
  RawFuelType,
  RawPrice,
  RawStation,
  Station,
} from "./types";

/**
 * Raw vendor shapes → our own domain types. Nothing in `types.ts`'s `Raw*` interfaces should
 * ever be visible outside `fuel-api/` — this module is the one-way door.
 */

export function normaliseStation(raw: RawStation): Station {
  return {
    sourceStationCode: raw.code,
    source: "NSW_FUEL_API",
    name: raw.name,
    brand: raw.brand,
    addressLine: raw.address,
    latitude: raw.location.latitude,
    longitude: raw.location.longitude,
    state: raw.state,
  };
}

export function normaliseFuelType(raw: RawFuelType): FuelType {
  return {
    sourceCode: raw.code,
    displayName: raw.name,
  };
}

/**
 * `06_DATA_ARCHITECTURE.md` §6.4: prices are stored as integer tenths of a cent per litre, e.g.
 * 178.9 c/L → 1789. The raw API gives cents/L to one decimal (e.g. 176.9) as a JS number —
 * `Math.round`, not a plain multiply, because floating point makes `176.9 * 10` land on
 * 1768.9999999999998 rather than exactly 1769.
 */
export function toPriceTenthsCpl(centsPerLitre: number): number {
  return Math.round(centsPerLitre * 10);
}

/**
 * Also coerces `stationcode` (number, on the price record) toward the same string type as
 * `Station.sourceStationCode` (from `station.code`, a string) — the confirmed type mismatch
 * from §21.2. Never compare the raw fields directly; compare through this normalised shape.
 */
export function normalisePrice(raw: RawPrice): PriceObservation {
  return {
    sourceStationCode: String(raw.stationcode),
    fuelTypeSourceCode: raw.fueltype,
    priceTenthsCpl: toPriceTenthsCpl(raw.price),
    sourceReportedAt: parseLastUpdated(raw.lastupdated),
    raw,
  };
}
