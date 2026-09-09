import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { RecommendationResult } from "../../domain/calculation/rank-candidates";
import { recommendationLog } from "../db/schema";

type WriteDb = Pick<PostgresJsDatabase, "insert">;

/**
 * `13_OBSERVABILITY_SECURITY_PRIVACY.md` §13.6: "persists `calculation_inputs`, `output_metrics`,
 * `reason_codes` and `engine_version` for every recommendation... makes any past recommendation
 * exactly reproducible." `calculationInputs` is whatever the caller actually passed to
 * `rankCandidates` (opaque here — this function doesn't know or care about the shape, it just
 * stores it), so a disputed or surprising recommendation can be replayed later against the
 * exact engine version that produced it.
 */
export async function persistRecommendation(
  db: WriteDb,
  args: {
    result: RecommendationResult;
    calculationInputs: unknown;
    userId?: string;
    sessionHash?: string;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(recommendationLog)
    .values({
      userId: args.userId,
      sessionHash: args.sessionHash,
      recommendedStationId: args.result.recommended.stationId,
      calculationInputs: args.calculationInputs,
      outputMetrics: args.result,
      reasonCodes: args.result.reasonCodes,
      engineVersion: args.result.engineVersion,
    })
    .returning({ id: recommendationLog.id });

  return row;
}
