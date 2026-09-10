/**
 * `21_DETAILED_DESIGN.md` §21.1 — `GET /api/v1/stations/{stationId}/history`, UC-06. Thin HTTP
 * wrapper — see `handle-station-history-request.ts` for the actual logic and `search/route.ts`
 * for why this split exists.
 */
import { NextResponse, type NextRequest } from "next/server";

import { handleStationHistoryRequest } from "../../../../../../application/handle-station-history-request";
import { getDb } from "../../../../../../infrastructure/db/client";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/v1/stations/[stationId]/history">,
) {
  const { stationId } = await ctx.params;
  const result = await handleStationHistoryRequest(
    getDb(),
    stationId,
    request.nextUrl.searchParams,
    new Date(),
  );
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
