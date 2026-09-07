import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * `08_INGESTION_ARCHITECTURE.md` §8.7: "`pg_try_advisory_lock` on a job-specific key. A stuck
 * previous run, a double-fired cron, or a manual trigger mid-cycle exits cleanly at zero cost.
 * `try_` rather than a blocking acquire matters: a queued second run would fire immediately
 * after the first and both spend quota *and* consume a window."
 *
 * Uses Postgres's two-argument form — `pg_try_advisory_lock(classid, objid)` — which occupies a
 * completely separate lock namespace from a single-bigint-argument call. `token-manager.ts`
 * already takes a single-argument advisory lock for its own, unrelated purpose (single-flight
 * OAuth refresh); using the two-argument form here means the two mechanisms can never
 * accidentally collide on the same lock id, without needing to coordinate a shared numbering
 * scheme between two otherwise-unrelated modules.
 */
const JOB_LOCK_CLASS_ID = 1; // fixed namespace: "worker job locks" — distinct from token-manager's.

/** One fixed integer per job type, not a hash of the name — small closed set, so an explicit
 * mapping is simpler to read and to test than any hashing scheme would be. */
const JOB_LOCK_IDS = {
  new_prices: 1,
  full_sync: 2,
  ref_data: 3,
  rollup: 4,
  retention: 5,
} as const;

export type LockableJobType = keyof typeof JOB_LOCK_IDS;

/** Non-blocking: returns `true` if the lock was acquired, `false` if another session already
 * holds it. Never waits — see the module comment on why a blocking acquire would be wrong here. */
export async function tryAcquireJobLock(
  db: Pick<PostgresJsDatabase, "execute">,
  jobType: LockableJobType,
): Promise<boolean> {
  const rows = await db.execute<{ pg_try_advisory_lock: boolean }>(
    sql`select pg_try_advisory_lock(${JOB_LOCK_CLASS_ID}, ${JOB_LOCK_IDS[jobType]})`,
  );
  return Boolean(rows[0]?.pg_try_advisory_lock);
}

/** Session-scoped, not transaction-scoped — must be released explicitly (in a `finally`) once
 * the job's work is done, or the lock holds until the process's connection closes. */
export async function releaseJobLock(
  db: Pick<PostgresJsDatabase, "execute">,
  jobType: LockableJobType,
): Promise<void> {
  await db.execute(sql`select pg_advisory_unlock(${JOB_LOCK_CLASS_ID}, ${JOB_LOCK_IDS[jobType]})`);
}
