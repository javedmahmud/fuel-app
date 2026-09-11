/**
 * `21_DETAILED_DESIGN.md` §21.1 — `POST /api/v1/commute`, UC-02's narrow route experiment
 * (`20_SPRINT_PLAN.md` §20.8, ADR-011). Thin HTTP wrapper, same "thin route/testable core" split
 * as `/api/v1/search/route.ts`: wires the real `getDb()` pool and the real `NextRequest` into
 * `handleCommuteRequest`, which holds all the actual request-handling logic.
 *
 * The one thing this wrapper does beyond wiring — parsing the request body as JSON — is still
 * squarely "getting real input out of a real `NextRequest`," the same category of work
 * `/search/route.ts` does by reading `request.nextUrl.searchParams`, not business logic that
 * belongs in the testable core: `handleCommuteRequest` takes an already-parsed `unknown` so a
 * test can hand it a plain object directly, without ever constructing a `Request`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { clientIpFromHeaders } from "../../../../application/client-ip";
import { handleCommuteRequest } from "../../../../application/handle-commute-request";
import { getDb } from "../../../../infrastructure/db/client";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const result = await handleCommuteRequest(
    getDb(),
    rawBody,
    clientIpFromHeaders(request.headers),
    new Date(),
  );
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
