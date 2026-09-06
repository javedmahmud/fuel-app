import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

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

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!dbInstance) {
    const queryClient = postgres(requireDatabaseUrl());
    dbInstance = drizzle(queryClient, { schema });
  }
  return dbInstance;
}
