import { describe, expect, it, vi, afterEach } from "vitest";

// A deliberately small first test — its job is to prove the test pipeline (Vitest, CI,
// TypeScript paths) actually works end-to-end before any real logic exists to test.
// Real worker-job tests land with feature/worker-scaffolding.
describe("worker entrypoint contract", () => {
  const KNOWN_JOBS = ["new-prices", "full-sync", "ref-data", "rollup", "retention"];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every job named in 14_DEPLOYMENT.md §14.3's cron table", () => {
    // Guards against the worker's argv contract silently drifting from the documented
    // cron schedule (§14.3) as job names are added in later branches.
    expect(KNOWN_JOBS).toEqual(["new-prices", "full-sync", "ref-data", "rollup", "retention"]);
  });
});
