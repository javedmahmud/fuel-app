import { z } from "zod";

/**
 * Raw response shapes, confirmed live against the real sandbox — `spike/findings/*.raw.json`
 * (Tests 1, 2, 3) and `21_DETAILED_DESIGN.md` §21.2. These are the *vendor's* field names and
 * casing (lowercase, no separators) — never renamed here, so a schema diff against a fresh raw
 * capture stays a literal diff. Renaming into our own conventions happens in normalise.ts,
 * one step later, never here.
 */

export const RawStationSchema = z.object({
  brandid: z.string(),
  stationid: z.string(),
  brand: z.string(),
  code: z.string(),
  name: z.string(),
  address: z.string(),
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }),
  state: z.string(),
});
export type RawStation = z.infer<typeof RawStationSchema>;

export const RawFuelTypeSchema = z.object({
  code: z.string(),
  name: z.string(),
  state: z.string(),
});
export type RawFuelType = z.infer<typeof RawFuelTypeSchema>;

export const RawBrandSchema = z.object({
  name: z.string(),
  state: z.string(),
});

/** `GET /FuelCheckRefData/v2/fuel/lovs` — the `ref_data` job's response. */
export const ReferenceDataResponseSchema = z.object({
  stations: z.object({ items: z.array(RawStationSchema) }),
  fueltypes: z.object({ items: z.array(RawFuelTypeSchema) }),
  brands: z.object({ items: z.array(RawBrandSchema) }),
});
export type ReferenceDataResponse = z.infer<typeof ReferenceDataResponseSchema>;

/**
 * A raw price record. Note the confirmed type mismatch (§21.2): `station.code` is a **string**,
 * but `stationcode` here is a **number** — the same station, two different JSON types across
 * two parts of the same response. Coerced to a common type in normalise.ts, never compared
 * directly.
 */
export const RawPriceSchema = z.object({
  stationcode: z.number(),
  state: z.string(),
  fueltype: z.string(),
  /** Cents per litre, e.g. 176.9 — one decimal place, not yet the integer tenths our schema
   * stores (`06_DATA_ARCHITECTURE.md` §6.4). Converted in normalise.ts. */
  price: z.number(),
  /** `dd/MM/yyyy HH:mm:ss`, Sydney local — NOT ISO 8601. See timestamps.ts. */
  lastupdated: z.string(),
});
export type RawPrice = z.infer<typeof RawPriceSchema>;

/**
 * `GET /FuelPriceCheck/v2/fuel/prices` and `.../prices/new` share this exact envelope —
 * confirmed identical shape, just different row counts (`spike/findings/test2.raw.json` vs
 * `test3b-60.raw.json`).
 */
export const PricesResponseSchema = z.object({
  stations: z.array(RawStationSchema),
  prices: z.array(RawPriceSchema),
});
export type PricesResponse = z.infer<typeof PricesResponseSchema>;

/**
 * Our own shapes, downstream of normalisation — `07_FUEL_API_INTEGRATION.md` §7.4's
 * `PriceObservation[] · Station[] · FuelType[]`. No vendor type escapes past this module;
 * nothing above this line is imported by anything outside `fuel-api/`.
 */

export interface Station {
  sourceStationCode: string;
  source: "NSW_FUEL_API";
  name: string;
  brand: string;
  addressLine: string;
  latitude: number;
  longitude: number;
  state: string;
}

export interface FuelType {
  sourceCode: string;
  displayName: string;
}

export interface PriceObservation {
  /** Coerced to a string so it can be joined against `Station.sourceStationCode` without the
   * number/string mismatch the raw API has between the two endpoints that mention it. */
  sourceStationCode: string;
  fuelTypeSourceCode: string;
  /** Integer tenths of a cent per litre — `06_DATA_ARCHITECTURE.md` §6.4's storage unit. */
  priceTenthsCpl: number;
  /** `undefined` when `lastupdated` didn't parse — see timestamps.ts. Left for the ingestion
   * job's data-quality gate (§6.9) to reject, not something this adapter decides. */
  sourceReportedAt: Date | undefined;
  raw: RawPrice;
}

export interface ReferenceData {
  stations: Station[];
  fuelTypes: FuelType[];
}

/**
 * Every failure mode `07_FUEL_API_INTEGRATION.md` §7.8's table names, as a closed union rather
 * than a generic Error — the point of `Result<T, FuelApiError>` (§7.4) is that callers can
 * exhaustively handle "what kind of not-ok is this" without parsing a message string.
 */
export type FuelApiError =
  | { type: "timeout"; message: string }
  | { type: "rate_limited"; retryAfterSeconds?: number }
  | { type: "auth_failed"; message: string }
  | { type: "server_error"; status: number; message: string }
  | { type: "malformed_response"; message: string }
  | { type: "budget_exceeded" }
  | { type: "circuit_open" }
  | { type: "key_environment_mismatch"; recordedEnvironment: string; currentEnvironment: string };
