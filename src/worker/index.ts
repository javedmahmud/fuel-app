/**
 * Worker entrypoint.
 *
 * Invoked by Railway cron as a short-lived process that exits on completion —
 * see `14_DEPLOYMENT.md` §14.2/§14.3 for the exact schedule and start command
 * (`node dist/worker.js <job>`).
 *
 * Job implementations (new-prices, full-sync, ref-data, rollup, retention) land in
 * `feature/worker-scaffolding` alongside the advisory-lock guard from
 * `08_INGESTION_ARCHITECTURE.md` §8.7. This stub only wires up the argv contract so the
 * build/deploy pipeline has something real to compile and run from day one.
 */

const KNOWN_JOBS = ["new-prices", "full-sync", "ref-data", "rollup", "retention"] as const;
type JobName = (typeof KNOWN_JOBS)[number];

function isKnownJob(value: string | undefined): value is JobName {
  return KNOWN_JOBS.includes(value as JobName);
}

async function main(): Promise<void> {
  const job = process.argv[2];

  if (!isKnownJob(job)) {
    console.error(
      `Unknown or missing job name. Usage: node dist/worker.js <${KNOWN_JOBS.join("|")}>`,
    );
    process.exit(1);
  }

  console.log(`[worker] "${job}" invoked — not yet implemented (feature/worker-scaffolding).`);
}

main().catch((err: unknown) => {
  console.error("[worker] unhandled error:", err);
  process.exit(1);
});
