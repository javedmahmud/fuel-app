/**
 * `21_DETAILED_DESIGN.md` §21.9's UI principle: "Timestamp visible everywhere a price appears."
 * Purely presentational — the actual freshness *band* (current/ageing/long_unchanged, deciding
 * tone/urgency) is `domain/calculation/freshness.ts`'s `priceAgeBand`, a real domain rule with
 * real thresholds; this only turns an instant into the words next to it. Coarse on purpose (the
 * price's own age is what matters, per §9.5 — a to-the-minute counter reads as more precise than
 * this product's real data actually is).
 */
export function formatRelativeTime(instant: Date, now: Date): string {
  const diffMs = now.getTime() - instant.getTime();
  const diffMinutes = Math.round(diffMs / 60_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}
