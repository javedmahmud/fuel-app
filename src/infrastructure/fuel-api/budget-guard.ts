import { count, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { apiCallLedger } from "../db/schema";
import { err, ok, type Result } from "../../domain/result";
import type { FuelApiError } from "./types";

/** `07_FUEL_API_INTEGRATION.md` §7.7. */
export const HARD_MONTHLY_LIMIT = 2500;
export const SAFETY_RESERVE = 250;
export const USABLE_BUDGET = HARD_MONTHLY_LIMIT - SAFETY_RESERVE; // 2250

/** Pace check tolerance — §7.7: "refuse non-essential jobs if month-to-date exceeds linear
 * pro-rata by more than 20%... catches runaway consumption on day 6 rather than on day 27." */
const PACE_TOLERANCE = 1.2;

export interface BudgetCheckOutcome {
  /** True when month-to-date usage is already running hot relative to a straight-line pace,
   * even though this particular call was allowed through (because it was marked essential).
   * Surfaced so the caller can alarm on it — the budget guard itself doesn't own alerting. */
  paceExceeded: boolean;
}

/** `"YYYY-MM"` for the given instant — the ledger's `billing_month` column, and this module's
 * unit for "how much have we spent this month." */
export function billingMonthFor(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(now: Date): number {
  // Day 0 of "next month" is the last day of the current month.
  return new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
}

/**
 * Two independent checks before every call, per §7.7 — **absolute** (refuse outright at
 * `USABLE_BUDGET`) and **pace** (refuse non-essential jobs running hot relative to a
 * straight-line monthly rate). `essential` is the caller's call, not this module's — a future
 * job orchestrator decides which job types can proceed even while paced (e.g. `new_prices`,
 * since missing it risks a genuinely lost price window under at-most-once delivery) versus
 * which can simply wait (e.g. `ref_data`).
 */
export async function checkBudget(
  db: Pick<PostgresJsDatabase, "select">,
  now: Date,
  essential: boolean,
): Promise<Result<BudgetCheckOutcome, FuelApiError>> {
  const billingMonth = billingMonthFor(now);

  const rows = await db
    .select({ n: count() })
    .from(apiCallLedger)
    .where(eq(apiCallLedger.billingMonth, billingMonth));
  const monthToDateCalls = rows[0]?.n ?? 0;

  if (monthToDateCalls >= USABLE_BUDGET) {
    return err({ type: "budget_exceeded" });
  }

  const dayOfMonth = now.getUTCDate();
  const proRataExpected = (dayOfMonth / daysInMonth(now)) * USABLE_BUDGET;
  const paceExceeded = monthToDateCalls > proRataExpected * PACE_TOLERANCE;

  if (paceExceeded && !essential) {
    return err({ type: "budget_exceeded" });
  }

  return ok({ paceExceeded });
}

/**
 * Ledgers a call **before** it's made (§7.7 — "a crash mid-call cannot lose the record and
 * under-count"). Returns the row id so the caller can fill in `httpStatus`/`durationMs` once
 * the call actually completes — see `recordCallOutcome`.
 */
export async function ledgerCallBeforeRequest(
  db: Pick<PostgresJsDatabase, "insert">,
  params: { ingestionRunId: string; endpoint: string; now: Date },
): Promise<string> {
  const [row] = await db
    .insert(apiCallLedger)
    .values({
      ingestionRunId: params.ingestionRunId,
      endpoint: params.endpoint,
      calledAt: params.now,
      billingMonth: billingMonthFor(params.now),
    })
    .returning({ id: apiCallLedger.id });
  return String(row.id);
}

/** Fills in `httpStatus`/`durationMs` once the ledgered call actually completes — these start
 * `null` (§7.7's before-the-call insert can't know them yet) and are worth recording once known
 * purely for diagnostics; the budget guard's own counting logic never depends on them. */
export async function recordCallOutcome(
  db: Pick<PostgresJsDatabase, "update">,
  ledgerId: string,
  /** `httpStatus` is `undefined` for a timeout or network error — the request never completed
   * with a real status, and `0` would misleadingly look like a meaningful value later. */
  outcome: { httpStatus?: number; durationMs: number },
): Promise<void> {
  await db
    .update(apiCallLedger)
    .set({ httpStatus: outcome.httpStatus ?? null, durationMs: outcome.durationMs })
    .where(eq(apiCallLedger.id, BigInt(ledgerId)));
}
