/**
 * `src/application/README.md`: "Use-case services — orchestration only... calls down into the
 * domain layer for calculations and into infrastructure for data." The testable core of
 * `GET /api/v1/search` (`21_DETAILED_DESIGN.md` §21.1) — request validation, `locality`/postcode
 * resolution, rate limiting, and response mapping. Returns a plain, framework-agnostic result
 * (status/body/headers) rather than a `NextResponse`, the same "thin route, testable core" split
 * already used for `runWorkerJob` (`src/worker/jobs.ts`) — `route.ts` just wires `getDb()` and a
 * real `NextRequest` into this, and a test can call it directly with an injected `db` (a rolled-
 * back transaction, same pattern as every other integration test in this codebase) instead of
 * needing a real HTTP server.
 *
 * **Response shape decision, since the doc's own example shows only one result and doesn't say
 * whether every entry needs full annotation:** every eligible candidate is returned (the Results
 * screen, §21.9, needs multiple station cards, not just one), but `reasonCodes`/`confidence`/
 * `metrics.estimatedSaving`/`explanation` are populated only on the recommended entry — those
 * fields are inherently comparative (§9.8's `ALREADY_NEAREST_AND_CHEAPEST` etc. only make sense
 * for one chosen station), and `rankCandidates` only computes them for the winner.
 *
 * **`explanation`** is `templateExplainer.explainRecommendation()`'s one-sentence prose
 * (`feature/template-explainer`, `12_AI_ARCHITECTURE.md` §12.5) — matching
 * `15_SEQUENCE_DIAGRAMS.md` §15.1's flow, which calls this inside the search request itself,
 * before the response goes back. Not persisted to `recommendation_log` — that table's own schema
 * comment is explicit that reason codes, not prose, are "the only channel between the
 * calculation engine and the explanation layer... never free text"; the sentence is cheap and
 * deterministic to regenerate from the stored codes, so there's nothing to gain from storing it
 * twice.
 *
 * **No 5xx path depends on an external call** (§21.1) — `no_eligible_candidates` is an honestly
 * labelled empty `200`, never a `4xx`/`5xx`. Only genuine request-shape problems are `400`s.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type { LatLng } from "../domain/calculation/types";
import { explainRecommendation } from "../domain/explanation/template-explainer";
import { isWithinNswTasBounds } from "../domain/geo/nsw-tas-bounds";
import { resolveLocality } from "../domain/locality/locality-resolver";
import { loadNswLocalities } from "../infrastructure/locality/load-nsw-localities";
import { loadNswTasPostcodes } from "../infrastructure/locality/load-nsw-tas-postcodes";
import { checkRateLimit } from "../infrastructure/rate-limit/check-rate-limit";
import { loadStationDisplayInfo } from "../infrastructure/repositories/station-search-repository";
import type { HandlerResult } from "./http-handler-result";
import { runSearch, type SearchOutcome } from "./search-service";

export type { HandlerResult } from "./http-handler-result";

type Db = Pick<PostgresJsDatabase, "select" | "selectDistinctOn" | "insert">;

const RATE_LIMIT_MAX_PER_MINUTE = 60; // §13.9: "Rate limit — search | 60/min/IP"
const RATE_LIMIT_WINDOW_SECONDS = 60;
const MAX_RADIUS_KM = 50; // §13.9: "unbounded radius = full table scan"
const DEFAULT_RADIUS_KM = 5;
const MAX_RESULTS = 50; // §13.9: "Result cap | 50 stations | Bounds response size and compute"

const querySchema = z
  .object({
    lat: z.coerce.number().optional(),
    lng: z.coerce.number().optional(),
    locality: z.string().trim().min(1).optional(),
    fuelType: z.string().trim().min(1),
    radiusKm: z.coerce.number().positive().max(MAX_RADIUS_KM).optional(),
    "vehicle.tankCapacityL": z.coerce.number().positive().optional(),
    "vehicle.currentFuelFraction": z.coerce.number().min(0).max(1).optional(),
    consumptionL100km: z.coerce.number().positive().optional(),
    sort: z.enum(["effectiveCost", "distance", "price"]).optional(),
  })
  .refine(
    (data) => (data.lat !== undefined && data.lng !== undefined) || data.locality !== undefined,
    {
      message: "Either both lat and lng, or locality, must be provided.",
    },
  );

function errorResult(status: number, message: string): HandlerResult {
  return { status, body: { error: message } };
}

/** Tries the `locality` param as a suburb name first, then as a postcode — one input field
 * resolved against both static datasets (`feature/locality-resolver`,
 * `feature/postcode-resolver`), exactly the "combined helper" both of those branches deferred to
 * whichever branch actually consumes them. */
function resolveOrigin(locality: string): LatLng | undefined {
  const bySuburb = resolveLocality(locality, loadNswLocalities());
  if (bySuburb) return { latitude: bySuburb.latitude, longitude: bySuburb.longitude };

  const byPostcode = resolveLocality(locality, loadNswTasPostcodes());
  if (byPostcode) return { latitude: byPostcode.latitude, longitude: byPostcode.longitude };

  return undefined;
}

