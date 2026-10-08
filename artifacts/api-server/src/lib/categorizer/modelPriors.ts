// (AI-1) What the model is shown about the household's own history: up to 8
// "priors" per charge, each reduced to {categoryName, amount, weekday, source}.
// A prior is a charge a PERSON stood behind: their own filing (source `user`) or
// a suggestion they accepted, whose category the row still holds and that was
// never undone. Raw bank text never leaves this file — only the category name.
//
//   4 by exact merchant signature, newest first
//   3 by shared tokens (to_tsvector('simple', description) @@ plainto_tsquery),
//     last 12 months, ranked by how many of the charge's tokens they match
//   1 by amount, ±20 %, on the same account
import { and, desc, eq, gte, isNull, sql, or } from "drizzle-orm";
import { db, budgetCategoriesTable, categoryDecisionsTable, transactionsTable } from "@workspace/db";
import { addDaysISO, householdToday } from "@workspace/avalanche-core";
import { merchantSignature } from "../merchantNameExtract";
import type { PriorInput } from "../../ai/prompts/categorize.v1";
import { isOutflow } from "./stages/heuristic";
import type { EngineRow } from "./types";

export const PRIOR_WINDOW_DAYS = 365;
export const PRIORS_BY_SIGNATURE = 4;
export const PRIORS_BY_TOKENS = 3;
export const PRIORS_BY_AMOUNT = 1;
const POOL_LIMIT = 4000;
const AMOUNT_BAND = 0.2;
const MAX_TOKENS = 6;
const STOPWORDS = new Set([
  "the", "and", "pos", "debit", "credit", "card", "purchase", "payment", "pmt", "online", "inc", "llc", "co", "corp",
  "www", "com", "ach", "web", "ppd", "ccd", "pending", "recurring", "checkcard", "visa", "mastercard",
]);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export function weekdayOf(isoDate: string): string {
  return WEEKDAYS[new Date(`${isoDate.slice(0, 10)}T12:00:00Z`).getUTCDay()] ?? "Mon";
}

