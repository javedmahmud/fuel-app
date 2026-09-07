import { describe, expect, it, vi } from "vitest";
import { releaseJobLock, tryAcquireJobLock } from "./advisory-lock";

function fakeDb(result: boolean) {
  return { execute: vi.fn().mockResolvedValue([{ pg_try_advisory_lock: result }]) };
}

describe("tryAcquireJobLock", () => {
  it("returns true when pg_try_advisory_lock reports the lock was acquired", async () => {
    const db = fakeDb(true);
    await expect(tryAcquireJobLock(db as never, "new_prices")).resolves.toBe(true);
  });

  it("returns false when another session already holds the lock", async () => {
    const db = fakeDb(false);
    await expect(tryAcquireJobLock(db as never, "new_prices")).resolves.toBe(false);
  });

  it("uses a distinct lock id per job type, so unrelated jobs never contend", async () => {
    const db = { execute: vi.fn().mockResolvedValue([{ pg_try_advisory_lock: true }]) };
    await tryAcquireJobLock(db as never, "new_prices");
    await tryAcquireJobLock(db as never, "full_sync");

    // Drizzle's sql`` tagged template stores interpolated values as raw entries in
    // queryChunks, interleaved with the literal SQL string fragments — extracting the
    // numbers directly is the simplest reliable way to assert on the bound parameters.
    const objIds = db.execute.mock.calls.map((call) => {
      const chunks = (call[0] as { queryChunks: unknown[] }).queryChunks;
      return chunks.filter((chunk): chunk is number => typeof chunk === "number").at(-1);
    });
    expect(objIds[0]).not.toBe(objIds[1]);
  });
});

describe("releaseJobLock", () => {
  it("calls pg_advisory_unlock without throwing", async () => {
    const db = { execute: vi.fn().mockResolvedValue([{ pg_advisory_unlock: true }]) };
    await expect(releaseJobLock(db as never, "ref_data")).resolves.toBeUndefined();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
