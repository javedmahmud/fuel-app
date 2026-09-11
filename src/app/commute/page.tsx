/**
 * Commute Mode — `21_DETAILED_DESIGN.md` §21.9's screen inventory, UC-02, the third and final
 * Sprint 5 branch (`20_SPRINT_PLAN.md` §20.8, ADR-011). **One combined form-and-results route**,
 * not a Home/Results pair like UC-01 — §21.9 lists Commute Mode as a single screen row, and
 * `internal/search/page.tsx` already established the "form re-renders pre-filled, results appear
 * below once submitted" pattern this reuses for real. Server Component that calls
 * `handleCommuteRequest` directly — the same core function `POST /api/v1/commute`'s `route.ts`
 * also calls, no self-HTTP-fetch — matching the "Server Components do backend work directly"
 * pattern every other screen in this codebase uses.
 */
import { headers } from "next/headers";
import Link from "next/link";

import { clientIpFromHeaders } from "../../application/client-ip";
import { handleCommuteRequest } from "../../application/handle-commute-request";
import { priceAgeBand } from "../../domain/calculation/freshness";
import { getDb } from "../../infrastructure/db/client";
import { loadActiveFuelTypes } from "../../infrastructure/repositories/fuel-type-repository";
import { CommuteForm } from "../_components/commute-form";
import { formatRelativeTime } from "../_lib/format-relative-time";
import { StationCard, type StationCardData } from "../_components/station-card";
import styles from "./commute.module.css";

export const dynamic = "force-dynamic";

interface CommuteResultEntry {
  stationId: string;
  name: string | null;
  brand: string | null;
  distanceKm: number;
  price: { centsPerLitre: number; lastUpdated: string };
  metrics: {
    fuelCost: number;
    driveCost: number;
    effectiveCost: number;
    estimatedSaving: number | null;
  };
  reasonCodes: string[];
  confidence: string | null;
  explanation: string | null;
  source: string;
  sourceObservedAt: string;
}

interface CommuteSuccessBody {
  results: CommuteResultEntry[];
  engineVersion: string | null;
  generatedAt: string;
}

function toSearchParams(raw: Awaited<PageProps<"/commute">["searchParams"]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else {
      params.set(key, value);
    }
  }
  return params;
}

/** Builds `handleCommuteRequest`'s JSON-body shape from this GET route's query params — the same
 * "page converts its own query-string UI state into the real request shape" step `internal/search
 * /page.tsx` already does, just for a POST body instead of `runSearch`'s plain arguments. */
function buildCommuteBody(searchParams: URLSearchParams): unknown {
  const originLat = searchParams.get("originLat");
  const originLng = searchParams.get("originLng");
  const originLocality = searchParams.get("originLocality");
  const destLocality = searchParams.get("destLocality");
  const fuelType = searchParams.get("fuelType");
  const maxDetourKm = searchParams.get("maxDetourKm");
  const tankCapacityL = searchParams.get("vehicle.tankCapacityL");
  const currentFuelFraction = searchParams.get("vehicle.currentFuelFraction");
  const consumptionL100km = searchParams.get("consumptionL100km");

  const hasVehicle = tankCapacityL !== null || currentFuelFraction !== null;

  return {
    origin:
      originLat !== null && originLng !== null
        ? { lat: Number(originLat), lng: Number(originLng) }
        : { locality: originLocality ?? "" },
    destination: { locality: destLocality ?? "" },
    fuelType: fuelType ?? "",
    maxDetourKm: maxDetourKm !== null ? Number(maxDetourKm) : undefined,
    vehicle: hasVehicle
      ? {
          tankCapacityL: tankCapacityL !== null ? Number(tankCapacityL) : undefined,
          currentFuelFraction:
            currentFuelFraction !== null ? Number(currentFuelFraction) : undefined,
        }
      : undefined,
    consumptionL100km: consumptionL100km !== null ? Number(consumptionL100km) : undefined,
  };
}

