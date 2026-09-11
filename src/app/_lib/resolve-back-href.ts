/**
 * Station Details' "back" link target (`feature/results-ux-feedback`, extended in
 * `feature/commute-screen`) — the Results and Commute Mode screens each set `?from=` to the exact
 * URL a card was rendered on, so returning from a station goes back to those results (same
 * query), not a blank Home screen. `from` is driver-controlled (a query param on a page anyone
 * could construct or share), so it's validated as one of a fixed, known-safe set of same-app path
 * prefixes before ever being used as a link target — never trusted as an arbitrary redirect
 * destination.
 */
const ALLOWED_RETURN_PREFIXES = ["/search?", "/commute?"];

export function resolveBackHref(from: string | undefined): string {
  if (from && ALLOWED_RETURN_PREFIXES.some((prefix) => from.startsWith(prefix))) return from;
  return "/";
}
