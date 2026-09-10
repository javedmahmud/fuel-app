/**
 * The plain, framework-agnostic result shape every `handle-*-request.ts` core function returns
 * (`handle-search-request.ts`, `handle-station-detail-request.ts`,
 * `handle-station-history-request.ts`) — status/body/headers, not a `NextResponse`. Its own
 * route.ts wrapper is the only place this gets turned into a real HTTP response; a test can
 * assert on this directly instead of parsing a `Response` object.
 */
export interface HandlerResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
