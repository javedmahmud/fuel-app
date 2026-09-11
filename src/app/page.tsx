/**
 * Home / Fuel Finder — `21_DETAILED_DESIGN.md` §21.9's screen inventory, UC-01. Server Component
 * (the Stack section's default: "most screens are read-mostly and server-render cleanly"); the
 * only client-side piece is `SearchForm` (geolocation + form state).
 */
import Link from "next/link";

import { SearchForm } from "./_components/search-form";
import { getDb } from "../infrastructure/db/client";
import { loadActiveFuelTypes } from "../infrastructure/repositories/fuel-type-repository";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const fuelTypes = [...(await loadActiveFuelTypes(getDb())).values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  return (
    <div className={styles.app}>
      <header className={styles.masthead}>
        <Link href="/settings" className={styles.settingsLink}>
          ⚙ Settings
        </Link>
        <p className={styles.wordmark}>
          Fuel <em>Intelligence</em>
        </p>
        <p className={styles.tagline}>The cheapest practical fuel nearby — price plus the drive.</p>
      </header>

      <main>
        <SearchForm fuelTypes={fuelTypes} />
        <Link href="/commute" className={styles.commuteLink}>
          🚗 Driving somewhere specific? Try Commute Mode →
        </Link>
      </main>
    </div>
  );
}
