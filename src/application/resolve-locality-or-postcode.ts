/**
 * Extracted from `handle-search-request.ts` (`feature/search-api`) once `handle-commute-request.ts`
 * (`feature/commute-screen`) needed the identical logic for two fields instead of one — the
 * "combined helper" `feature/locality-resolver`/`feature/postcode-resolver` both deferred to
 * whichever branch actually consumed them, now shared rather than duplicated a second time.
 *
 * Tries a free-text input as a suburb name first, then as a postcode — one input field resolved
 * against both static datasets.
 */
import { resolveLocality } from "../domain/locality/locality-resolver";
import type { LatLng } from "../domain/calculation/types";
import { loadNswLocalities } from "../infrastructure/locality/load-nsw-localities";
import { loadNswTasPostcodes } from "../infrastructure/locality/load-nsw-tas-postcodes";

export function resolveLocalityOrPostcode(locality: string): LatLng | undefined {
  const bySuburb = resolveLocality(locality, loadNswLocalities());
  if (bySuburb) return { latitude: bySuburb.latitude, longitude: bySuburb.longitude };

  const byPostcode = resolveLocality(locality, loadNswTasPostcodes());
  if (byPostcode) return { latitude: byPostcode.latitude, longitude: byPostcode.longitude };

  return undefined;
}
