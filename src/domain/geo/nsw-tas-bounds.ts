/**
 * `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.9: "Coordinate bounds | Within NSW/TAS box + margin
 * | Rejects nonsense and probing." The doc names the concept but never pins exact numbers, so
 * this is a real implementation decision, documented here rather than silently invented: a
 * rectangle covering NSW mainland (~-28.15 to -37.51 lat, ~140.99 to 153.64 lng) and Tasmania
 * (~-39.6 to -43.65 lat, ~143.8 to 148.5 lng — which fits entirely inside NSW's longitude span,
 * so one rectangle covers both), plus roughly a 1° margin on every side so the check catches
 * genuinely wrong input (another country, `(0, 0)`, transposed lat/lng) without being a precise
 * geographic fence. Deliberately excludes Lord Howe Island (NSW, ~-31.5/159.1) and Macquarie
 * Island (TAS, ~-54.6/158.9) — real NSW/TAS territory, but far enough outside the mainland
 * rectangle that including them would balloon the margin and defeat the "reject nonsense" point;
 * no NSW Fuel API station exists on either anyway.
 */
import type { LatLng } from "../calculation/types";

export const NSW_TAS_BOUNDS = {
  minLat: -44.7,
  maxLat: -27.0,
  minLng: 140.0,
  maxLng: 154.7,
};

export function isWithinNswTasBounds(point: LatLng): boolean {
  return (
    point.latitude >= NSW_TAS_BOUNDS.minLat &&
    point.latitude <= NSW_TAS_BOUNDS.maxLat &&
    point.longitude >= NSW_TAS_BOUNDS.minLng &&
    point.longitude <= NSW_TAS_BOUNDS.maxLng
  );
}
