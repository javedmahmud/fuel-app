/**
 * `21_DETAILED_DESIGN.md` §21.1 — `GET /api/v1/stations/{stationId}`, UC-05. Thin HTTP wrapper,
 * same split as `search/route.ts`: all the real logic lives in
 * `handle-station-detail-request.ts`, which a test can call directly with an injected,
 * rolled-back transaction.
 */
import { NextResponse, type NextRequest } from "next/server";

import { handleStationDetailRequest } from "../../../../../application/handle-station-detail-request";
import { getDb } from "../../../../../infrastructure/db/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/stations/[stationId]">) {
  const { stationId } = await ctx.params;
  const result = await handleStationDetailRequest(
    getDb(),
    stationId,
    request.nextUrl.searchParams,
    new Date(),
  );
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
