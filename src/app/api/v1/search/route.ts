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
import { clientIpFromHeaders } from "../../../../application/client-ip";
import { getDb } from "../../../../infrastructure/db/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const result = await handleSearchRequest(
    getDb(),
    request.nextUrl.searchParams,
    clientIpFromHeaders(request.headers),
    new Date(),
  );
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
