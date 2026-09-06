import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { apiResponseJournal } from "../db/schema";

/**
 * The single most important write in the whole system — `04_ARCHITECTURE_SUMMARY.md` §4.4.
 * Commits the raw response body **before** any parsing that could fail, because `/prices/new`'s
 * server-side watermark advances the instant NSW returns a response, regardless of what happens
 * to it afterward (confirmed, spike Test 3c — `07_FUEL_API_INTEGRATION.md` §21.2). Everything
 * downstream of this call can fail and be retried offline; nothing before it can be recovered.
 */
export async function journalRawResponse(
  db: Pick<PostgresJsDatabase, "insert">,
  params: {
    ingestionRunId: string;
    endpoint: string;
    httpStatus: number;
    rawBody: string;
    now: Date;
  },
): Promise<string> {
  const [row] = await db
    .insert(apiResponseJournal)
    .values({
      ingestionRunId: params.ingestionRunId,
      endpoint: params.endpoint,
      httpStatus: params.httpStatus,
      rawBody: Buffer.from(params.rawBody, "utf8"),
      status: "unprocessed",
      receivedAt: params.now,
    })
    .returning({ id: apiResponseJournal.id });
  return String(row.id);
}

/**
 * Marks a journal row `processed` once parsing/validation genuinely succeeded, or `unparsed`
 * (with a reason, kept forever — §6.8's retention table) when it didn't. An `unparsed` row is
 * the *only copy* of that consumed window; it's never auto-pruned and is retried offline once
 * whatever broke the parser is fixed.
 */
export async function markJournalOutcome(
  db: Pick<PostgresJsDatabase, "update">,
  journalId: string,
  outcome: { status: "processed" | "unparsed"; failureReason?: string; now: Date },
): Promise<void> {
  await db
    .update(apiResponseJournal)
    .set({
      status: outcome.status,
      processedAt: outcome.now,
      failureReason: outcome.failureReason,
    })
    .where(eq(apiResponseJournal.id, BigInt(journalId)));
}
