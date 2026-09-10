/**
 * Loads the static NSW/TAS postcode dataset (`scripts/build-postcode-dataset.ts`'s output) once
 * per process and caches it — 753 small objects, same treatment as
 * `load-nsw-localities.ts`'s locality dataset and for the same reason: genuinely static
 * reference data, not something that changes at runtime.
 */
import type { LocalityEntry } from "../../domain/locality/locality-resolver";
import postcodesJson from "./nsw-tas-postcodes.json";

/**
 * ABS ASGS Edition 3, Postal Areas (POA), CC BY 4.0 — attribution is a licence condition, not a
 * courtesy: "required wherever this data or anything derived from it is used or displayed"
 * (`spike/geo-data/README.md`). Whichever screen renders postcode search or results derived
 * from it must display this string somewhere a user can see it.
 */
export const ATTRIBUTION =
  "Australian Bureau of Statistics, ASGS Edition 3, Postal Areas, licensed under CC BY 4.0.";

let cached: LocalityEntry[] | undefined;

export function loadNswTasPostcodes(): readonly LocalityEntry[] {
  if (!cached) {
    cached = postcodesJson as LocalityEntry[];
  }
  return cached;
}
