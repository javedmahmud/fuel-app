import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "../client";
import { fuelPriceObservation, fuelType, station } from "./index";

/**
 * Runs against a REAL database (whatever DATABASE_URL points at — see
 * vitest.integration.config.mts for how to run this against staging without ever typing the
 * credential). Assumes migrations have already been applied: `npm run db:migrate`.
 *
 * Everything below runs inside one outer transaction that is *always* rolled back, regardless
 * of whether the assertions pass — see the `finally` block. That's what makes it safe to run
 * repeatedly against real staging: nothing this test does is ever actually committed.
 *
 * Testing the append-only trigger specifically requires a SAVEPOINT: Postgres aborts the
 * enclosing transaction the instant a statement raises an exception, so without a savepoint to
 * roll back to, the expected trigger failure would also poison every assertion that runs after
 * it in the same transaction.
 */
describe("fuel_price_observation append-only trigger (0001_observation_append_only.sql)", () => {
  const db = getDb();

  afterAll(async () => {
    // getDb() is a module-level singleton (by design — see client.ts) shared with any other
    // integration test file, so we don't close its connection here; the process exiting after
    // the full test run closes it.
  });

  it("rejects UPDATE and DELETE while leaving normal INSERT and SELECT untouched", async () => {
    let observationIdForAssertion: bigint | undefined;

    try {
      await db.transaction(async (tx) => {
        const [fixtureFuelType] = await tx
          .insert(fuelType)
          .values({
            sourceCode: `TEST_${Date.now()}`,
            displayName: "Integration Test Fuel",
            category: "petrol",
          })
          .returning();

        const [fixtureStation] = await tx
          .insert(station)
          .values({
            sourceStationCode: `TEST_${Date.now()}`,
            name: "Integration Test Station",
            latitude: "-33.870000",
            longitude: "151.210000",
          })
          .returning();

        const [observation] = await tx
          .insert(fuelPriceObservation)
          .values({
            stationId: fixtureStation.id,
            fuelTypeId: fixtureFuelType.id,
            priceTenthsCpl: 1789,
            sourceReportedAt: new Date(),
            contentHash: `test-${Date.now()}-${Math.random()}`,
          })
          .returning();

        expect(observation).toBeDefined();
        observationIdForAssertion = observation.id;

        // --- UPDATE should be rejected by the trigger ---
        // Drizzle wraps the underlying postgres error in a DrizzleQueryError whose own
        // .message is just "Failed query: ..." — the actual RAISE EXCEPTION text from
        // 0001_observation_append_only.sql lives on .cause. Checking .cause (not just "it
        // threw something") is what proves this specific trigger fired, rather than some
        // unrelated failure the test would otherwise pass for the wrong reason.
        await tx.execute(sql`savepoint before_update`);
        await expectRejectionFromAppendOnlyTrigger(
          tx.execute(
            sql`update fuel_price_observation set price_tenths_cpl = 9999 where id = ${observation.id}`,
          ),
        );
        await tx.execute(sql`rollback to savepoint before_update`);

        // --- DELETE should be rejected by the trigger ---
        await tx.execute(sql`savepoint before_delete`);
        await expectRejectionFromAppendOnlyTrigger(
          tx.execute(sql`delete from fuel_price_observation where id = ${observation.id}`),
        );
        await tx.execute(sql`rollback to savepoint before_delete`);

        // Confirm the row is genuinely untouched — proves the trigger actually blocked the
        // write rather than the test accidentally asserting on an unrelated failure.
        const [unchanged] = await tx
          .select({ priceTenthsCpl: fuelPriceObservation.priceTenthsCpl })
          .from(fuelPriceObservation)
          .where(sql`${fuelPriceObservation.id} = ${observation.id}`);
        expect(unchanged.priceTenthsCpl).toBe(1789);

        // Force a rollback of the whole transaction regardless of the assertions above having
        // passed — this is what guarantees zero residue in a real database like staging.
        throw new IntentionalTestRollback();
      });
    } catch (err) {
      if (!(err instanceof IntentionalTestRollback)) {
        throw err;
      }
    }

    expect(observationIdForAssertion).toBeDefined();
  });
});

/** Sentinel used only to force `db.transaction()` to roll back — never a real failure. */
class IntentionalTestRollback extends Error {}

/**
 * Asserts a query was rejected specifically by `fuel_price_observation_append_only()`
 * (0001_observation_append_only.sql), not by some unrelated failure. Postgres's own P0001
 * error code (a custom RAISE EXCEPTION, which is exactly what that trigger uses) is checked
 * alongside the message text so a coincidental future error containing the word
 * "append-only" couldn't make this pass for the wrong reason either.
 */
async function expectRejectionFromAppendOnlyTrigger(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    const causeCode =
      cause && typeof cause === "object" && "code" in cause
        ? (cause as { code: unknown }).code
        : undefined;

    expect(causeMessage).toMatch(/append-only/i);
    expect(causeCode).toBe("P0001");
    return;
  }
  throw new Error(
    "Expected the query to be rejected by the append-only trigger, but it succeeded.",
  );
}
