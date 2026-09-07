import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema";

/**
 * The one place `DATABASE_URL` is read. Both web and worker import this — never construct a
 * second connection elsewhere (`14_DEPLOYMENT.md` §14.4: `DATABASE_URL` is shared between them,
 * but each process should hold exactly one pool).
 *
 * Lazily initialised on first use, not at module import time. A top-level connection attempt
 * would fire the moment anything imports this file — including `next build`'s static analysis
 * of unrelated routes — and break in any environment without `DATABASE_URL` set (CI doesn't
 * have one configured yet). Deferring until `getDb()` is actually called avoids that entirely.
 */
let queryClient: Sql | undefined;
let dbInstance: PostgresJsDatabase<typeof schema> | undefined;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. See .env.example and 14_DEPLOYMENT.md §14.4 " +
        "for what's expected in each environment.",
    );
  }
  return url;
}

function getQueryClient(): Sql {
  if (!queryClient) {
    queryClient = postgres(requireDatabaseUrl());
  }
  return queryClient;
}

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!dbInstance) {
    dbInstance = drizzle(getQueryClient(), { schema });
  }
  return dbInstance;
}

/**
 * A Postgres advisory lock is **session-scoped** — acquiring and releasing it must happen on
 * the exact same physical connection, or Postgres logs "you don't own a lock" and the release
 * silently does nothing (found live: `worker/jobs.ts`'s job lock and `fuel-api/token-manager.ts`'s
 * OAuth single-flight lock both hit this — `getDb()`'s normal pool can route any two queries to
 * different pooled connections, so acquire-then-release-later has no such guarantee).
 *
 * Returns a `db` pinned to one reserved connection via `postgres.js`'s `reserve()`, plus a
 * `release()` that must be called when done to return it to the pool. A worker job is a single
 * short-lived, sequential process anyway — reserving one connection for its entire lifetime
 * (lock acquire, all work, lock release) has no concurrency downside and is what actually
 * fixes this, rather than trying to pin only the two lock calls specifically.
 */
export async function reserveSessionScopedDb(): Promise<{
  db: PostgresJsDatabase<typeof schema>;
  release: () => void;
}> {
  const reserved = await getQueryClient().reserve();
  // postgres.js's own `Sql` type declares `.options` as always present, but `reserve()`'s
  // runtime object doesn't actually set it — only the top-level pool client does. drizzle-orm's
  // postgres-js driver unconditionally writes to `client.options.parsers`/`.serializers` to
  // install its own type overrides, so without this a reserved connection throws immediately
  // ("Cannot read properties of undefined (reading 'parsers')" — confirmed live). Sharing the
  // pool's own `options` object is correct, not a workaround-of-convenience: it's static
  // per-pool parser/serializer config, not per-connection state.
  reserved.options = getQueryClient().options;
  return { db: drizzle(reserved, { schema }), release: () => reserved.release() };
}
