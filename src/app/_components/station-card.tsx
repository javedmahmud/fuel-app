/**
 * Presentational only — every value is already computed by the server (price, distance,
 * effective cost, freshness band, relative time). `21_DETAILED_DESIGN.md` §21.9's UI
 * principles: "Timestamp visible everywhere a price appears" and "Explain why, from reason
 * codes, never free text."
 *
 * Each card links to `/stations/{id}` (`feature/station-details-screen`) — that screen, not this
 * one, owns the real "Directions" hand-off (§21.9 assigns it there specifically, using the
 * station's own precise `location`, which `/search`'s response doesn't carry). This card
 * previously linked "Directions" straight to a Google Maps *name* search as a stopgap before
 * that screen existed; removed now that a precise, in-app destination exists to send people to
 * instead.
 */
import Link from "next/link";

import type { PriceAgeBand } from "../../domain/calculation/freshness";
import { reasonCodeBadges } from "../_lib/reason-code-labels";
import styles from "./station-card.module.css";

export interface StationCardData {
  rank: number;
  stationId: string;
  name: string | null;
  brand: string | null;
  distanceKm: number;
  centsPerLitre: number;
  fuelCost: number;
  driveCost: number;
  effectiveCost: number;
  estimatedSaving: number | null;
  reasonCodes: string[];
  explanation: string | null;
  isRecommended: boolean;
  freshnessBand: PriceAgeBand;
  relativeTime: string;
  source: string;
  /** The full `/search?...` URL this card was rendered on, so Station Details' back link can
   * return here instead of a blank Home screen. */
  returnTo: string;
}

const FRESHNESS_LABEL: Record<PriceAgeBand, string> = {
  current: "Price confirmed",
  ageing: "Price steady",
  long_unchanged: "Confirm at the pump",
};

export function StationCard(data: StationCardData) {
  const displayName = data.name ?? data.brand ?? "Unnamed station";
  const badges = reasonCodeBadges(data.reasonCodes);

  return (
    <li className={`${styles.row} ${data.isRecommended ? styles.pick : ""}`}>
      <div className={styles.rank}>{data.rank}</div>
      <Link
        href={`/stations/${data.stationId}?from=${encodeURIComponent(data.returnTo)}`}
        className={styles.id}
      >
        <div className={styles.name}>{displayName}</div>
        {data.brand && <div className={styles.brand}>{data.brand}</div>}
        <div className={styles.meta}>
          <span>📍 {data.distanceKm.toFixed(1)} km</span>
          <span className={data.freshnessBand === "long_unchanged" ? styles.staleMeta : undefined}>
            {data.freshnessBand === "long_unchanged" ? "⚠ " : "🕓 "}
            {FRESHNESS_LABEL[data.freshnessBand]} {data.relativeTime}
          </span>
        </div>
        {data.isRecommended && data.explanation && (
          <p className={styles.explanation}>{data.explanation}</p>
        )}
        {badges.length > 0 && (
          <div className={styles.tags}>
            {badges.map((label) => (
              <span key={label} className={data.isRecommended ? styles.tag : styles.tagNeutral}>
                {label}
              </span>
            ))}
          </div>
        )}
        <div className={styles.directions}>Station details →</div>
      </Link>
      <div className={styles.priceBlock}>
        <div className={styles.cpl}>
          {data.centsPerLitre.toFixed(1)}
          <sup>¢/L</sup>
        </div>
        <div className={styles.eff}>
          total <b>${data.effectiveCost.toFixed(2)}</b>
        </div>
        <div className={styles.costBreakdown}>
          fuel ${data.fuelCost.toFixed(2)} + drive ${data.driveCost.toFixed(2)}
        </div>
        {data.isRecommended && data.estimatedSaving !== null && data.estimatedSaving > 0 && (
          <div className={styles.saving}>saves ${data.estimatedSaving.toFixed(2)}</div>
        )}
      </div>
    </li>
  );
}
