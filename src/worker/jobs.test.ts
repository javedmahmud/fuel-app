import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerJob } from "./jobs";
import { releaseJobLock, tryAcquireJobLock } from "../infrastructure/db/advisory-lock";
import { runFullSyncJob } from "./ingestion/full-sync-job";
import { runNewPricesJob } from "./ingestion/new-prices-job";
import { runRefDataJob } from "./ingestion/ref-data-job";

// jobs.ts's actual job is lock acquisition + routing + exit-code mapping — the ingestion
// pipeline itself (fetch -> gate -> persist) belongs to and is tested by
// ./ingestion/*.test.ts. Mocking those three functions here keeps this file testing exactly
// jobs.ts's own responsibility, not re-testing the pipeline through another layer of fakes.
vi.mock("../infrastructure/db/advisory-lock", () => ({
  tryAcquireJobLock: vi.fn(),
  releaseJobLock: vi.fn(),
}));
vi.mock("./ingestion/new-prices-job", () => ({ runNewPricesJob: vi.fn() }));
vi.mock("./ingestion/full-sync-job", () => ({ runFullSyncJob: vi.fn() }));
vi.mock("./ingestion/ref-data-job", () => ({ runRefDataJob: vi.fn() }));

const mockedTryAcquire = vi.mocked(tryAcquireJobLock);
const mockedRelease = vi.mocked(releaseJobLock);
const mockedNewPrices = vi.mocked(runNewPricesJob);
const mockedFullSync = vi.mocked(runFullSyncJob);
const mockedRefData = vi.mocked(runRefDataJob);

const fakeDb = {} as never;
const fakeGetFuelDataSource = () => ({}) as never;

const emptyPersistResult = {
  insertedCount: 0,
  duplicateCount: 0,
  rejectedCount: 0,
  rejectedByReason: {},
  skippedNonPricedCount: 0,
  observedStationCodes: new Set<string>(),
};