/** Word tokens of a merchant signature worth matching on: letters only, 3+ long, no noise words, at most 6. */
export function tokensOf(signature: string): string[] {
  const out: string[] = [];
  for (const t of signature.toLowerCase().split(/[^a-z]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t) && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

interface PoolRow {
  txnId: string;
  source: string;
  description: string;
  amount: number;
  occurredOn: string;
  plaidAccountId: string | null;
  categoryName: string;
  /** Negative = money out, whatever the bank source's own sign. */
  signed: number;
}

/** Only a person-backed, still-standing, not-undone decision counts as a prior. */
function backedByPerson() {
  return and(
    isNull(categoryDecisionsTable.undoneAt),
    sql`${categoryDecisionsTable.categoryId} IS NOT NULL`,
    sql`${transactionsTable.categoryId} = ${categoryDecisionsTable.categoryId}`,
    or(eq(categoryDecisionsTable.source, "user"), eq(categoryDecisionsTable.resolution, "accepted")),
  );
}

const poolColumns = {
  txnId: transactionsTable.id,
  source: categoryDecisionsTable.source,
  description: transactionsTable.description,
  amount: transactionsTable.amount,
  occurredOn: transactionsTable.occurredOn,
  plaidAccountId: transactionsTable.plaidAccountId,
  txnSource: transactionsTable.source,
  categoryName: budgetCategoriesTable.name,
};

function toPool(r: {
  txnId: string;
  source: string;
  description: string;
  amount: string;
  occurredOn: string;
  plaidAccountId: string | null;
  txnSource: string;
  categoryName: string;
}): PoolRow {
  const amount = Number(r.amount);
  const abs = Math.abs(amount);
  return { ...r, amount, signed: isOutflow({ amount: r.amount, source: r.txnSource }) ? -abs : abs };
}

const asPrior = (p: PoolRow): PriorInput => ({
  categoryName: p.categoryName,
  amount: p.signed,
  weekday: weekdayOf(p.occurredOn),
  source: p.source,
});

export async function loadPriors(
  householdId: string,
  rows: readonly EngineRow[],
  now: Date = new Date(),
): Promise<Map<string, PriorInput[]>> {
  const since = addDaysISO(householdToday(now), -PRIOR_WINDOW_DAYS);
  const pool = (
    await db
      .select(poolColumns)
      .from(categoryDecisionsTable)
      .innerJoin(transactionsTable, eq(transactionsTable.id, categoryDecisionsTable.transactionId))
      .innerJoin(budgetCategoriesTable, eq(budgetCategoriesTable.id, categoryDecisionsTable.categoryId))
      .where(
        and(
          eq(categoryDecisionsTable.householdId, householdId),
          eq(transactionsTable.householdId, householdId),
          eq(budgetCategoriesTable.householdId, householdId),
          gte(transactionsTable.occurredOn, since),
          backedByPerson(),
        ),
      )
      .orderBy(desc(transactionsTable.occurredOn), desc(categoryDecisionsTable.createdAt))
      .limit(POOL_LIMIT)
  ).map(toPool);
  // One prior per charge (the newest decision wins).
  const seen = new Set<string>();
  const unique = pool.filter((p) => (seen.has(p.txnId) ? false : (seen.add(p.txnId), true)));
  const bySignature = new Map<string, PoolRow[]>();
  for (const p of unique) {
    const sig = merchantSignature(p.description);
    if (!sig) continue;
    const list = bySignature.get(sig) ?? [];
    list.push(p);
    bySignature.set(sig, list);
  }

  const out = new Map<string, PriorInput[]>();
  for (const row of rows) {
    const taken = new Set<string>([row.id]);
    const picked: PoolRow[] = [];
    const take = (cands: readonly PoolRow[], n: number) => {
      let k = 0;
      for (const p of cands) {
        if (k >= n) break;
        if (taken.has(p.txnId)) continue;
        taken.add(p.txnId);
        picked.push(p);
        k += 1;
      }
    };
    const sig = merchantSignature(row.description);
    if (sig) take(bySignature.get(sig) ?? [], PRIORS_BY_SIGNATURE);

    const tokens = tokensOf(sig);
    if (tokens.length > 0) {
      const hits = sql<number>`(${sql.join(
        tokens.map(
          (t) => sql`(CASE WHEN to_tsvector('simple', ${transactionsTable.description}) @@ plainto_tsquery('simple', ${t}) THEN 1 ELSE 0 END)`,
        ),
        sql` + `,
      )})`;
      const matched = (
        await db
          .select({ ...poolColumns, hits })
          .from(categoryDecisionsTable)
          .innerJoin(transactionsTable, eq(transactionsTable.id, categoryDecisionsTable.transactionId))
          .innerJoin(budgetCategoriesTable, eq(budgetCategoriesTable.id, categoryDecisionsTable.categoryId))
          .where(
            and(
              eq(categoryDecisionsTable.householdId, householdId),
              eq(transactionsTable.householdId, householdId),
              eq(budgetCategoriesTable.householdId, householdId),
              gte(transactionsTable.occurredOn, since),
              backedByPerson(),
              sql`${hits} >= 1`,
            ),
          )
          .orderBy(desc(hits), desc(transactionsTable.occurredOn))
          .limit(40)
      ).map((r) => toPool(r));
      take(matched, PRIORS_BY_TOKENS);
    }

    const abs = Math.abs(Number(row.amount) || 0);
    if (abs > 0) {
      const lo = abs * (1 - AMOUNT_BAND);
      const hi = abs * (1 + AMOUNT_BAND);
      take(
        unique.filter(
          (p) =>
            p.plaidAccountId != null &&
            p.plaidAccountId === row.plaidAccountId &&
            Math.sign(p.signed) === (isOutflow(row) ? -1 : 1) &&
            Math.abs(p.amount) >= lo &&
            Math.abs(p.amount) <= hi,
        ),
        PRIORS_BY_AMOUNT,
      );
    }
    out.set(row.id, picked.map(asPrior));
  }
  return out;
}
