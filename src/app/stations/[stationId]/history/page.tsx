/**
 * Price History — `21_DETAILED_DESIGN.md` §21.9's screen inventory, UC-06. "Trend chart,
 * current/min/max/average over the selected window. Always captioned 'based on price changes we
 * observed' (or the `coverageNote` text when a gap exists) — never implies a complete change
 * log." Server Component calling `handleStationHistoryRequest` directly, same pattern as the
 * other screens in this app.
 *
 * No charting library — one hand-rolled inline SVG line, the same "no new dependency for one
 * small feature" call the original prototype's own trend chart already made (`spike`/mockup
 * precedent), consistent with this codebase's zero-UI-dependency footprint so far.
 */
import Link from "next/link";

import { handleStationHistoryRequest } from "../../../../application/handle-station-history-request";
import { getDb } from "../../../../infrastructure/db/client";
import { TrendChart } from "../../../_components/trend-chart";
import styles from "./history.module.css";

export const dynamic = "force-dynamic";

interface HistoryBody {
  stationId: string;
  fuelType: string;
  requestedDays: number;
  historyDays: number;
  current: { centsPerLitre: number; lastUpdated: string } | null;
  stats: {
    minCentsPerLitre: number | null;
    maxCentsPerLitre: number | null;
    averageCentsPerLitre: number | null;
    percentile: number | null;
  };
  trend: { direction: "rising" | "falling" | "flat"; slopeCentsPerLitrePerDay: number };
  series: Array<{
    date: string;
    averageCentsPerLitre: number | null;
    closeCentsPerLitre: number | null;
    partialDay: boolean;
  }>;
  coverageNote: string | null;
}

const TREND_LABEL: Record<HistoryBody["trend"]["direction"], string> = {
  rising: "↗ Rising",
  falling: "↘ Falling",
  flat: "→ Flat",
};

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

export default async function StationHistoryPage(
  props: PageProps<"/stations/[stationId]/history">,
) {
  const { stationId } = await props.params;
  const searchParams = toSearchParams(await props.searchParams);
  const now = new Date();

  const result = await handleStationHistoryRequest(getDb(), stationId, searchParams, now);

  const backHref = `/stations/${stationId}`;

  return (
    <div className={styles.app}>
      <header className={styles.masthead}>
        <Link href={backHref} className={styles.backLink}>
          ← Station
        </Link>
        <p className={styles.wordmark}>
          Fuel <em>Intelligence</em>
        </p>
      </header>

      <main className={styles.main}>
        {result.status === 404 &&
          (result.body as { error?: string }).error === "insufficient_history" && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>📈</div>
              <p className={styles.emptyTitle}>Building this station&apos;s history</p>
              <p className={styles.emptyBody}>
                {(result.body as { historyDays: number }).historyDays} of{" "}
                {(result.body as { minimumRequired: number }).minimumRequired} days collected so
                far. A trend needs enough days to mean something — check back soon rather than trust
                a short guess.
              </p>
              <Link href={backHref} className={styles.bannerLink}>
                ← Back to station
              </Link>
            </div>
          )}

        {result.status === 404 &&
          (result.body as { error?: string }).error === "station_not_found" && (
            <div className={styles.banner} role="alert">
              <p className={styles.bannerTitle}>Station not found</p>
              <Link href="/" className={styles.bannerLink}>
                ← Back to search
              </Link>
            </div>
          )}

        {result.status === 400 && (
          <div className={styles.banner} role="alert">
            <p className={styles.bannerTitle}>Couldn&apos;t load price history</p>
            <p className={styles.bannerBody}>
              {(result.body as { message?: string }).message ?? "Check the link and try again."}
            </p>
            <Link href={backHref} className={styles.bannerLink}>
              ← Back to station
            </Link>
          </div>
        )}

        {result.status === 200 && <HistoryView body={result.body as HistoryBody} />}
      </main>
    </div>
  );
}

function HistoryView({ body }: { body: HistoryBody }) {
  const { stats } = body;
  return (
    <>
      <p className={styles.subhead}>
        {body.fuelType} · last {body.requestedDays} days
      </p>

      <div className={styles.statGrid}>
        <StatTile
          label="Current"
          value={body.current ? body.current.centsPerLitre.toFixed(1) : "—"}
        />
        <StatTile label="Min" value={stats.minCentsPerLitre?.toFixed(1) ?? "—"} dim />
        <StatTile label="Max" value={stats.maxCentsPerLitre?.toFixed(1) ?? "—"} dim />
        <StatTile label="Avg" value={stats.averageCentsPerLitre?.toFixed(1) ?? "—"} dim />
      </div>

      <div className={styles.chartWrap}>
        <TrendChart series={body.series} />
      </div>

      <p className={styles.trendLine}>
        {TREND_LABEL[body.trend.direction]}
        {stats.percentile !== null &&
          ` · cheaper than ${Math.round((1 - stats.percentile) * 100)}% of the last ${body.historyDays} days`}
      </p>

      <p className={styles.footnote}>
        <b>Reading this:</b> based on price changes we observed, not a complete change log — a price
        that changed and reverted between polls wouldn&apos;t appear.
        {body.coverageNote && (
          <>
            {" "}
            <span className={styles.coverageNote}>{body.coverageNote}</span>
          </>
        )}
      </p>
    </>
  );
}

function StatTile({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className={styles.statTile}>
      <div className={styles.statLabel}>{label}</div>
      <div className={dim ? styles.statValueDim : styles.statValue}>{value}</div>
    </div>
  );
}