export default async function CommutePage(props: PageProps<"/commute">) {
  const searchParams = toSearchParams(await props.searchParams);
  const now = new Date();

  const fuelTypes = [...(await loadActiveFuelTypes(getDb())).values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  // Same "presence of the required fields decides whether to actually run the request" logic
  // /search's page would need too, if it weren't split into a separate Home/Results pair — a
  // blank first visit shows the form only, never an error for fields nobody's filled in yet.
  const hasOrigin = searchParams.has("originLocality") || searchParams.has("originLat");
  const hasSubmission =
    hasOrigin &&
    searchParams.has("destLocality") &&
    searchParams.has("fuelType") &&
    searchParams.has("maxDetourKm");

  let result: Awaited<ReturnType<typeof handleCommuteRequest>> | undefined;
  if (hasSubmission) {
    const requestHeaders = await headers();
    result = await handleCommuteRequest(
      getDb(),
      buildCommuteBody(searchParams),
      clientIpFromHeaders(requestHeaders),
      now,
    );
  }

  return (
    <div className={styles.app}>
      <header className={styles.masthead}>
        <Link href="/" className={styles.backLink}>
          ← Home
        </Link>
        <p className={styles.wordmark}>
          Fuel <em>Intelligence</em>
        </p>
        <p className={styles.tagline}>Commute Mode — the best station along your actual trip.</p>
      </header>

      <main className={styles.main}>
        <CommuteForm
          fuelTypes={fuelTypes}
          initial={{
            originLocality: searchParams.get("originLocality") ?? "",
            destLocality: searchParams.get("destLocality") ?? "",
            fuelType: searchParams.get("fuelType") ?? "",
            maxDetourKm: searchParams.has("maxDetourKm")
              ? Number(searchParams.get("maxDetourKm"))
              : undefined,
          }}
        />

        {result && <CommuteResults result={result} now={now} searchParams={searchParams} />}
      </main>
    </div>
  );
}

function CommuteResults({
  result,
  now,
  searchParams,
}: {
  result: Awaited<ReturnType<typeof handleCommuteRequest>>;
  now: Date;
  searchParams: URLSearchParams;
}) {
  if (result.status === 429) {
    return (
      <div className={styles.banner} role="alert">
        <p className={styles.bannerTitle}>Too many requests</p>
        <p className={styles.bannerBody}>
          Please wait a moment and try again.
          {result.headers?.["Retry-After"] && ` (about ${result.headers["Retry-After"]}s)`}
        </p>
      </div>
    );
  }

  if (result.status === 400) {
    return (
      <div className={styles.banner} role="alert">
        <p className={styles.bannerTitle}>Couldn&apos;t plan that route</p>
        <p className={styles.bannerBody}>
          {(result.body as { error?: string }).error ?? "Check your details and try again."}
        </p>
      </div>
    );
  }

  const body = result.body as CommuteSuccessBody;
  const fuelType = searchParams.get("fuelType") ?? "";
  const maxDetourKm = searchParams.get("maxDetourKm") ?? "";
  // Carried through to each station card's link so Station Details can send the driver back to
  // these exact results — the same `from` pattern the Results screen established
  // (`fix/results-ux-feedback`), just for `/commute?...` instead of `/search?...`.
  const returnTo = `/commute?${searchParams.toString()}`;

  if (body.results.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>⛽</div>
        <p className={styles.emptyTitle}>Nothing found within {maxDetourKm} km of your route</p>
        <p className={styles.emptyBody}>
          No station near this route has a recent price for this fuel type. Try a larger detour or a
          different fuel type.
        </p>
      </div>
    );
  }

  const cards: StationCardData[] = body.results.map((r, index) => ({
    rank: index + 1,
    stationId: r.stationId,
    name: r.name,
    brand: r.brand,
    distanceKm: r.distanceKm,
    centsPerLitre: r.price.centsPerLitre,
    fuelCost: r.metrics.fuelCost,
    driveCost: r.metrics.driveCost,
    effectiveCost: r.metrics.effectiveCost,
    estimatedSaving: r.metrics.estimatedSaving,
    reasonCodes: r.reasonCodes,
    explanation: r.explanation,
    isRecommended: r.explanation !== null,
    freshnessBand: priceAgeBand(new Date(r.sourceObservedAt), now),
    relativeTime: formatRelativeTime(new Date(r.sourceObservedAt), now),
    source: r.source,
    returnTo,
  }));

  return (
    <>
      <p className={styles.resultsSummary}>
        {fuelType || "Fuel"} · within {maxDetourKm} km detour · {body.results.length} station
        {body.results.length === 1 ? "" : "s"} found
      </p>
      <ul className={styles.list}>
        {cards.map((card) => (
          <StationCard key={card.stationId} {...card} />
        ))}
      </ul>
      <p className={styles.footnote}>
        Ranked by trip cost (fill + extra distance off your direct route), not pump price alone. The
        detour is a straight-line estimate, not a real route. Source: NSW Fuel API.
      </p>
    </>
  );
}
