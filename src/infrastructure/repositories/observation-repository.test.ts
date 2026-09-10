import { describe, expect, it, vi } from "vitest";
import { insertObservationsIdempotent } from "./observation-repository";

describe("insertObservationsIdempotent", () => {
  it("returns zero counts without touching the database for an empty batch", async () => {
    const db = { insert: vi.fn() };
    const result = await insertObservationsIdempotent(db as never, []);
    expect(result).toEqual({ insertedCount: 0, duplicateCount: 0 });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
