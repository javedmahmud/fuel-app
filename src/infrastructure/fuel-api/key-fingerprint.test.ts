import { describe, expect, it } from "vitest";
import { checkKeyEnvironmentConsistency, computeKeyFingerprint } from "./key-fingerprint";

describe("computeKeyFingerprint", () => {
  it("is deterministic — the same key always hashes the same way", () => {
    expect(computeKeyFingerprint("my-consumer-key")).toBe(computeKeyFingerprint("my-consumer-key"));
  });

  it("produces different hashes for different keys", () => {
    expect(computeKeyFingerprint("key-a")).not.toBe(computeKeyFingerprint("key-b"));
  });

  it("never returns the input verbatim — this exists specifically so the key itself is never stored", () => {
    const key = "super-secret-consumer-key";
    expect(computeKeyFingerprint(key)).not.toContain(key);
  });

  it("produces a 64-character hex string (SHA-256)", () => {
    expect(computeKeyFingerprint("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// A minimal fake mimicking Drizzle's .select().from().where().limit() chain — just enough
// surface for checkKeyEnvironmentConsistency's `Pick<PostgresJsDatabase, "select">` parameter,
// without needing a real database for what is fundamentally pure decision logic.
function fakeDb(rows: Array<{ environmentName: string | null }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  };
}

describe("checkKeyEnvironmentConsistency", () => {
  it("succeeds when no conflicting row is found (first-ever use of this key)", async () => {
    const result = await checkKeyEnvironmentConsistency(fakeDb([]) as never, "abc123", "staging");
    expect(result.ok).toBe(true);
  });

  it("refuses when the same fingerprint was previously recorded under a different environment", async () => {
    const result = await checkKeyEnvironmentConsistency(
      fakeDb([{ environmentName: "production" }]) as never,
      "abc123",
      "staging",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        type: "key_environment_mismatch",
        recordedEnvironment: "production",
        currentEnvironment: "staging",
      });
    }
  });
});