export async function handleSearchRequest(
  db: Db,
  searchParams: URLSearchParams,
  clientIp: string,
  now: Date,
): Promise<HandlerResult> {
  const rateLimit = await checkRateLimit(
    db,
    `search:${clientIp}`,
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

  const parsed = querySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) {
    return errorResult(400, parsed.error.issues.map((i) => i.message).join("; "));
  }
  const params = parsed.data;

  let origin: LatLng;
  if (params.locality) {
    const resolved = resolveOrigin(params.locality);
    if (!resolved) {
      return errorResult(400, `Could not resolve locality or postcode "${params.locality}".`);
    }
    origin = resolved;
  } else {
    // Schema's .refine already guarantees both are present when locality isn't.
    origin = { latitude: params.lat as number, longitude: params.lng as number };
    if (!isWithinNswTasBounds(origin)) {
      return errorResult(400, "lat/lng must be within the NSW/TAS bounding box.");
    }
  }

  const radiusKm = params.radiusKm ?? DEFAULT_RADIUS_KM;
  const tankCapacityLitres = params["vehicle.tankCapacityL"];
  const currentFuelFraction = params["vehicle.currentFuelFraction"];
  const hasVehicleProfile = tankCapacityLitres !== undefined || currentFuelFraction !== undefined;

  const outcome = await runSearch(db, {
    origin,
    // §21.1's radiusKm is one-way (the conventional meaning of a search radius); rank-candidates
    // .ts's maxDetourKm is round-trip (§9.4.2) — search-service.ts already halves it back down
    // for its own DB prefetch, so the public contract's one-way radius doubles here to match.
    maxDetourKm: radiusKm * 2,
    fuelTypeCode: params.fuelType,
    vehicleProfile: hasVehicleProfile
      ? {
          tankCapacityLitres: tankCapacityLitres ?? null,
          currentFuelFraction: currentFuelFraction ?? null,
          consumptionLPer100km: params.consumptionL100km ?? null,
        }
      : null,
    now,
  });

  if (!outcome.ok) {
    if (outcome.error.type === "unknown_fuel_type") {
      return errorResult(400, `Unknown fuel type "${params.fuelType}".`);
    }
    // no_eligible_candidates is not an error per §21.1 — an honestly-labelled empty 200.
    return {
      status: 200,
      body: { results: [], engineVersion: null, generatedAt: now.toISOString() },
    };
  }

  const body = await buildResponseBody(db, outcome.value, params.sort ?? "effectiveCost", now);
  return { status: 200, body };
}

async function buildResponseBody(
  db: Db,
  outcome: SearchOutcome,
  sort: "effectiveCost" | "distance" | "price",
  now: Date,
) {
  const { result } = outcome;
  const displayInfo = await loadStationDisplayInfo(
    db,
    result.ranked.map((r) => r.stationId),
  );

  // Computed once for the recommended candidate only — explainRecommendation is a pure function
  // of the whole RecommendationResult (it needs reasonCodes/estimatedSavingCents alongside the
  // recommended candidate's own metrics), not something derivable per-candidate in the map below.
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
        // fuelCost + driveCost === effectiveCost, always (cost.ts's own effectiveCostCents is
        // their sum) — split out so the UI can show "why" a trip costs what it does, not just
        // the one combined number. fuelCost is the fill itself (reference 40L in comparison
        // mode, or the vehicle's own required litres in personalised mode); driveCost is the
        // extra fuel burned for the round-trip detour to reach this specific station.
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

  const compare = (a: (typeof results)[number], b: (typeof results)[number]) => {
    if (sort === "distance") return a.distanceKm - b.distanceKm;
    if (sort === "price") return a.price.centsPerLitre - b.price.centsPerLitre;
    return a.metrics.effectiveCost - b.metrics.effectiveCost;
  };
  results.sort(compare);

  // §13.9's "Result cap | 50 stations" — but never at the cost of silently dropping the
  // recommended entry: sorting by distance/price (rather than the default effectiveCost) can
  // put the actual recommendation past position 50 in a dense market, and it's the only entry
  // carrying reasonCodes/confidence/estimatedSaving, so losing it would be a real regression,
  // not just a shorter list.
  let capped = results.slice(0, MAX_RESULTS);
  if (
    results.length > MAX_RESULTS &&
    !capped.some((r) => r.stationId === result.recommended.stationId)
  ) {
    const recommendedEntry = results.find((r) => r.stationId === result.recommended.stationId);
    if (recommendedEntry) {
      capped = [...capped.slice(0, MAX_RESULTS - 1), recommendedEntry].sort(compare);
    }
  }

  return { results: capped, engineVersion: result.engineVersion, generatedAt: now.toISOString() };
}
