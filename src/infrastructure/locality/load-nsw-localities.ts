/**
 * Loads the static NSW locality dataset (`scripts/build-locality-dataset.ts`'s output) once per
 * process and caches it — 4,542 small objects, trivial to hold in memory for the process
 * lifetime, and it never changes at runtime (a new ABS edition means re-running the build script
 * and redeploying, not a live update).
 */
import type { LocalityEntry } from "../../domain/locality/locality-resolver";
import localitiesJson from "./nsw-localities.json";

/**
 * ABS ASGS Edition 3, Suburbs and Localities (SAL), CC BY 4.0 — attribution is a licence
 * condition, not a courtesy: "required wherever this data or anything derived from it is used
 * or displayed" (`spike/geo-data/README.md`). Whichever screen renders locality search or
 * results derived from it (the Home screen's suburb fallback, most likely) must display this
 * string somewhere a user can see it — not buried in a footer nobody reaches, but present.
 */
export const ATTRIBUTION =
  "Australian Bureau of Statistics, ASGS Edition 3, Suburbs and Localities, licensed under CC BY 4.0.";

let cached: LocalityEntry[] | undefined;

export function loadNswLocalities(): readonly LocalityEntry[] {
  if (!cached) {
    cached = localitiesJson as LocalityEntry[];
  }
  return cached;
}
