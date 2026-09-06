import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import * as schema from "../db/schema";
import { FuelDataSource } from "./index";
import { computeKeyFingerprint } from "./key-fingerprint";

/**
 * Runs against the REAL NSW Fuel API and real staging Postgres — costs actual quota (one call
 * to the weekly ref-data endpoint). Deliberately NOT run by CI or plain `npm test` — same
 * reasoning as the DB schema branch's integration tests, with an added cost this time: this one
 * spends part of the 2,500/month budget, not just time.
 *
 * Run it locally, sparingly, with the staging credentials sourced from the external env file
 * (never pasted into a prompt, never committed) and the real staging DATABASE_PUBLIC_URL:
 *
 *   set -a; source /path/to/env/.env.staging; set +a
 *   DATABASE_URL=$(railway variables --service <postgres-service> --json | \
 *     python3 -c "import json,sys; print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])") \
 *     npm run test:integration
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This test needs the staging Fuel API credentials sourced into the ` +
        "environment first — see this file's module comment for the exact command.",
    );
  }
  return value;
}

const client = postgres(requireEnv("DATABASE_URL"));
const db = drizzle(client, { schema });

const config = {
  baseUrl: requireEnv("FUEL_API_BASE_URL"),
  consumerKey: requireEnv("FUEL_API_CONSUMER_KEY"),
  consumerSecret: requireEnv("FUEL_API_CONSUMER_SECRET"),
  environmentName: requireEnv("ENVIRONMENT_NAME"),
};

afterAll(async () => {
  await client.end();
});

describe("FuelDataSource against the real NSW Fuel API + real staging Postgres", () => {
  it("fetchReferenceData: authenticates, calls the real API, journals, ledgers, and normalises", async () => {
    const source = new FuelDataSource(db, config);
    const now = new Date();

    const result = await source.fetchReferenceData(now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Real NSW reference data — per spike Test 1, thousands of stations, ~16 fuel types.
    expect(result.value.stations.length).toBeGreaterThan(1000);
    expect(result.value.fuelTypes.length).toBeGreaterThan(5);

    // A real station shape survived normalisation intact.
    const station = result.value.stations[0];
    expect(station.sourceStationCode).toBeTruthy();
    expect(station.source).toBe("NSW_FUEL_API");
    expect(typeof station.latitude).toBe("number");

    // The ingestion_run row this call created reflects a real successful run, tagged with this
    // environment's key fingerprint — the actual mechanism ADR-016 depends on, not a mock of it.
    const [run] = await db
      .select()
      .from(schema.ingestionRun)
      .where(eq(schema.ingestionRun.jobType, "ref_data"))
      .orderBy(desc(schema.ingestionRun.startedAt))
      .limit(1);
    expect(run.status).toBe("success");
    expect(run.environmentName).toBe(config.environmentName);
    expect(run.keyFingerprint).toBe(computeKeyFingerprint(config.consumerKey));

    // The call was ledgered (§7.7) and the raw response was journaled before parsing (§21.2).
    const [ledgerRow] = await db
      .select()
      .from(schema.apiCallLedger)
      .where(eq(schema.apiCallLedger.ingestionRunId, run.id))
      .limit(1);
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow.httpStatus).toBe(200);

    const [journalRow] = await db
      .select()
      .from(schema.apiResponseJournal)
      .where(eq(schema.apiResponseJournal.ingestionRunId, run.id))
      .limit(1);
    expect(journalRow).toBeDefined();
    expect(journalRow.status).toBe("processed");
  }, 30_000);

  it("key fingerprinting refuses a call under a different declared environment — no HTTP call made, no quota spent", async () => {
    // This is the actual ADR-016 protection: the same real key, asserted under a DIFFERENT
    // environment name than the previous test just recorded, must be refused before any
    // network request happens. Deliberately checked here (free) rather than only in a unit
    // test with a fake DB (key-fingerprint.test.ts) — this proves the real query against a
    // real database returns the real row the previous test's real run created.
    const mismatchedSource = new FuelDataSource(db, {
      ...config,
      environmentName: `${config.environmentName}-integration-test-mismatch`,
    });

    const result = await mismatchedSource.fetchReferenceData(new Date());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      type: "key_environment_mismatch",
      recordedEnvironment: config.environmentName,
      currentEnvironment: `${config.environmentName}-integration-test-mismatch`,
    });
  });
});
