/**
 * §9.3's `litresRequired` return type is `litres | Unknown` — a dedicated sentinel, not `null`,
 * because `0` is itself a perfectly valid answer (a tank reported exactly full,
 * `currentFuelFraction = 1`), so a nullish "no answer" value would collide with a genuine zero.
 * A unique symbol makes `=== LITRES_UNKNOWN` the only way to check for it, which is also what
 * forces every caller to handle the unknown case explicitly rather than accidentally doing
 * arithmetic on it.
 */
export const LITRES_UNKNOWN = Symbol("litres_unknown");

export type LitresRequired = number | typeof LITRES_UNKNOWN;

export function isLitresKnown(value: LitresRequired): value is number {
  return value !== LITRES_UNKNOWN;
}
