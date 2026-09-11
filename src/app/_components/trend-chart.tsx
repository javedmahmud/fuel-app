/**
 * A minimal inline SVG line — no charting library, matching the original prototype's own
 * hand-rolled trend chart. Presentational only: every point is already-computed
 * `averageCentsPerLitre` from the history API's `series` array. Points with a `null` average
 * (no usable rollup for that day, per that field's own nullability) are simply skipped, not
 * plotted as zero — a gap in the line is more honest than a false dip to $0.00/L.
 * No hooks, no browser APIs — a plain presentational function, so no "use client" needed; it
 * renders fine as part of the server-rendered history page.
 */

interface SeriesPoint {
  date: string;
  averageCentsPerLitre: number | null;
  closeCentsPerLitre: number | null;
  partialDay: boolean;
}

const WIDTH = 400;
const HEIGHT = 150;
const PAD = 18;

export function TrendChart({ series }: { series: SeriesPoint[] }) {
  const points = series
    .map((p, i) => ({ i, value: p.averageCentsPerLitre }))
    .filter((p): p is { i: number; value: number } => p.value !== null);

  if (points.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        role="img"
        aria-label="Not enough data to chart a trend"
      >
        <text x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle" fontSize="12" fill="var(--ink-soft)">
          Not enough data to chart a trend
        </text>
      </svg>
    );
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1; // flat line (all equal) — avoid a divide-by-zero

  const x = (i: number) => PAD + (i / (series.length - 1)) * (WIDTH - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - min) / span) * (HEIGHT - PAD * 2 - 14);

  const linePath = points.map((p) => `${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" L");
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width="100%"
      height={HEIGHT}
      role="img"
      aria-label={`Price trend over ${series.length} days, from ${min.toFixed(1)} to ${max.toFixed(1)} cents per litre`}
    >
      <path
        d={`M${linePath}`}
        fill="none"
        stroke="var(--amber-500)"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={x(last.i)}
        cy={y(last.value)}
        r="4.5"
        fill="var(--amber-500)"
        stroke="var(--ink)"
        strokeWidth="1.5"
      />
      <text x={PAD} y={HEIGHT - 4} fontSize="9" fill="var(--ink-soft)">
        {series[0]?.date}
      </text>
      <text x={WIDTH - PAD} y={HEIGHT - 4} textAnchor="end" fontSize="9" fill="var(--ink-soft)">
        {series[series.length - 1]?.date}
      </text>
    </svg>
  );
}
