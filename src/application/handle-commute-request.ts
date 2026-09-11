/**
 * `src/application/README.md`: "Use-case services — orchestration only... calls down into the
 * domain layer for calculations and into infrastructure for data." The testable core of
 * `POST /api/v1/commute` (`21_DETAILED_DESIGN.md` §21.1, UC-02, `20_SPRINT_PLAN.md` §20.8) —
 * request validation, rate limiting, and response mapping. Same "thin route, testable core" split
 * as `handle-search-request.ts`, and deliberately built as a close mirror of it: the two
 * endpoints share almost every concern (validation shape, rate limiting, response mapping,
 * never-drop-the-recommendation capping) and differ only in what `commute-service.ts`'s
 * `runCommute` needs that `search-service.ts`'s `runSearch` doesn't (a destination).
 *
 * **Body, not query params** — `POST`, per §21.1: "the payload... doesn't fit cleanly in query
 * params and isn't cacheable the way `/search` is." `route.ts` reads and JSON-parses the real
 * request body (the one piece of "getting real input out of a real `NextRequest`" that belongs in
 * the thin wrapper, same category as `/search`'s route reading `request.nextUrl.searchParams`)
 * and hands this function an already-parsed `unknown` — everything past that point, including
 * malformed-shape validation, is this function's job and is directly testable without an HTTP
 * layer at all.
 *
 * **Response shape**: deliberately the *same* per-entry shape `/search` returns (`results`,
 * `reasonCodes`/`confidence`/`explanation` on the recommended entry only, the same reasoning
 * `handle-search-request.ts`'s own module comment gives for why). What's deliberately different:
 * no `limit`/`sort`/`totalEligible` — UC-01's `fix/results-limit-and-back-label` branch added
 * those in response to real feedback that a wide-radius nearby search returns *too many* results;
 * a narrow corridor search (ADR-011's own "narrow experiment" framing) has no equivalent problem
 * to solve yet, and building that speculatively here would be exactly the kind of scope creep
 * ADR-011 explicitly warns this feature is prone to. `results` is still capped at `MAX_RESULTS`
 * (§13.9's "Result cap" concept, extended here) with the recommended entry never dropped by that
 * cap — the same safety property `/search` has, for the same reason.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { runCommute, type CommuteOutcome } from "./commute-service";
import type { HandlerResult } from "./http-handler-result";
import { explainRecommendation } from "../domain/explanation/template-explainer";
import { isWithinNswTasBounds } from "../domain/geo/nsw-tas-bounds";
import { checkRateLimit } from "../infrastructure/rate-limit/check-rate-limit";
import { loadStationDisplayInfo } from "../infrastructure/repositories/station-search-repository";

export type { HandlerResult } from "./http-handler-result";

type Db = Pick<PostgresJsDatabase, "select" | "selectDistinctOn" | "insert">;

// §13.9 lists rate limits for search/history/alerts but was written before this endpoint
// existed — no explicit row for commute. Reusing search's own 60/min/IP figure rather than
// inventing an unreviewed number: same "anti-scrape" rationale, same public, unauthenticated
// surface, and — same shape of query — the more expensive of the two per request, so if
// anything erring toward the existing number is the conservative choice.
const RATE_LIMIT_MAX_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_SECONDS = 60;
// Same value/reasoning as §13.9's "Radius cap | 50km | Unbounded radius = full table scan" —
// extended to `maxDetourKm` here since it plays the identical role for the corridor prefilter's
// bounding box (`commute-service.ts`'s own comment on why the DB width equals maxDetourKm).
const MAX_DETOUR_KM = 50;
const MAX_RESULTS = 50; // §13.9's "Result cap" — the hard ceiling, same figure as /search's

const latLngSchema = z.object({ lat: z.number(), lng: z.number() });

const commuteBodySchema = z.object({
  origin: latLngSchema,
  destination: latLngSchema,
  fuelType: z.string().trim().min(1),
  // Required, not defaulted — UC-02's own product definition (`02_USE_CASES.md`): "User enters
  // origin, destination, fuel type and max detour." Unlike /search's radiusKm, there's no
  // sensible universal default for "how big a detour off my route am I willing to take."
  maxDetourKm: z.number().positive().max(MAX_DETOUR_KM),
  vehicle: z
    .object({
      tankCapacityL: z.number().positive().optional(),
      currentFuelFraction: z.number().min(0).max(1).optional(),
    })
    .optional(),
  consumptionL100km: z.number().positive().optional(),
});

function errorResult(status: number, message: string): HandlerResult {
  return { status, body: { error: message } };
}

export async function handleCommuteRequest(
  db: Db,
  rawBody: unknown,
  clientIp: string,
  now: Date,
): Promise<HandlerResult> {
  const rateLimit = await checkRateLimit(
    db,
    `commute:${clientIp}`,
    RATE_LIMIT_MAX_PER_MINUTE,
    RATE_LIMIT_WINDOW_SECONDS,
    now,
  );
  if (!rateLimit.allowed) {
    return {
      status: 429,
      body: { error: "Too many requests." },
      headers: { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) },
    };
  }

  const parsed = commuteBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResult(400, parsed.error.issues.map((i) => i.message).join("; "));
  }
  const body = parsed.data;

  const origin = { latitude: body.origin.lat, longitude: body.origin.lng };
  const destination = { latitude: body.destination.lat, longitude: body.destination.lng };
  if (!isWithinNswTasBounds(origin)) {
    return errorResult(400, "origin lat/lng must be within the NSW/TAS bounding box.");
  }
  if (!isWithinNswTasBounds(destination)) {
    return errorResult(400, "destination lat/lng must be within the NSW/TAS bounding box.");
  }

  const hasVehicleProfile =
    body.vehicle?.tankCapacityL !== undefined || body.vehicle?.currentFuelFraction !== undefined;

  const outcome = await runCommute(db, {
    origin,
    destination,
    maxDetourKm: body.maxDetourKm,
    fuelTypeCode: body.fuelType,
    vehicleProfile: hasVehicleProfile
      ? {
          tankCapacityLitres: body.vehicle?.tankCapacityL ?? null,
          currentFuelFraction: body.vehicle?.currentFuelFraction ?? null,
          consumptionLPer100km: body.consumptionL100km ?? null,
        }
      : null,
    now,
  });

  if (!outcome.ok) {
    if (outcome.error.type === "unknown_fuel_type") {
      return errorResult(400, `Unknown fuel type "${body.fuelType}".`);
    }
    // no_eligible_candidates is not an error, matching /search's own §21.1 reasoning — an
    // honestly labelled empty 200, never a 4xx/5xx.
    return {
      status: 200,
      body: { results: [], engineVersion: null, generatedAt: now.toISOString() },
    };
  }

  const responseBody = await buildResponseBody(db, outcome.value, now);
  return { status: 200, body: responseBody };
}

async function buildResponseBody(db: Db, outcome: CommuteOutcome, now: Date) {
  const { result } = outcome;
  const displayInfo = await loadStationDisplayInfo(
    db,
    result.ranked.map((r) => r.stationId),
  );

  const explanation = explainRecommendation(result);

  const results = result.ranked.map((candidate) => {
    const isRecommended = candidate.stationId === result.recommended.stationId;
    const info = displayInfo.get(candidate.stationId);
    return {
      stationId: candidate.stationId,
      name: info?.name ?? null,
      brand: candidate.brand,
      distanceKm: candidate.metrics.distanceKm,
      price: {
        centsPerLitre: candidate.metrics.priceTenthsCpl / 10,
        lastUpdated: candidate.metrics.sourceReportedAt.toISOString(),
      },
      mode: result.mode,
      metrics: {
        fuelCost: candidate.metrics.fillCostCents / 100,
        driveCost: candidate.metrics.extraFuelCostCents / 100,
        effectiveCost: candidate.metrics.effectiveCostCents / 100,
        estimatedSaving: isRecommended ? result.estimatedSavingCents / 100 : null,
      },
      reasonCodes: isRecommended ? result.reasonCodes : [],
      confidence: isRecommended ? result.confidence : null,
      explanation: isRecommended ? explanation : null,
      source: "NSW Fuel API",
      sourceObservedAt: candidate.metrics.sourceReportedAt.toISOString(),
    };
  });

  // Sorted by effective cost only — /search's sort=distance|price param exists because a wide
  // nearby-search radius makes "closest" or "cheapest per litre" meaningful alternate views; a
  // narrow corridor doesn't have that same ambiguity yet (no real user feedback has asked for
  // it), so this stays unsorted-by-anything-but-effectiveCost until evidence says otherwise —
  // same deliberate-scope-discipline reasoning as the missing limit/totalEligible fields above.
  results.sort((a, b) => a.metrics.effectiveCost - b.metrics.effectiveCost);

  // Same "never drop the recommended entry" safety property /search's response has, and for the
  // same reason — it's the only entry carrying reasonCodes/confidence/estimatedSaving/
  // explanation, so silently losing it to a cap would mean the response has no recommendation at
  // all, not just a shorter list.
  let capped = results.slice(0, MAX_RESULTS);
  if (
    results.length > MAX_RESULTS &&
    !capped.some((r) => r.stationId === result.recommended.stationId)
  ) {
    const recommendedEntry = results.find((r) => r.stationId === result.recommended.stationId);
    if (recommendedEntry) {
      capped = [...capped.slice(0, MAX_RESULTS - 1), recommendedEntry].sort(
        (a, b) => a.metrics.effectiveCost - b.metrics.effectiveCost,
      );
    }
  }

  return {
    results: capped,
    engineVersion: result.engineVersion,
    generatedAt: now.toISOString(),
  };
}
