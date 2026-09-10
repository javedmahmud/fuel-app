/**
 * `21_DETAILED_DESIGN.md` §21.1: `GET /api/v1/search`'s `locality` param — resolved via
 * `LocalityResolver` against ADR-008's static CC BY 4.0 table (no third-party geocoding vendor —
 * see `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.7's "location never leaves the system" privacy
 * dividend of that choice). Pure — no I/O, no clock, no randomness (`src/domain/README.md`): the
 * dataset itself is a parameter, loaded by the infrastructure layer
 * (`infrastructure/locality/load-nsw-localities.ts`), never read from disk here.
 */
import type { LatLng } from "../calculation/types";

export interface LocalityEntry extends LatLng {
  name: string;
}

export interface LocalityMatch extends LocalityEntry {
  /** `exact` when the query matched a locality name's exact casing; `case_insensitive` when it
   * only matched after lowercasing both sides — surfaced so a caller can, if it wants, treat the
   * two differently (e.g. confirm before locking in a fuzzy match), though `resolveLocality`
   * itself accepts either as a valid resolution. */
  matchType: "exact" | "case_insensitive";
}

/**
 * A single best match for a free-text locality query, or `undefined` if nothing matches at all.
 * Every NSW SAL locality name is confirmed unique (`spike/geo-data/README.md`, re-checked by
 * `scripts/build-locality-dataset.ts` on every regeneration), so "one query, one name" always has
 * at most one answer — this never has to pick among several equally-good exact matches.
 */
export function resolveLocality(
  query: string,
  localities: readonly LocalityEntry[],
): LocalityMatch | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;

  const exact = localities.find((l) => l.name === trimmed);
  if (exact) return { ...exact, matchType: "exact" };

  const lowerQuery = trimmed.toLowerCase();
  const caseInsensitive = localities.find((l) => l.name.toLowerCase() === lowerQuery);
  if (caseInsensitive) return { ...caseInsensitive, matchType: "case_insensitive" };

  return undefined;
}

/**
 * Prefix suggestions for a type-ahead UI (the Home screen's suburb/postcode fallback, §21.9) —
 * a genuinely different question from `resolveLocality`'s "is this one query resolvable," so
 * kept as its own function rather than an options flag on that one. Case-insensitive prefix
 * match; `limit` bounds the result size for a dropdown, not a full search result set. Returns
 * matches in whatever order `localities` is given in — the generated dataset is alphabetical
 * (`scripts/build-locality-dataset.ts`), so in practice this yields alphabetically-first matches,
 * not "most relevant"; there's no relevance signal in a static name/coordinate table to rank by.
 */
export function suggestLocalities(
  query: string,
  localities: readonly LocalityEntry[],
  limit = 10,
): LocalityEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const matches: LocalityEntry[] = [];
  for (const locality of localities) {
    if (locality.name.toLowerCase().startsWith(trimmed)) {
      matches.push(locality);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
