import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, invalidateCachedToken } from "./token-manager";
import { performRequest } from "./http-client";

vi.mock("./http-client", () => ({
  performRequest: vi.fn(),
}));

// A small stateful fake standing in for the one row this module ever reads/writes —
// exercises the manager's own caching/refresh decisions without a real database.
function fakeTokenDb(initial?: { accessToken: string; updatedAt: Date; expiresAt: Date }) {
  let row = initial ? { id: "singleton", ...initial } : undefined;

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (v: typeof row) => ({
        onConflictDoUpdate: ({ set }: { set: Partial<NonNullable<typeof row>> }) => {
          row = row ? { ...row, ...set } : (v as NonNullable<typeof row>);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: () => {
        row = undefined;
        return Promise.resolve();
      },
    }),
    execute: () => Promise.resolve(), // pg_advisory_lock/unlock — no-op for a single-threaded test
  };
}

const mockedPerformRequest = vi.mocked(performRequest);

describe("getAccessToken", () => {
  beforeEach(() => {
    mockedPerformRequest.mockReset();
  });

  it("fetches a fresh token when the cache is empty, using GET (not POST) with Basic auth", async () => {
    mockedPerformRequest.mockResolvedValue({
      kind: "success",
      status: 200,
      bodyText: JSON.stringify({ access_token: "new-token", expires_in: 43_199 }),
      headers: new Headers(),
    });

    const db = fakeTokenDb();
    const result = await getAccessToken(db as never, {
      baseUrl: "https://api.onegov.nsw.gov.au",
      consumerKey: "key",
      consumerSecret: "secret",
      now: new Date("2026-09-06T00:00:00Z"),
    });

    expect(result).toEqual({ ok: true, value: "new-token" });
    expect(mockedPerformRequest).toHaveBeenCalledTimes(1);
    const [url, headers] = mockedPerformRequest.mock.calls[0];
    expect(url).toBe(
      "https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials",
    );
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("key:secret").toString("base64")}`);
  });

  it("returns the cached token without calling the API when well within its life", async () => {
    const db = fakeTokenDb({
      accessToken: "cached-token",
      updatedAt: new Date("2026-09-06T00:00:00Z"),
      expiresAt: new Date("2026-09-06T12:00:00Z"), // 12h life
    });

    // 1 hour in — nowhere near the 80% (9.6h) refresh threshold.
    const result = await getAccessToken(db as never, {
      baseUrl: "https://x",
      consumerKey: "k",
      consumerSecret: "s",
      now: new Date("2026-09-06T01:00:00Z"),
    });

    expect(result).toEqual({ ok: true, value: "cached-token" });
    expect(mockedPerformRequest).not.toHaveBeenCalled();
  });

  it("refreshes once past 80% of the token's life, not at literal expiry", async () => {
    mockedPerformRequest.mockResolvedValue({
      kind: "success",
      status: 200,
      bodyText: JSON.stringify({ access_token: "refreshed-token", expires_in: 43_199 }),
      headers: new Headers(),
    });

    const db = fakeTokenDb({
      accessToken: "stale-token",
      updatedAt: new Date("2026-09-06T00:00:00Z"),
      expiresAt: new Date("2026-09-06T12:00:00Z"), // 12h life -> refresh at 9.6h
    });

    // 10 hours in — past 80% (9.6h) but still 2h before literal expiry.
    const result = await getAccessToken(db as never, {
      baseUrl: "https://x",
      consumerKey: "k",
      consumerSecret: "s",
      now: new Date("2026-09-06T10:00:00Z"),
    });

    expect(result).toEqual({ ok: true, value: "refreshed-token" });
    expect(mockedPerformRequest).toHaveBeenCalledTimes(1);
  });

  it("propagates an auth_failed error on a non-200 response, without caching anything", async () => {
    mockedPerformRequest.mockResolvedValue({
      kind: "success",
      status: 401,
      bodyText: "invalid credentials",
      headers: new Headers(),
    });

    const db = fakeTokenDb();
    const result = await getAccessToken(db as never, {
      baseUrl: "https://x",
      consumerKey: "k",
      consumerSecret: "s",
      now: new Date(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("auth_failed");
  });

  it("returns a timeout error distinctly from auth_failed", async () => {
    mockedPerformRequest.mockResolvedValue({ kind: "timeout" });

    const result = await getAccessToken(fakeTokenDb() as never, {
      baseUrl: "https://x",
      consumerKey: "k",
      consumerSecret: "s",
      now: new Date(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("timeout");
  });
});

describe("invalidateCachedToken", () => {
  it("clears the cache so the next getAccessToken call re-authenticates", async () => {
    mockedPerformRequest.mockResolvedValue({
      kind: "success",
      status: 200,
      bodyText: JSON.stringify({ access_token: "brand-new-token", expires_in: 43_199 }),
      headers: new Headers(),
    });

    const db = fakeTokenDb({
      accessToken: "old-token",
      updatedAt: new Date("2026-09-06T00:00:00Z"),
      expiresAt: new Date("2026-09-06T12:00:00Z"),
    });

    await invalidateCachedToken(db as never);

    // Even though we're only 1h into what would have been a fresh 12h token, the cache is now
    // empty, so this must re-authenticate rather than returning the (deleted) cached value.
    const result = await getAccessToken(db as never, {
      baseUrl: "https://x",
      consumerKey: "k",
      consumerSecret: "s",
      now: new Date("2026-09-06T01:00:00Z"),
    });

    expect(result).toEqual({ ok: true, value: "brand-new-token" });
  });
});
