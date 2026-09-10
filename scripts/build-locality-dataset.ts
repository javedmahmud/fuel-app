/**
 * One-off/rare-rerun build step, not part of the runtime app — turns the spike's raw ABS point
 * layer (`spike/geo-data/nsw_sal_centroids.geojson`, `README.md` in that directory: "this is the
 * raw point layer... turning it into the app's actual lookup table... is Sprint 4 work, not spike
 * work") into the compact asset `src/infrastructure/locality/nsw-localities.json` the running app
 * actually loads.
 *
 * Re-run only when the source data changes — ABS releases a new ASGS/SAL edition roughly every 5
 * years, not on any regular cadence — via `npm run locality:build`.
 *
 * **Licence note — do not drop this if the source ever changes.** ABS ASGS Edition 3, Suburbs and
 * Localities (SAL), CC BY 4.0. Attribution required wherever this data (or anything derived from
 * it, including this generated file) is used or displayed:
 * "Australian Bureau of Statistics, ASGS Edition 3, Suburbs and Localities, licensed under CC BY 4.0."
 * `src/infrastructure/locality/load-nsw-localities.ts` exports this exact string as `ATTRIBUTION`
 * — whichever screen ends up rendering locality search results must show it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface RawFeature {
  properties: { sal_name_2021: string };
  geometry: { coordinates: [number, number][] } | null;
}

interface RawGeoJson {
  features: RawFeature[];
}

interface LocalityEntry {
  name: string;
  latitude: number;
  longitude: number;
}

const sourcePath = resolve(
  import.meta.dirname,
  "../../../spike/geo-data/nsw_sal_centroids.geojson",
);
const outputPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/locality/nsw-localities.json",
);

const raw: RawGeoJson = JSON.parse(readFileSync(sourcePath, "utf-8"));

// Confirmed live: 2 of the 4,544 features have a null geometry — ABS's own non-geographic
// catch-all categories for census purposes ("No usual address (NSW)", "Migratory - Offshore -
// Shipping (NSW)"), not real places with coordinates. Excluded, not defaulted to (0,0) or
// dropped silently — logged so a future re-run notices if this count ever changes.
const withGeometry = raw.features.filter(
  (f): f is RawFeature & { geometry: NonNullable<RawFeature["geometry"]> } => f.geometry !== null,
);
const withoutGeometry = raw.features.length - withGeometry.length;
if (withoutGeometry > 0) {
  console.log(
    `Skipping ${withoutGeometry} feature(s) with no geometry (non-geographic ABS categories): ` +
      raw.features
        .filter((f) => f.geometry === null)
        .map((f) => f.properties.sal_name_2021)
        .join(", "),
  );
}

const localities: LocalityEntry[] = withGeometry
  .map((f) => ({
    name: f.properties.sal_name_2021,
    // Source is [lng, lat] (GeoJSON convention); the app's own LatLng convention throughout
    // (domain/calculation/types.ts) is {latitude, longitude} — converted here, once, rather than
    // making every caller remember GeoJSON's reversed axis order.
    longitude: f.geometry.coordinates[0][0],
    latitude: f.geometry.coordinates[0][1],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Confirmed live (spike/geo-data/README.md): all 4,544 NSW SAL names are unique, so no dedup
// logic is needed — but checked again here rather than silently trusting that stays true if the
// source dataset is ever regenerated from a newer ABS edition.
const nameCounts = new Map<string, number>();
for (const l of localities) {
  nameCounts.set(l.name, (nameCounts.get(l.name) ?? 0) + 1);
}
const duplicates = [...nameCounts.entries()].filter(([, count]) => count > 1);
if (duplicates.length > 0) {
  throw new Error(
    `build-locality-dataset: ${duplicates.length} duplicate locality name(s) found — ` +
      `LocalityResolver assumes unique names, per spike/geo-data/README.md's confirmed check. ` +
      `First few: ${duplicates
        .slice(0, 5)
        .map(([n]) => n)
        .join(", ")}`,
  );
}

writeFileSync(outputPath, JSON.stringify(localities, null, 2) + "\n");
console.log(`Wrote ${localities.length} NSW localities to ${outputPath}`);
