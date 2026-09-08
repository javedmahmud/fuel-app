import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const fuelApp = github("javedmahmud/fuel-app", { branch: "staging", checkSuites: false });

  const Postgres4iBn = postgres("Postgres-4iBn", { region: "us-west2" });
  Postgres4iBn.deploy = { limitOverride: { containers: { cpu: 1, memoryBytes: 1000000000 } } };
  Postgres4iBn.networking = { privateNetworkEndpoint: "postgres-4ibn", tcpProxies: { "5432": {} } };
  const postgresVolumeDHsw = volume("postgres-volume-dHsw", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 5000,
  });

  const mellowBlessing = service("mellow-blessing", {
    source: fuelApp,
    replicas: { "us-west2": 1 },
    env: {
      DATABASE_URL: preserve(),
      DEFAULT_CONSUMPTION_L_100KM: preserve(),
      FRESHNESS_THRESHOLDS_JSON: preserve(),
      LOG_LEVEL: preserve(),
      REFERENCE_FILL_LITRES: preserve(),
    },
    // Runs once per deploy, before the new version takes traffic, regardless of replica count
    // — matches 14_DEPLOYMENT.md §14.5 exactly ("migrations run as a release step... not on
    // application boot"), and avoids the concurrent-migration risk of embedding this in the
    // start command instead (this service autoscales to 2 replicas per §14.2).
    preDeploy: "npm run db:migrate",
  });

  // One service per cron trigger, since Railway's cron model is one service = one fixed start
  // command = one schedule. 14_DEPLOYMENT.md §14.3 names 4 triggers across the 3 job types the
  // adapter actually supports today (new-prices, full-sync x2, ref-data) — rollup/retention
  // aren't wired up here since their job logic doesn't exist yet (Sprint 2).
  //
  // `deploy.cronSchedule` is set directly in code — discovered via `railway config pull` after
  // setting the first one by hand in the dashboard.
  //
  // env values render as preserve() here regardless of whether the underlying value on Railway
  // is a literal or a cross-service reference (e.g. worker-full-sync-morning's Fuel API vars
  // are actually `${{worker-new-prices.VARIABLE}}` references, set once on worker-new-prices
  // and reused rather than re-entered — pull/plan/apply treat both uniformly as "keep whatever
  // is already there," so no special handling needed here either way).
  const workerNewPrices = service("worker-new-prices", {
    source: fuelApp,
    start: "node dist/worker.js new-prices",
    replicas: { "us-west2": 1 },
    deploy: { cronSchedule: "0 * * * *", restartPolicyType: "NEVER" },
    env: {
      DATABASE_URL: preserve(),
      ENVIRONMENT_NAME: preserve(),
      FUEL_API_BASE_URL: preserve(),
      FUEL_API_CONSUMER_KEY: preserve(),
      FUEL_API_CONSUMER_SECRET: preserve(),
      FUEL_API_VERSION: preserve(),
    },
  });

  // 03:00 AEST (17:00 UTC) daily — the "full sync" row's first of two triggers per §14.3. Fuel
  // API vars here are ${{worker-new-prices.VARIABLE}} references, not re-entered literals.
  const workerFullSyncMorning = service("worker-full-sync-morning", {
    source: fuelApp,
    start: "node dist/worker.js full-sync",
    replicas: { "us-west2": 1 },
    deploy: { cronSchedule: "0 17 * * *", restartPolicyType: "NEVER" },
    env: {
      DATABASE_URL: preserve(),
      ENVIRONMENT_NAME: preserve(),
      FUEL_API_BASE_URL: preserve(),
      FUEL_API_CONSUMER_KEY: preserve(),
      FUEL_API_CONSUMER_SECRET: preserve(),
      FUEL_API_VERSION: preserve(),
    },
  });

  // 00:15 AEST (14:15 UTC) daily — the "full sync" row's second trigger per §14.3. Per
  // 08_INGESTION_ARCHITECTURE.md §8.5, this one specifically isn't a hedge: Test 3d confirmed
  // the daily watermark reset is strict, so this run is what halves the worst-case loss window
  // from ~24h to ~12h. Fuel API vars again reference worker-new-prices, not re-entered.
  const workerFullSyncMidnight = service("worker-full-sync-midnight", {
    source: fuelApp,
    start: "node dist/worker.js full-sync",
    replicas: { "us-west2": 1 },
    deploy: { cronSchedule: "15 14 * * *", restartPolicyType: "NEVER" },
    env: {
      DATABASE_URL: preserve(),
      ENVIRONMENT_NAME: preserve(),
      FUEL_API_BASE_URL: preserve(),
      FUEL_API_CONSUMER_KEY: preserve(),
      FUEL_API_CONSUMER_SECRET: preserve(),
      FUEL_API_VERSION: preserve(),
    },
  });

  // Sun 03:30 AEST (17:30 UTC Sunday) weekly — the "reference data" row per §14.3. Fourth and
  // last of the four triggers the adapter currently supports (rollup/retention still pending
  // Sprint 2's job logic). Fuel API vars again reference worker-new-prices, not re-entered.
  const workerRefData = service("worker-ref-data", {
    source: fuelApp,
    start: "node dist/worker.js ref-data",
    replicas: { "us-west2": 1 },
    deploy: { cronSchedule: "30 17 * * 0", restartPolicyType: "NEVER" },
    env: {
      DATABASE_URL: preserve(),
      ENVIRONMENT_NAME: preserve(),
      FUEL_API_BASE_URL: preserve(),
      FUEL_API_CONSUMER_KEY: preserve(),
      FUEL_API_CONSUMER_SECRET: preserve(),
      FUEL_API_VERSION: preserve(),
    },
  });

  // 03:45 AEST (17:45 UTC) daily — 45 min after worker-full-sync-morning, matching
  // 21_DETAILED_DESIGN.md §21.3's cron table note that rollup "runs after full_sync — depends
  // on its completion" (real full_sync runs finish in well under a minute against staging's
  // current size, so this margin is generous, not tight). Zero Fuel API calls (rollup only
  // reads fuel_price_observation and writes daily_price_rollup — see jobs.ts's own comment on
  // why it has no FuelApiError of its own), so unlike the other four services this one needs
  // only DATABASE_URL — no FUEL_API_*/ENVIRONMENT_NAME vars at all, since getFuelDataSource()
  // is never called for this job. Added via the dashboard after this service was created
  // (preserve() only works for a value already on Railway, and this was a brand-new service
  // with nothing yet to preserve), confirmed present and non-empty via
  // railway variables --json (names/non-emptiness only, never values) — same pattern as the
  // other four services' brand-new secrets.
  const workerRollup = service("worker-rollup", {
    source: fuelApp,
    start: "node dist/worker.js rollup",
    replicas: { "us-west2": 1 },
    deploy: { cronSchedule: "45 17 * * *", restartPolicyType: "NEVER" },
    env: {
      DATABASE_URL: preserve(),
    },
  });

  return project("focused-courage", {
    resources: [
      Postgres4iBn,
      mellowBlessing,
      postgresVolumeDHsw,
      workerNewPrices,
      workerFullSyncMorning,
      workerFullSyncMidnight,
      workerRefData,
      workerRollup,
    ],
  });
});
