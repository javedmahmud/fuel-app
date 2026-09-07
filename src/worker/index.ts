/**
 * Worker entrypoint.
 *
 * Invoked by Railway cron as a short-lived process that exits on completion —
 * see `14_DEPLOYMENT.md` §14.2/§14.3 for the exact schedule and start command
 * (`node dist/worker.js <job>`).
 *
 * This file is intentionally thin — argv parsing and env var wiring only. The actual logic
 * (advisory lock, calling into the Fuel API adapter, exit-code decisions) lives in `jobs.ts`,
 * kept separate specifically so it's testable without a real process/argv/env.
 */
import { getDb } from "../infrastructure/db/client";
import { FuelDataSource, type FuelDataSourceConfig } from "../infrastructure/fuel-api";
import { runWorkerJob } from "./jobs";

const KNOWN_JOBS = ["new-prices", "full-sync", "ref-data", "rollup", "retention"] as const;
type JobName = (typeof KNOWN_JOBS)[number];

function isKnownJob(value: string | undefined): value is JobName {
  return KNOWN_JOBS.includes(value as JobName);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — see .env.example and 14_DEPLOYMENT.md §14.4.`);
  }
  return value;
}

function readFuelApiConfig(): FuelDataSourceConfig {
  return {
    baseUrl: requireEnv("FUEL_API_BASE_URL"),
    consumerKey: requireEnv("FUEL_API_CONSUMER_KEY"),
    consumerSecret: requireEnv("FUEL_API_CONSUMER_SECRET"),
    environmentName: requireEnv("ENVIRONMENT_NAME"),
  };
}

async function main(): Promise<void> {
  const job = process.argv[2];

  if (!isKnownJob(job)) {
    console.error(
      `Unknown or missing job name. Usage: node dist/worker.js <${KNOWN_JOBS.join("|")}>`,
    );
    process.exit(1);
  }

  const db = getDb();
  // Constructed lazily, inside the callback, so "rollup"/"retention" — which runWorkerJob
  // short-circuits to a no-op before ever touching this — don't require Fuel API credentials
  // to be set at all. Verified this matters: an earlier version constructed it eagerly here and
  // crashed on `rollup` in an environment with only DATABASE_URL set.
  const getFuelDataSource = () => new FuelDataSource(db, readFuelApiConfig());

  const outcome = await runWorkerJob(job, { db, getFuelDataSource });
  console.log(`[worker] ${outcome.message}`);
  process.exit(outcome.exitCode);
}

main().catch((err: unknown) => {
  console.error("[worker] unhandled error:", err);
  process.exit(1);
});
