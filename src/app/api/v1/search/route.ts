/**
 * `21_DETAILED_DESIGN.md` §21.1 — `GET /api/v1/search`, UC-01's primary endpoint. Thin HTTP
 * wrapper: wires the real `getDb()` pool and the real `NextRequest` into
 * `handleSearchRequest` (`src/application/handle-search-request.ts`), which holds all the actual
 * request-handling logic. Kept thin so tests can call `handleSearchRequest` directly with an
 * injected, rolled-back transaction instead of a real DB pool — the same "thin route/worker
 * entrypoint, testable core" split already used for `runWorkerJob` (`src/worker/jobs.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { handleSearchRequest } from "../../../../application/handle-search-request";
import { getDb } from "../../../../infrastructure/db/client";

export const dynamic = "force-dynamic";

function clientIp(request: NextRequest): string {
  // NextRequest has no built-in .ip in this version — Railway sits its own proxy in front of
  // the app, which sets x-forwarded-for the standard way; the first entry is the original
  // client. Falls back to a fixed key in environments without the header (local dev) rather
  // than throwing — a shared rate-limit bucket locally is harmless.
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}

export async function GET(request: NextRequest) {
  const result = await handleSearchRequest(
    getDb(),
    request.nextUrl.searchParams,
    clientIp(request),
    new Date(),
  );
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
