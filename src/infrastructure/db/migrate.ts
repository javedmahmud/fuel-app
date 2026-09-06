/**
 * Applies pending migrations from ./drizzle against DATABASE_URL. Meant to run as a release
 * step before the new app version receives traffic (`14_DEPLOYMENT.md` §14.5) — not on
 * application boot, and never with more than one replica running it concurrently.
 *
 * In Railway's own deploy pipeline this runs with DATABASE_URL already injected — nothing
 * special needed there.
 *
 * Running it locally against a Railway-hosted Postgres (e.g. staging, before CI/CD does this
 * automatically) needs the PUBLIC connection string, not the internal one: this script runs
 * outside Railway's private network, so the internal `*.railway.internal` hostname in the
 * ordinary `DATABASE_URL` doesn't resolve from here (ENOTFOUND) — see `14_DEPLOYMENT.md`
 * §14.1.2. Use the Postgres service's own `DATABASE_PUBLIC_URL` instead (only present once
 * Public Networking is enabled on that service), fetched without ever typing or displaying
 * the credential:
 *
 *   DATABASE_URL=$(railway variables --service <postgres-service-name> --json | \
 *     python3 -c "import json,sys; print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])") \
 *     npm run db:migrate
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set — nothing to migrate against.");
    process.exit(1);
  }

  // max: 1 — a migration run doesn't need a pool, and a single connection makes the intent
  // (one script, one run, then exit) explicit rather than relying on postgres-js defaults.
  const migrationClient = postgres(url, { max: 1 });
  const db = drizzle(migrationClient);

  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");

  await migrationClient.end();
}

main().catch((err: unknown) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
