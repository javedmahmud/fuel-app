/**
 * Settings — `21_DETAILED_DESIGN.md` §21.9's screen inventory, UC-07. "Fuel preference, default
 * location, vehicle profile, notification settings, privacy/data controls." Anonymous, no
 * backend (`11_AUTHENTICATION.md` §11.3) — every value here lives in this browser only. Server
 * Component only for the fuel-type list (reused from the Home screen's own picker); everything
 * interactive is `SettingsForm`.
 */
import Link from "next/link";

import { getDb } from "../../infrastructure/db/client";
import { loadActiveFuelTypes } from "../../infrastructure/repositories/fuel-type-repository";
import { SettingsForm } from "../_components/settings-form";
import styles from "../page.module.css";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const fuelTypes = [...(await loadActiveFuelTypes(getDb())).values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  return (
    <div className={styles.app}>
      <header className={styles.masthead}>
        <Link href="/" className={styles.backLink}>
          ← Search
        </Link>
        <p className={styles.wordmark}>
          Fuel <em>Intelligence</em>
        </p>
        <p className={styles.tagline}>Stored on this device only — no account required.</p>
      </header>

      <main>
        <SettingsForm fuelTypes={fuelTypes} />
      </main>
    </div>
  );
}
