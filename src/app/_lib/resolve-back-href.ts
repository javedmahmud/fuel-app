/**
 * Station Details' "back" link target (`feature/results-ux-feedback`) — the Results screen sets
 * `?from=` to the exact `/search?...` URL a card was rendered on, so returning from a station
 * goes back to those results (same query, same sort), not a blank Home screen. `from` is driver-
 * controlled (a query param on a page anyone could construct or share), so it's validated as a
 * same-app `/search` path before ever being used as a link target — never trusted as an arbitrary
 * redirect destination.
 */
export function resolveBackHref(from: string | undefined): string {
  if (from && from.startsWith("/search?")) return from;
  return "/";
}
