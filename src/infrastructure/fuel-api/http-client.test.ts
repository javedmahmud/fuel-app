import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthedHeaders, calculateBackoffDelayMs, performRequest } from "./http-client";

describe("buildAuthedHeaders", () => {
  it("includes exactly the four undocumented-but-required headers from §7.1/§21.2", () => {
    const headers = buildAuthedHeaders("token123", "key456", new Date("2026-08-26T09:05:17Z"));
    expect(headers).toEqual({
      Authorization: "Bearer token123",
      apikey: "key456",
      transactionID: expect.stringMatching(/^[0-9a-f-]{36}$/),
      requestTimeStamp: "26/08/2026 07:05:17 PM",
    });
  });

  it("generates a different transactionID on every call", () => {
    const now = new Date();
    const h1 = buildAuthedHeaders("t", "k", now);
    const h2 = buildAuthedHeaders("t", "k", now);
    expect(h1.transactionID).not.toBe(h2.transactionID);
  });
});

describe("calculateBackoffDelayMs", () => {
  it("stays within [0, base * 2^attempt] for early attempts", () => {
    const delay = calculateBackoffDelayMs(0, { baseMs: 500, random: () => 0.5 });
    expect(delay).toBe(250); // 0.5 * (500 * 2^0)
  });

  it("doubles the exponential ceiling per attempt", () => {
    expect(calculateBackoffDelayMs(1, { baseMs: 500, random: () => 1 })).toBe(1000); // 500*2^1
    expect(calculateBackoffDelayMs(2, { baseMs: 500, random: () => 1 })).toBe(2000); // 500*2^2
  });

  it("respects the cap rather than growing unbounded", () => {
    expect(calculateBackoffDelayMs(10, { baseMs: 500, capMs: 8000, random: () => 1 })).toBe(8000);
  });

  it("returns 0 when random() returns 0 — full jitter can genuinely be zero delay", () => {
    expect(calculateBackoffDelayMs(3, { random: () => 0 })).toBe(0);
  });
});

describe("performRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a success outcome with status and body on a normal response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("hello world", { status: 200 })));

    const result = await performRequest("https://example.test/x", { foo: "bar" });
    expect(result).toEqual({
      kind: "success",
      status: 200,
      bodyText: "hello world",
      headers: expect.any(Headers),
    });
  });

  it("returns a network_error outcome when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));

    const result = await performRequest("https://example.test/x", {});
    expect(result).toEqual({ kind: "network_error", message: "getaddrinfo ENOTFOUND" });
  });

  it("returns a timeout outcome when the request is aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const abortError = new Error("This operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        });
      }),
    );

    // A tiny explicit timeout — no need to wait out the real 35s default to prove the abort path.
    const result = await performRequest("https://example.test/x", {}, 10);
    expect(result).toEqual({ kind: "timeout" });
  });
});
