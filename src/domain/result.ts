/**
 * `07_FUEL_API_INTEGRATION.md` §7.4: the Fuel API adapter "returns Result and never throws,
 * because upstream failure is a routine operating state here rather than an exception." Kept
 * in the domain layer since it's plain data with no I/O — used by the adapter and, later,
 * anything else that treats "the operation didn't work" as an expected outcome rather than a
 * bug.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
