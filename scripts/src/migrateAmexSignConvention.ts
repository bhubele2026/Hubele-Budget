/**
 * One-shot, idempotent migration (Task #130): normalize the sign on every
 * `source='amex'` transaction row to the canonical convention.
 *
 * Canonical convention (per `scripts/src/importApril2026Amex.ts` and
 * `artifacts/h2budget/src/pages/amex.tsx` monthTotals):
 *   - expense charges    => POSITIVE
 *   - payments / credits => NEGATIVE
 *
 * Pre-fix the workbook importer wrote the OPPOSITE: expenses negative,
 * payments/credits positive. To survive arbitrary mixes of canonical
 * (script-imported April rows) and pre-fix (workbook-imported May rows)
 * data without corrupting either, this migration classifies each row
 * INDIVIDUALLY by description and only flips rows whose stored sign
 * disagrees with the canonical convention for that classification.
 *
 * Classification mirrors `isPaymentOrCredit` in importApril2026Amex.ts.
 * Re-running this script after a successful migration is a no-op.
 */
import { sql } from "drizzle-orm";
import { db, pool, transactionsTable } from "@workspace/db";

// Same set used by importApril2026Amex.ts to recognize Amex payments / credits.
const PAYMENT_PATTERNS: RegExp[] = [
  /ONLINE PAYMENT - THANK YOU/i,
  /MOBILE PAYMENT - THANK YOU/i,
  /POINTS FOR STATEMENT CREDIT/i,
  /Platinum .* Credit/i,
];

function isPaymentOrCredit(description: string): boolean {
  return PAYMENT_PATTERNS.some((p) => p.test(description));
}

async function main() {
  const rows = await db
    .select({
      id: transactionsTable.id,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      occurredOn: transactionsTable.occurredOn,
    })
    .from(transactionsTable)
    .where(sql`${transactionsTable.source} = 'amex'`);

  console.log(`Inspecting ${rows.length} source='amex' rows...`);

  const toFlip: string[] = [];
  let alreadyCanonical = 0;
  let zeroAmount = 0;
  for (const r of rows) {
    const amt = Number(r.amount);
    if (amt === 0) {
      zeroAmount++;
      continue;
    }
    const isCredit = isPaymentOrCredit(r.description);
    // Canonical: credit => negative; expense => positive.
    const wantNegative = isCredit;
    const isNegative = amt < 0;
    if (wantNegative !== isNegative) {
      toFlip.push(r.id);
    } else {
      alreadyCanonical++;
    }
  }

  console.log(
    `Already canonical: ${alreadyCanonical}; zero-amount: ${zeroAmount}; need flip: ${toFlip.length}`,
  );

  if (toFlip.length === 0) {
    console.log("No rows need flipping. No-op.");
    await pool.end();
    return;
  }

  // Flip in chunks to keep the IN-list bounded.
  const CHUNK = 500;
  let flipped = 0;
  for (let i = 0; i < toFlip.length; i += CHUNK) {
    const ids = toFlip.slice(i, i + CHUNK);
    const result = await db
      .update(transactionsTable)
      .set({ amount: sql`${transactionsTable.amount} * -1` })
      .where(sql`${transactionsTable.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
      .returning({ id: transactionsTable.id });
    flipped += result.length;
  }
  console.log(`Flipped ${flipped} rows.`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
