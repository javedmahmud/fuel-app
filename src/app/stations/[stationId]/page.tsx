/**
 * Station Details — `21_DETAILED_DESIGN.md` §21.9's screen inventory, UC-05. "Current prices per
 * fuel type, freshness band, 'Directions' hands off to the device's native maps app — no
 * embedded map" (`05` §5.2). Server Component that calls `handleStationDetailRequest` directly —
 * same pattern as `search/page.tsx`, no self-HTTP-fetch.
 *
 * **"Directions" moved here from the Results screen's recommended card**, now that this screen
 * (and the station's own precise `location`) exists — Results previously linked to a Google Maps
 * *search by name* as a stopgap, documented in that branch's own commit as "revisit once
 * feature/station-details-screen ships." A `destination=lat,lng` deep link is strictly more
 * precise than a name search, so this is that revisit.
 */
import Link from "next/link";

import { handleStationDetailRequest } from "../../../application/handle-station-detail-request";
import type { PriceAgeBand } from "../../../domain/calculation/freshness";
import { getDb } from "../../../infrastructure/db/client";
import { formatRelativeTime } from "../../_lib/format-relative-time";
import { resolveBackHref } from "../../_lib/resolve-back-href";
import styles from "./station-details.module.css";

export const dynamic = "force-dynamic";

interface StationDetailBody {
  stationId: string;
  name: string;
  brand: string | null;
  address: {
    line: string | null;
    suburb: string | null;
    postcode: string | null;
    state: string | null;
  };
  location: { latitude: number; longitude: number };
  distanceKm: number | null;
  prices: Array<{
    fuelType: string;
    fuelTypeDisplayName: string;
    price: { centsPerLitre: number; lastUpdated: string };
    freshnessBand: PriceAgeBand;
    source: string;
    sourceObservedAt: string;
  }>;
}

const FRESHNESS_LABEL: Record<PriceAgeBand, string> = {
  current: "Price set",
  ageing: "Price unchanged",
  long_unchanged: "Hasn't changed",
};

function directionsUrl(location: { latitude: number; longitude: number }): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${location.latitude},${location.longitude}`;
}

function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
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

export default async function StationDetailsPage(props: PageProps<"/stations/[stationId]">) {
  const { stationId } = await props.params;
  const searchParams = toSearchParams(await props.searchParams);
  const now = new Date();
  // Set by each station card's link on the Results screen (`feature/results-ux-feedback`) — the
  // exact `/search?...` URL the driver came from, so "back" returns to those results (same
  // query, same sort) instead of a blank Home screen.
  const backHref = resolveBackHref(searchParams.get("from") ?? undefined);

  const result = await handleStationDetailRequest(getDb(), stationId, searchParams, now);

  return (
    <div className={styles.app}>
      <header className={styles.masthead}>
        <Link href={backHref} className={styles.backLink}>
          ← Search
        </Link>
        <p className={styles.wordmark}>
          Fuel <em>Intelligence</em>
        </p>
      </header>

      <main className={styles.main}>
        {result.status === 404 && (
          <div className={styles.banner} role="alert">
            <p className={styles.bannerTitle}>Station not found</p>
            <p className={styles.bannerBody}>
              This station may have been removed or the link is out of date.
            </p>
            <Link href={backHref} className={styles.bannerLink}>
              ← Back to search
            </Link>
          </div>
        )}

        {result.status === 400 && (
          <div className={styles.banner} role="alert">
            <p className={styles.bannerTitle}>Couldn&apos;t load this station</p>
            <p className={styles.bannerBody}>
              {(result.body as { message?: string }).message ?? "Check the link and try again."}
            </p>
          </div>
        )}

        {result.status === 200 && (
          <StationDetail body={result.body as StationDetailBody} now={now} />
        )}
      </main>
    </div>
  );
}

function StationDetail({ body, now }: { body: StationDetailBody; now: Date }) {
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.name}>{body.name}</div>
        {body.brand && <div className={styles.brand}>{body.brand}</div>}
        {body.address.line && <div className={styles.address}>{body.address.line}</div>}
        {body.distanceKm !== null && (
          <div className={styles.distance}>📍 {body.distanceKm.toFixed(1)} km away</div>
        )}
      </div>

      <a
        className={styles.directionsButton}
        href={directionsUrl(body.location)}
        target="_blank"
        rel="noopener noreferrer"
      >
        Directions →
      </a>

      {body.prices.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No current prices</p>
          <p className={styles.emptyBody}>
            This station hasn&apos;t reported a price for any fuel type recently.
          </p>
        </div>
      ) : (
        <ul className={styles.priceList}>
          {body.prices.map((p) => (
            <li key={p.fuelType} className={styles.priceRow}>
              <Link
                href={`/stations/${body.stationId}/history?fuelType=${encodeURIComponent(p.fuelType)}`}
                className={styles.priceLink}
              >
                <div className={styles.priceLeft}>
                  <div className={styles.fuelName}>{p.fuelTypeDisplayName}</div>
                  <div
                    className={
                      p.freshnessBand === "long_unchanged" ? styles.staleMeta : styles.meta
                    }
                  >
                    {p.freshnessBand === "long_unchanged" ? "⚠ " : "🕓 "}
                    {FRESHNESS_LABEL[p.freshnessBand]}{" "}
                    {formatRelativeTime(new Date(p.sourceObservedAt), now)}
                  </div>
                </div>
                <div className={styles.priceRight}>
                  <div className={styles.cpl}>
                    {p.price.centsPerLitre.toFixed(1)}
                    <sup>¢/L</sup>
                  </div>
                  <div className={styles.historyLink}>History →</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className={styles.footnote}>
        Source: {body.prices[0]?.source ?? "NSW Fuel API"}. Prices are exactly what the provider
        reported, dated honestly — never estimated.
      </p>
    </>
  );
}
