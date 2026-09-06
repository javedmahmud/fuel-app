import { randomUUID } from "node:crypto";
import { buildRequestTimeStamp } from "./timestamps";

const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 30_000; // §21.2 — measured ~800ms for 1.79MB; this is headroom, not a tight bound.

/** Every subsequent call's headers, beyond the bearer token — §7.1/§21.2, both undocumented,
 * both discovered from the API's own `400 HeadersError` response body. */
export function buildAuthedHeaders(
  accessToken: string,
  consumerKey: string,
  now: Date,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    apikey: consumerKey,
    transactionID: randomUUID(),
    requestTimeStamp: buildRequestTimeStamp(now),
  };
}

/**
 * Full-jitter backoff — `random(0, min(cap, base * 2^attempt))`, §7.8. Plain exponential
 * backoff synchronises retries across concurrent callers; jitter prevents that thundering herd
 * on recovery. `attempt` is 0-indexed (first retry = attempt 0). `random` is injectable so this
 * stays deterministic in tests rather than actually being flaky-by-design.
 */
export function calculateBackoffDelayMs(
  attempt: number,
  {
    baseMs = 500,
    capMs = 8_000,
    random = Math.random,
  }: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(random() * exponential);
}

export type RawHttpOutcome =
  | { kind: "success"; status: number; bodyText: string; headers: Headers }
  | { kind: "timeout" }
  | { kind: "network_error"; message: string };

/**
 * A single HTTP attempt — no retry logic here, that's the caller's job (§7.8's table needs
 * different retry behaviour per failure category, which only the caller knows how to apply).
 * This function's only responsibility is: make the call, enforce the timeout, and hand back a
 * result that never throws for anything the network itself can produce.
 */
export async function performRequest(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = CONNECT_TIMEOUT_MS + RESPONSE_TIMEOUT_MS,
): Promise<RawHttpOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const bodyText = await response.text();
    return { kind: "success", status: response.status, bodyText, headers: response.headers };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "timeout" };
    }
    return {
      kind: "network_error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
