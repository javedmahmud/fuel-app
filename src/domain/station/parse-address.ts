/**
 * The NSW Fuel API's own station record has no separate suburb/postcode field — only one
 * combined `address` string (`fuel-api/types.ts`'s `RawStationSchema`: `address: z.string()`).
 * `station.suburb`/`.postcode` (`infrastructure/db/schema/station.ts`) exist in the schema but
 * were never populated by ingestion until this module — confirmed live against all 3,321 real
 * staging stations (2026-09) before writing this, and re-confirmed after: **100%** of address
 * lines carry a real `STATE POSTCODE` pair somewhere in them, and 99.1% additionally have a
 * comma right before the suburb (e.g. `"101 HECTOR ST, SEFTON NSW 2162"`). Pure — no I/O, no
 * clock (`src/domain/README.md`'s rules).
 *
 * **Deliberately conservative on suburb.** Requiring the comma directly before the suburb
 * segment is what makes this safe: without it, a street name and a suburb are often
 * indistinguishable by pattern alone (`"275 PACIFIC HWY Hornsby NSW 2077"` — is the suburb
 * `"Hornsby"` or `"PACIFIC HWY Hornsby"`? Nothing in the string says). Rather than guess, the
 * ~0.9% of real addresses without that comma get `suburb: null` — an honest gap, the same
 * behaviour as before this module existed, not a regression. Postcode has no such ambiguity (the
 * last four digits after a state code are always the postcode, comma or not), so it's extracted
 * independently and succeeds far more often than suburb does.
 */

// "NEW SOUTH WALES" is the one confirmed-live spelled-out variant (1 of 3,321 real addresses);
// not chasing every other state's spelled-out form on no evidence any appears in this feed.
const AU_STATE_CODES = "NSW|ACT|VIC|QLD|SA|WA|TAS|NT|NEW SOUTH WALES";

// A state code/name, then a 4-digit postcode, bounded by `\b` rather than anchored to the very
// end of the string — confirmed live: a small number of real addresses carry trailing junk after
// the postcode (`"...NSW  2358, AU"`). `\b` still refuses to match inside a longer digit run
// (so "2358" in "23581" would not qualify), which is all the anchoring actually buys here.
const POSTCODE_PATTERN = new RegExp(`\\b(?:${AU_STATE_CODES})\\s+(\\d{4})\\b`, "i");

// A comma, then a run of letters/spaces/hyphens/apostrophes (deliberately excluding digits and
// commas, so it can never stretch across a street number or an earlier, unrelated comma), then
// an optional second comma (real addresses sometimes punctuate "Suburb, NSW 2358" fully, not
// just "Suburb NSW 2358"), then a state+postcode pair.
const SUBURB_PATTERN = new RegExp(
  `,\\s*([A-Za-z][A-Za-z'\\-\\s]*?),?\\s+(?:${AU_STATE_CODES})\\s+\\d{4}\\b`,
  "i",
);

export interface ParsedAddress {
  /** `null` when the address has no comma directly before a plausible suburb segment — never a
   * guess. Returned exactly as it appears in the source address (not case-normalised): the NSW
   * Fuel API mixes `"SEFTON"` and `"Rockdale"`-style casing across stations. */
  suburb: string | null;
  /** `null` only when the address doesn't end in a recognisable `STATE 1234` pair at all. */
  postcode: string | null;
}

export function parseSuburbAndPostcodeFromAddress(addressLine: string): ParsedAddress {
  const postcodeMatch = POSTCODE_PATTERN.exec(addressLine);
  const suburbMatch = SUBURB_PATTERN.exec(addressLine);

  return {
    suburb: suburbMatch ? suburbMatch[1].trim() : null,
    postcode: postcodeMatch ? postcodeMatch[1] : null,
  };
}
