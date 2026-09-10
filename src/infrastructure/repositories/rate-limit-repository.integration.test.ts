import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../db/client";
import { rateLimitWindow } from "../db/schema";
import { incrementRateLimitCounter } from "./rate-limit-repository";

/**
 * Real Postgres — the whole point of this table (§13.9: "Postgres-backed fixed-window
 * counters") is atomic concurrent increments, which a mock can't meaningfully verify. Rolled
 * back, same pattern as every other repository test in this codebase; a random key per test
 * run means no collision with real traffic hitting this table concurrently.
 */

class IntentionalTestRollback extends Error {}

describe("incrementRateLimitCounter against real Postgres", () => {
  it("creates a new row starting at count 1", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const key = `test:${Math.random().toString(36).slice(2)}`;
        const windowStart = new Date("2026-09-10T14:32:00Z");

        const count = await incrementRateLimitCounter(tx, key, windowStart);
        expect(count).toBe(1);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  });

  it("increments an existing row rather than creating a duplicate", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const key = `test:${Math.random().toString(36).slice(2)}`;
        const windowStart = new Date("2026-09-10T14:32:00Z");

        await incrementRateLimitCounter(tx, key, windowStart);
        await incrementRateLimitCounter(tx, key, windowStart);
        const third = await incrementRateLimitCounter(tx, key, windowStart);
        expect(third).toBe(3);

        const rows = await tx
          .select()
          .from(rateLimitWindow)
          .where(and(eq(rateLimitWindow.key, key), eq(rateLimitWindow.windowStart, windowStart)));
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(3);

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  });

  it("keeps different windows for the same key independent", async () => {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const key = `test:${Math.random().toString(36).slice(2)}`;

        const first = await incrementRateLimitCounter(tx, key, new Date("2026-09-10T14:32:00Z"));
        const second = await incrementRateLimitCounter(tx, key, new Date("2026-09-10T14:33:00Z"));
        expect(first).toBe(1);
        expect(second).toBe(1); // a new window, not a continuation of the first

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  });

  it("accumulates 20 calls issued together (from JS) to exactly 1..20, each value once", async () => {
    // Issued via Promise.all to mimic concurrent request handling, but all inside this test's
    // own transaction — Postgres itself serialises statements within one transaction/connection,
    // so this confirms the ON CONFLICT DO UPDATE arithmetic is correct under repeated calls, not
    // true cross-connection racing (proving that would mean writing real, uncommitted-forever
    // rows outside this codebase's rolled-back-transaction safety convention, which isn't worth
    // the risk for a textbook-standard atomic-upsert pattern).
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const key = `test:${Math.random().toString(36).slice(2)}`;
        const windowStart = new Date("2026-09-10T14:32:00Z");

        const results = await Promise.all(
          Array.from({ length: 20 }, () => incrementRateLimitCounter(tx, key, windowStart)),
        );

        expect([...results].sort((a, b) => a - b)).toEqual(
          Array.from({ length: 20 }, (_, i) => i + 1),
        );

        throw new IntentionalTestRollback();
      });
    } catch (e) {
      if (!(e instanceof IntentionalTestRollback)) throw e;
    }
  }, 15_000);
});
