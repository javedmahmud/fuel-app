/**
 * One-off/rare-rerun build step, not part of the runtime app — turns the raw ABS postal-area
 * point layer (`spike/geo-data/poa_centroids.geojson`, `README.md` in that directory) into the
 * compact asset `src/infrastructure/locality/nsw-tas-postcodes.json` the running app loads.
 *
 * `LocalityResolver` (`feature/locality-resolver`) only resolves by locality *name* — postcodes
 * are Australia Post's construct, not ABS's, so `SAL_PT` has no postcode field at all. This is
 * the same approach applied to ABS's own postcode approximation (`POA_PT`) instead, closing the
 * gap `21_DETAILED_DESIGN.md` §21.9's "suburb or postcode entry" language for the Home screen
 * leaves otherwise.
 *
 * Re-run only when the source data changes, via `npm run postcode:build`.
 *
 * **Licence note — do not drop this if the source ever changes.** ABS ASGS Edition 3, Postal
 * Areas (POA), CC BY 4.0. Attribution required wherever this data (or anything derived from it,
 * including this generated file) is used or displayed:
 * "Australian Bureau of Statistics, ASGS Edition 3, Postal Areas, licensed under CC BY 4.0."
 * `src/infrastructure/locality/load-nsw-tas-postcodes.ts` exports this exact string as
 * `ATTRIBUTION` — whichever screen ends up rendering postcode search results must show it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface RawFeature {
  properties: { poa_code_2021: string };
  geometry: { coordinates: [number, number][] } | null;
}

interface RawGeoJson {
  features: RawFeature[];
}

interface PostcodeEntry {
  /** The 4-digit postcode itself, as a string (never a number — leading zeros, e.g. Darwin's
   * "0800", would be silently lost as a JS number). Named `name` to match `LocalityEntry`'s
   * shape exactly, so `locality-resolver.ts`'s `resolveLocality`/`suggestLocalities` work
   * unmodified against this dataset too — a postcode lookup and a suburb-name lookup are the
   * same shape of problem, just a different backing table. */
  name: string;
  latitude: number;
  longitude: number;
}

const sourcePath = resolve(import.meta.dirname, "../../../spike/geo-data/poa_centroids.geojson");
const outputPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/locality/nsw-tas-postcodes.json",
);

const raw: RawGeoJson = JSON.parse(readFileSync(sourcePath, "utf-8"));

// Confirmed live: 3 of the 2,644 national features have a null geometry — the same class of
// ABS non-geographic catch-all as SAL's ("No usual address (Aust.)", "Migratory - Offshore -
// Shipping (Aust.)", "Outside Australia"). Excluded, not defaulted to (0,0).
const withGeometry = raw.features.filter(
  (f): f is RawFeature & { geometry: NonNullable<RawFeature["geometry"]> } => f.geometry !== null,
);

// Unlike SAL, POA_PT has no state field at all — postcodes aren't a state-scoped ABS geography
// (confirmed live against the layer's schema: poa_code_2021, poa_name_2021, aus_code_2021,
// aus_name_2021 — national only). Filtered here instead, by the conventional NSW (1000-1999,
// 2000-2999) and TAS (7000-7999) postcode number ranges — the same NSW/TAS scope
// station.state/the plausibility gates already use elsewhere in this codebase. A postcode
// resolving to an ACT address (2600-2620/2900s, numerically inside the NSW range) is not
// excluded specially: it resolves correctly and then legitimately finds no_eligible_candidates,
// the same honest behaviour as any other search point with no nearby NSW Fuel API stations.
//
// The 1000-1999 half of the NSW range is kept for completeness even though it's confirmed live
// to contribute zero rows from this dataset: those are Sydney PO-Box/Large-Volume-Receiver
// codes with no distinct ABS geography, so POA never lists one. Harmless to keep checking for,
// and correct if a future ABS edition ever did assign one a real point.
function isNswOrTasPostcode(code: string): boolean {
  const prefix = code.slice(0, 1);
  return prefix === "1" || prefix === "2" || prefix === "7";
}

const inScope = withGeometry.filter((f) => isNswOrTasPostcode(f.properties.poa_code_2021));

const postcodes: PostcodeEntry[] = inScope
  .map((f) => ({
    name: f.properties.poa_code_2021,
    longitude: f.geometry.coordinates[0][0],
    latitude: f.geometry.coordinates[0][1],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Confirmed live: all national POA codes are unique, so NSW/TAS-range codes stay unique too —
// re-checked here rather than trusted, same discipline as build-locality-dataset.ts.
const nameCounts = new Map<string, number>();
for (const p of postcodes) {
  nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
}
const duplicates = [...nameCounts.entries()].filter(([, count]) => count > 1);
if (duplicates.length > 0) {
  throw new Error(
    `build-postcode-dataset: ${duplicates.length} duplicate postcode(s) found. ` +
      `First few: ${duplicates
        .slice(0, 5)
        .map(([n]) => n)
        .join(", ")}`,
  );
}

writeFileSync(outputPath, JSON.stringify(postcodes, null, 2) + "\n");
console.log(
  `Wrote ${postcodes.length} NSW/TAS postcodes to ${outputPath} ` +
    `(${withGeometry.length - inScope.length} non-NSW/TAS postcodes excluded, ` +
    `${raw.features.length - withGeometry.length} non-geographic features excluded)`,
);
