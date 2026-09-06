import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "./index";

// Structural sanity checks, not a substitute for the real integration test (test:integration,
// which actually runs migrations and round-trips data against a live Postgres). These catch a
// narrower but still useful class of mistake: a column silently dropped or renamed while
// refactoring, without needing a database to do it. No I/O — safe to run in every CI build.
describe("schema structure matches 06_DATA_ARCHITECTURE.md §6.2's ERD", () => {
  it("defines all eleven entities from the ERD", () => {
    const tableNames = [
      schema.fuelType,
      schema.station,
      schema.ingestionRun,
      schema.fuelPriceObservation,
      schema.dailyPriceRollup,
      schema.apiResponseJournal,
      schema.apiCallLedger,
      schema.appUser,
      schema.vehicleProfile,
      schema.priceAlert,
      schema.recommendationLog,
    ].map((table) => getTableName(table));

    expect(tableNames).toEqual([
      "fuel_type",
      "station",
      "ingestion_run",
      "fuel_price_observation",
      "daily_price_rollup",
      "api_response_journal",
      "api_call_ledger",
      "app_user",
      "vehicle_profile",
      "price_alert",
      "recommendation_log",
    ]);
  });

  it("stores prices as an integer column, never a float — §6.4's unit-drift argument", () => {
    const columns = getTableColumns(schema.fuelPriceObservation);
    expect(columns.priceTenthsCpl.dataType).toBe("number");
    expect(columns.priceTenthsCpl.columnType).toBe("PgInteger");
  });

  it("keeps source_reported_at and retrieved_at as two distinct columns — §6.4", () => {
    const columns = getTableColumns(schema.fuelPriceObservation);
    expect(columns.sourceReportedAt).toBeDefined();
    expect(columns.retrievedAt).toBeDefined();
    expect(columns.sourceReportedAt.name).not.toBe(columns.retrievedAt.name);
  });

  it("gives daily_price_rollup a composite primary key, not a surrogate id — §6.6", () => {
    const columns = getTableColumns(schema.dailyPriceRollup);
    expect(Object.keys(columns)).not.toContain("id");
    expect(columns.stationId.primary).toBeFalsy(); // primary-ness lives on the table's PK
    // constraint (added via the callback config), not on individual columns — this test
    // exists mainly to guard against someone "simplifying" the table back to a surrogate key.
  });
});
