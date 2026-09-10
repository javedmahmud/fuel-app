/**
 * One-off backfill, not part of the runtime app — `parseSuburbAndPostcodeFromAddress`
 * (`src/domain/station/parse-address.ts`) only runs against stations as they're upserted by the
 * `ref_data` job from this point forward; every station ingested *before* this shipped still has
 * `suburb`/`postcode` at their pre-existing value (`null`, for all of them — see that module's
 * comment for why). This derives both from each row's own already-stored `address_line` — no
 * Fuel API call, no quota spent, purely a local recompute over data already in Postgres.
 *
 * Safe to re-run any time (e.g. after a real improvement to the parser): recomputes every row
 * from its current `address_line` and overwrites, rather than only filling nulls — so a station
 * whose address later changes, or a parser fix that recovers more suburbs, is picked up the same
 * way. Run via `npm run db:backfill-station-address`.
 */
import { getDb } from "../src/infrastructure/db/client";
import { parseSuburbAndPostcodeFromAddress } from "../src/domain/station/parse-address";
import { station } from "../src/infrastructure/db/schema";
import { sql } from "drizzle-orm";

const BATCH_SIZE = 500; // same reasoning as station-repository.ts's own UPSERT_BATCH_SIZE

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function main() {
  const db = getDb();

  const rows = await db.select({ id: station.id, addressLine: station.addressLine }).from(station);
  console.log(`Loaded ${rows.length} stations.`);

  let suburbFilled = 0;
  let postcodeFilled = 0;
  let updated = 0;

  for (const batch of chunk(rows, BATCH_SIZE)) {
    const updates = batch.map((r) => {
      // addressLine is nullable in the schema, though every real row has one — a null address
      // has nothing to parse, so it's the same as any other unparseable address: both fields null.
      const { suburb, postcode } = r.addressLine
        ? parseSuburbAndPostcodeFromAddress(r.addressLine)
        : { suburb: null, postcode: null };
      if (suburb) suburbFilled++;
      if (postcode) postcodeFilled++;
      return { id: r.id, suburb, postcode };
    });

    // Single multi-row UPDATE per batch via a VALUES list, not one statement per station — the
    // same "batched, not per-row" lesson station-repository.ts's own comment already documents
    // (a per-row loop against the real ~3,300-station table was confirmed live to take over 30
    // minutes; this table is the same size).
    const values = sql.join(
      updates.map((u) => sql`(${u.id}::uuid, ${u.suburb}::text, ${u.postcode}::text)`),
      sql`, `,
    );
    await db.execute(sql`
      update ${station} as s
      set suburb = v.suburb, postcode = v.postcode
      from (values ${values}) as v(id, suburb, postcode)
      where s.id = v.id
    `);
    updated += batch.length;
    console.log(`Updated ${updated}/${rows.length}...`);
  }

  console.log(
    `Done. ${updated} rows updated; ${suburbFilled} got a suburb, ${postcodeFilled} got a postcode (of ${rows.length} total).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
