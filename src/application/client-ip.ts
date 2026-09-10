/**
 * Shared by `route.ts` (has a real `NextRequest`) and any Server Component page that calls a
 * `handle-*-request.ts` core function directly instead of round-tripping through its own HTTP
 * API (`src/app/search/page.tsx` does this for `/search`, the same "Server Components do
 * backend work directly" pattern `21_DETAILED_DESIGN.md` §21.9's Stack section describes). Both
 * only need `.get(name)` — `NextRequest.headers` and `next/headers`' `headers()` both satisfy
 * this without either one importing the other's real type.
 */
export interface HeaderReader {
  get(name: string): string | null;
}

/** NextRequest has no built-in `.ip` in this Next.js version — Railway sits its own proxy in
 * front of the app, which sets `x-forwarded-for` the standard way; the first entry is the
 * original client. Falls back to a fixed key in environments without the header (local dev)
 * rather than throwing — a shared rate-limit bucket locally is harmless. */
export function clientIpFromHeaders(headers: HeaderReader): string {
  const forwardedFor = headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}