describe("runWorkerJob", () => {
  beforeEach(() => {
    mockedTryAcquire.mockReset();
    mockedRelease.mockReset();
    mockedNewPrices.mockReset();
    mockedFullSync.mockReset();
    mockedRefData.mockReset();
    mockedTryAcquire.mockResolvedValue(true);
  });

  it("routes new-prices to runNewPricesJob and reports the counts", async () => {
    mockedNewPrices.mockResolvedValue({
      ok: true,
      value: { ...emptyPersistResult, insertedCount: 3, duplicateCount: 1, rejectedCount: 2 },
    });

    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });

    expect(mockedNewPrices).toHaveBeenCalledTimes(1);
    expect(mockedFullSync).not.toHaveBeenCalled();
    expect(mockedRefData).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      exitCode: 0,
      message: '"new-prices" completed — 3 inserted, 1 duplicate, 2 rejected.',
    });
  });

  it("includes the rejection reason breakdown in the message — §8.10's 'counted and logged'", async () => {
    mockedNewPrices.mockResolvedValue({
      ok: true,
      value: {
        ...emptyPersistResult,
        insertedCount: 1,
        rejectedCount: 3,
        rejectedByReason: { station_unknown: 2, price_implausible: 1 },
      },
    });

    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });

    expect(outcome.message).toContain("station_unknown=2");
    expect(outcome.message).toContain("price_implausible=1");
  });

  it("reports skipped non-priced records separately from rejected, not folded into the count", async () => {
    mockedNewPrices.mockResolvedValue({
      ok: true,
      value: {
        ...emptyPersistResult,
        insertedCount: 5,
        rejectedCount: 1,
        rejectedByReason: { source_reported_at_insane: 1 },
        skippedNonPricedCount: 3,
      },
    });

    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });

    expect(outcome.message).toContain("1 rejected");
    expect(outcome.message).toContain("3 skipped (non-priced fuel type)");
  });

  it("omits the skipped-non-priced clause entirely when there are none", async () => {
    mockedNewPrices.mockResolvedValue({
      ok: true,
      value: { ...emptyPersistResult, insertedCount: 1 },
    });

    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });

    expect(outcome.message).not.toContain("skipped");
  });

  it("routes full-sync to runFullSyncJob", async () => {
    mockedFullSync.mockResolvedValue({
      ok: true,
      value: {
        ...emptyPersistResult,
        stationGraduation: {
          reactivated: 0,
          markedSuspect: 0,
          markedSuspectWithAlarm: 0,
          markedInactive: 0,
        },
      },
    });

    await runWorkerJob("full-sync", { db: fakeDb, getFuelDataSource: fakeGetFuelDataSource });

    expect(mockedFullSync).toHaveBeenCalledTimes(1);
    expect(mockedNewPrices).not.toHaveBeenCalled();
  });

  it("routes ref-data to runRefDataJob and reports upsert/deactivate counts", async () => {
    mockedRefData.mockResolvedValue({
      ok: true,
      value: {
        stationsUpserted: 2,
        stationsDeactivated: 0,
        fuelTypesUpserted: 1,
        fuelTypesDeactivated: 0,
      },
    });

    const outcome = await runWorkerJob("ref-data", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });

    expect(mockedRefData).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      exitCode: 0,
      message:
        '"ref-data" completed — 2 station(s), 1 fuel type(s) upserted (0 station(s), 0 fuel type(s) deactivated).',
    });
  });

  it("exits cleanly at 0 without calling any job when the advisory lock isn't acquired", async () => {
    mockedTryAcquire.mockResolvedValue(false);

    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });

    expect(mockedNewPrices).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toContain("already running elsewhere");
    // Never acquired, so must never attempt to release either.
    expect(mockedRelease).not.toHaveBeenCalled();
  });

  it("always releases the lock, even when the job itself fails", async () => {
    mockedNewPrices.mockResolvedValue({
      ok: false,
      error: { type: "auth_failed", message: "x" },
    });

    await runWorkerJob("new-prices", { db: fakeDb, getFuelDataSource: fakeGetFuelDataSource });

    expect(mockedRelease).toHaveBeenCalledTimes(1);
  });

  it("treats budget_exceeded as expected throttling — exit 0, not an alarm", async () => {
    mockedNewPrices.mockResolvedValue({ ok: false, error: { type: "budget_exceeded" } });
    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });
    expect(outcome.exitCode).toBe(0);
  });

  it("treats circuit_open as expected throttling — exit 0, not an alarm", async () => {
    mockedNewPrices.mockResolvedValue({ ok: false, error: { type: "circuit_open" } });
    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });
    expect(outcome.exitCode).toBe(0);
  });

  it("treats key_environment_mismatch as alarm-worthy — exit 1, per ADR-016", async () => {
    mockedNewPrices.mockResolvedValue({
      ok: false,
      error: {
        type: "key_environment_mismatch",
        recordedEnvironment: "production",
        currentEnvironment: "staging",
      },
    });
    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });
    expect(outcome.exitCode).toBe(1);
  });

  it("treats auth_failed, timeout, and server_error as alarm-worthy — exit 1", async () => {
    for (const error of [
      { type: "auth_failed" as const, message: "x" },
      { type: "timeout" as const, message: "x" },
      { type: "server_error" as const, status: 500, message: "x" },
    ]) {
      mockedNewPrices.mockResolvedValue({ ok: false, error });
      const outcome = await runWorkerJob("new-prices", {
        db: fakeDb,
        getFuelDataSource: fakeGetFuelDataSource,
      });
      expect(outcome.exitCode).toBe(1);
    }
  });

  it("no-ops rollup and retention without touching the lock or any job", async () => {
    const rollup = await runWorkerJob("rollup", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });
    const retention = await runWorkerJob("retention", {
      db: fakeDb,
      getFuelDataSource: fakeGetFuelDataSource,
    });

    expect(rollup).toEqual({
      exitCode: 0,
      message: expect.stringContaining("not yet implemented"),
    });
    expect(retention).toEqual({
      exitCode: 0,
      message: expect.stringContaining("not yet implemented"),
    });
    expect(mockedTryAcquire).not.toHaveBeenCalled();
    expect(mockedNewPrices).not.toHaveBeenCalled();
    expect(mockedFullSync).not.toHaveBeenCalled();
    expect(mockedRefData).not.toHaveBeenCalled();
  });
});
