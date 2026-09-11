/**
 * Results — `21_DETAILED_DESIGN.md` §21.9's screen inventory, UC-01. **List only, no map**
 * (ADR-010) — station cards with distance, price, cost, and a "Directions" hand-off to the
 * device's native maps app. Server Component that calls `handleSearchRequest` directly, the
 * exact core function `GET /api/v1/search` (`route.ts`) also calls — same response shape, same
 * rate limiting/validation, zero self-HTTP-fetch round trip, matching the "Server Components do
 * backend work directly" pattern `internal/search/page.tsx` already established.
 */
import { headers } from "next/headers";
import Link from "next/link";

import { clientIpFromHeaders } from "../../application/client-ip";
import { handleSearchRequest } from "../../application/handle-search-request";
import { priceAgeBand } from "../../domain/calculation/freshness";
import { getDb } from "../../infrastructure/db/client";
import { formatRelativeTime } from "../_lib/format-relative-time";
import { StationCard, type StationCardData } from "../_components/station-card";
import styles from "./search.module.css";

export const dynamic = "force-dynamic";

interface SearchResultEntry {
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

interface SearchSuccessBody {
  results: SearchResultEntry[];
  engineVersion: string | null;
  generatedAt: string;
}

function toSearchParams(raw: Awaited<PageProps<"/search">["searchParams"]>): URLSearchParams {
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

export default async function SearchResultsPage(props: PageProps<"/search">) {
  const searchParams = toSearchParams(await props.searchParams);
  const now = new Date();
  const requestHeaders = await headers();

  const result = await handleSearchRequest(
    getDb(),
    searchParams,
    clientIpFromHeaders(requestHeaders),
    now,
  );

  return (
    <div className={styles.app}>
      <header className={styles.masthead}>
        <Link href="/" className={styles.backLink}>
          ← New search
        </Link>
        <p className={styles.wordmark}>
          Fuel <em>Intelligence</em>
        </p>
      </header>

      <main className={styles.main}>
        {result.status === 429 && (
          <div className={styles.banner} role="alert">
            <p className={styles.bannerTitle}>Too many searches</p>
            <p className={styles.bannerBody}>
              Please wait a moment and try again.
              {result.headers?.["Retry-After"] && ` (about ${result.headers["Retry-After"]}s)`}
            </p>
          </div>
        )}

        {result.status === 400 && (
          <div className={styles.banner} role="alert">
            <p className={styles.bannerTitle}>Couldn&apos;t run that search</p>
            <p className={styles.bannerBody}>
              {(result.body as { error?: string }).error ?? "Check your search and try again."}
            </p>
            <Link href="/" className={styles.bannerLink}>
              ← Back to search
            </Link>
          </div>
        )}

        {result.status === 200 && (
          <ResultsList
            body={result.body as SearchSuccessBody}
            now={now}
            searchParams={searchParams}
          />
        )}
      </main>
    </div>
  );
}

function ResultsList({
  body,
  now,
  searchParams,
}: {
  body: SearchSuccessBody;
  now: Date;
  searchParams: URLSearchParams;
}) {
  const fuelType = searchParams.get("fuelType") ?? "";
  const radiusKm = searchParams.get("radiusKm") ?? "5";
  // Carried through to each station card's link so Station Details can send the driver back to
  // these exact results (same query, same sort) instead of a blank Home screen — the actual
  // feedback this fixes: "if I select station for details it should take to screen with search
  // results not initial search screen."
  const returnTo = `/search?${searchParams.toString()}`;

  if (body.results.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>⛽</div>
        <p className={styles.emptyTitle}>Nothing found within {radiusKm} km</p>
        <p className={styles.emptyBody}>
          No station within this radius has a recent price for this fuel type. Try a larger radius
          or a different fuel type.
        </p>
        <Link href="/" className={styles.bannerLink}>
          ← Try a wider search
        </Link>
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
        {fuelType || "Fuel"} · within {radiusKm} km · {body.results.length} station
        {body.results.length === 1 ? "" : "s"} found
      </p>
      <ul className={styles.list}>
        {cards.map((card) => (
          <StationCard key={card.stationId} {...card} />
        ))}
      </ul>
      <p className={styles.footnote}>
        Ranked by trip cost (fill + return drive), not pump price alone. Source: NSW Fuel API.
      </p>
    </>
  );
}
