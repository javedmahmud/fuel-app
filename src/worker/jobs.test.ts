import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerJob } from "./jobs";
import { releaseJobLock, tryAcquireJobLock } from "../infrastructure/db/advisory-lock";

vi.mock("../infrastructure/db/advisory-lock", () => ({
  tryAcquireJobLock: vi.fn(),
  releaseJobLock: vi.fn(),
}));

const mockedTryAcquire = vi.mocked(tryAcquireJobLock);
const mockedRelease = vi.mocked(releaseJobLock);

const fakeDb = {} as never;

function fakeFuelDataSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fetchNewPrices: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    fetchAllPrices: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    fetchReferenceData: vi
      .fn()
      .mockResolvedValue({ ok: true, value: { stations: [], fuelTypes: [] } }),
    ...overrides,
  };
}

describe("runWorkerJob", () => {
  beforeEach(() => {
    mockedTryAcquire.mockReset();
    mockedRelease.mockReset();
    mockedTryAcquire.mockResolvedValue(true);
  });

  it("routes new-prices to fetchNewPrices and reports the record count", async () => {
    const source = fakeFuelDataSource({
      fetchNewPrices: vi.fn().mockResolvedValue({ ok: true, value: [{}, {}, {}] }),
    });

    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: () => source as never,
    });

    expect(source.fetchNewPrices).toHaveBeenCalledTimes(1);
    expect(source.fetchAllPrices).not.toHaveBeenCalled();
    expect(outcome).toEqual({ exitCode: 0, message: '"new-prices" completed — 3 record(s).' });
  });

  it("routes full-sync to fetchAllPrices", async () => {
    const source = fakeFuelDataSource();
    await runWorkerJob("full-sync", { db: fakeDb, getFuelDataSource: () => source as never });
    expect(source.fetchAllPrices).toHaveBeenCalledTimes(1);
  });

  it("routes ref-data to fetchReferenceData and counts stations + fuelTypes together", async () => {
    const source = fakeFuelDataSource({
      fetchReferenceData: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { stations: [{}, {}], fuelTypes: [{}] } }),
    });

    const outcome = await runWorkerJob("ref-data", {
      db: fakeDb,
      getFuelDataSource: () => source as never,
    });

    expect(source.fetchReferenceData).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ exitCode: 0, message: '"ref-data" completed — 3 record(s).' });
  });

  it("exits cleanly at 0 without calling the adapter when the advisory lock isn't acquired", async () => {
    mockedTryAcquire.mockResolvedValue(false);
    const source = fakeFuelDataSource();

    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: () => source as never,
    });

    expect(source.fetchNewPrices).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toContain("already running elsewhere");
    // Never acquired, so must never attempt to release either.
    expect(mockedRelease).not.toHaveBeenCalled();
  });

  it("always releases the lock, even when the job itself fails", async () => {
    const source = fakeFuelDataSource({
      fetchNewPrices: vi
        .fn()
        .mockResolvedValue({ ok: false, error: { type: "auth_failed", message: "x" } }),
    });

    await runWorkerJob("new-prices", { db: fakeDb, getFuelDataSource: () => source as never });

    expect(mockedRelease).toHaveBeenCalledTimes(1);
  });

  it("treats budget_exceeded as expected throttling — exit 0, not an alarm", async () => {
    const source = fakeFuelDataSource({
      fetchNewPrices: vi.fn().mockResolvedValue({ ok: false, error: { type: "budget_exceeded" } }),
    });
    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: () => source as never,
    });
    expect(outcome.exitCode).toBe(0);
  });

  it("treats circuit_open as expected throttling — exit 0, not an alarm", async () => {
    const source = fakeFuelDataSource({
      fetchNewPrices: vi.fn().mockResolvedValue({ ok: false, error: { type: "circuit_open" } }),
    });
    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: () => source as never,
    });
    expect(outcome.exitCode).toBe(0);
  });

  it("treats key_environment_mismatch as alarm-worthy — exit 1, per ADR-016", async () => {
    const source = fakeFuelDataSource({
      fetchNewPrices: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          type: "key_environment_mismatch",
          recordedEnvironment: "production",
          currentEnvironment: "staging",
        },
      }),
    });
    const outcome = await runWorkerJob("new-prices", {
      db: fakeDb,
      getFuelDataSource: () => source as never,
    });
    expect(outcome.exitCode).toBe(1);
  });

  it("treats auth_failed, timeout, and server_error as alarm-worthy — exit 1", async () => {
    for (const error of [
      { type: "auth_failed", message: "x" },
      { type: "timeout", message: "x" },
      { type: "server_error", status: 500, message: "x" },
    ]) {
      const source = fakeFuelDataSource({
        fetchNewPrices: vi.fn().mockResolvedValue({ ok: false, error }),
      });
      const outcome = await runWorkerJob("new-prices", {
        db: fakeDb,
        getFuelDataSource: () => source as never,
      });
      expect(outcome.exitCode).toBe(1);
    }
  });

  it("no-ops rollup and retention without touching the lock or the adapter — not built yet", async () => {
    const source = fakeFuelDataSource();

    const rollup = await runWorkerJob("rollup", {
      db: fakeDb,
      getFuelDataSource: () => source as never,
    });
    const retention = await runWorkerJob("retention", {
      db: fakeDb,
      getFuelDataSource: () => source as never,
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
    expect(source.fetchNewPrices).not.toHaveBeenCalled();
  });
});
