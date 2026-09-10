import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getDb, reserveSessionScopedDb } from "./client";

/**
 * Regression test for a real bug found live during `feature/ingestion-persistence`: a
 * production cron run logged `WARNING 01000 "you don't own a lock of type ExclusiveLock"` from
 * Postgres's `LockRelease`. Advisory locks are session-scoped — acquire and release must run on
 * the exact same physical connection — and `getDb()`'s pooled client gives no such guarantee
 * across two separate `await db.execute(...)` calls, which is exactly how both
 * `advisory-lock.ts`'s job lock and `token-manager.ts`'s OAuth single-flight lock are used.
 *
 * This uses its own lock id pair (99999xx), never the real `JOB_LOCK_CLASS_ID`/`JOB_LOCK_IDS`
 * from advisory-lock.ts or `TOKEN_REFRESH_LOCK_KEY` from token-manager.ts — staging has a real
 * hourly cron acquiring and releasing those for real, and this test must never be able to
 * collide with or interfere with that. Advisory locks aren't table rows, so there's nothing to
 * roll back — each test releases what it took in a `finally`, and `afterAll` sweeps the id in
 * case a failed assertion left it held, so a failing run doesn't wedge the id for later runs.
 */

const TEST_CLASS_ID = 999999;
const TEST_OBJ_ID = 1;

async function isLockFree(): Promise<boolean> {
  // Acquiring it ourselves and immediately releasing is the only reliable way to ask "is this
  // free right now" — pg_locks introspection would need matching against our own backend pid.
  const db = getDb();
  const rows = await db.execute<{ pg_try_advisory_lock: boolean }>(
    sql`select pg_try_advisory_lock(${TEST_CLASS_ID}, ${TEST_OBJ_ID})`,
  );
  const free = Boolean(rows[0]?.pg_try_advisory_lock);
  if (free) {
    await db.execute(sql`select pg_advisory_unlock(${TEST_CLASS_ID}, ${TEST_OBJ_ID})`);
  }
  return free;
}

afterAll(async () => {
  // Best-effort cleanup: if a failed assertion left the lock held by this process's pool, free
  // it so a later run isn't blocked by a previous failure. No-op if nothing is held.
  await getDb().execute(sql`select pg_advisory_unlock(${TEST_CLASS_ID}, ${TEST_OBJ_ID})`);
});

describe("reserveSessionScopedDb — advisory lock session affinity", () => {
  it("releases a lock it acquired on the same reserved connection, with no ownership warning", async () => {
    expect(await isLockFree()).toBe(true); // clean starting state

    const { db, release } = await reserveSessionScopedDb();
    try {
      const acquired = await db.execute<{ pg_try_advisory_lock: boolean }>(
        sql`select pg_try_advisory_lock(${TEST_CLASS_ID}, ${TEST_OBJ_ID})`,
      );
      expect(acquired[0]?.pg_try_advisory_lock).toBe(true);

      // pg_advisory_unlock returns true only when the *current session* actually held the
      // lock — false (or the "you don't own a lock" warning path) is exactly the bug this
      // reserved connection exists to prevent.
      const released = await db.execute<{ pg_advisory_unlock: boolean }>(
        sql`select pg_advisory_unlock(${TEST_CLASS_ID}, ${TEST_OBJ_ID})`,
      );
      expect(released[0]?.pg_advisory_unlock).toBe(true);
    } finally {
      release();
    }

    // Confirms the unlock was real, not just a truthy return — a fresh acquire attempt
    // succeeds immediately rather than blocking on a lock that was never actually freed.
    expect(await isLockFree()).toBe(true);
  });

  it("two sequential reserved connections don't see each other's lock — genuinely session-scoped", async () => {
    const first = await reserveSessionScopedDb();
    const acquired = await first.db.execute<{ pg_try_advisory_lock: boolean }>(
      sql`select pg_try_advisory_lock(${TEST_CLASS_ID}, ${TEST_OBJ_ID})`,
    );
    expect(acquired[0]?.pg_try_advisory_lock).toBe(true);

    const second = await reserveSessionScopedDb();
    try {
      // A different session trying to unlock a lock it never held must be told so, not
      // silently succeed — otherwise this test couldn't distinguish a real fix from a no-op.
      const wrongRelease = await second.db.execute<{ pg_advisory_unlock: boolean }>(
        sql`select pg_advisory_unlock(${TEST_CLASS_ID}, ${TEST_OBJ_ID})`,
      );
      expect(wrongRelease[0]?.pg_advisory_unlock).toBe(false);
    } finally {
      second.release();
      // Release from the session that actually holds it, so the id is clean for the next test.
      await first.db.execute(sql`select pg_advisory_unlock(${TEST_CLASS_ID}, ${TEST_OBJ_ID})`);
      first.release();
    }
  });
});
