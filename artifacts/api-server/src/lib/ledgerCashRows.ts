import { and, eq, gt, gte, lte } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import {
  addDaysISO,
  classifyCashRows,
  SUPERSEDE_MAX_DAYS,
  type CashAnchor,
  type CashRow,
  type CashRowsResult,
} from "@workspace/avalanche-core";
import { inForecastWhere } from "./forecastInclusion";

type TransactionRow = typeof transactionsTable.$inferSelect;

/**
 * ⭐ THE ROWS THE LEDGER READS — one WHERE for the ledger, "Why this number?" and
 * the Sync's reconciliation (PR4e). Moved verbatim from `buildForecastLedger`.
 *
 * With a snapshot: every row the forecast includes (`inForecastWhere`), dated
 * from SUPERSEDE_MAX_DAYS before the snapshot day through `upperISO`. The extra
 * days before the anchor find the pending half of a pair (PR4c); `isInSnapshot`
 * holds every row dated before the snapshot day, so they add nothing on their own.
 *
 * ⚠️ That lower bound is the ledger's, not a complete one: a pending row dated
 * before it can still change a pair after the anchor through pairing order (see
 * `classifyCashRows`). Every caller reads the same bound, so they agree with the
 * ledger — which is what they exist to do.
 *
 * Without a snapshot: forecast-flagged rows dated after today.
 */
export function ledgerActualRowsWhere(opts: {
  householdId: string;
  snapshotDay: string | null;
  todayISO: string;
  upperISO: string;
}) {
  const { householdId, snapshotDay, todayISO, upperISO } = opts;
  const anchorISO = snapshotDay ?? todayISO;
  return and(
    eq(transactionsTable.householdId, householdId),
    snapshotDay ? inForecastWhere(todayISO) : eq(transactionsTable.forecastFlag, true),
    snapshotDay
      ? gte(transactionsTable.occurredOn, addDaysISO(anchorISO, -SUPERSEDE_MAX_DAYS))
      : gt(transactionsTable.occurredOn, anchorISO),
    lte(transactionsTable.occurredOn, upperISO),
  );
}

/** A transactions row as the cash rule reads it. */
export function toCashRow(t: TransactionRow): CashRow {
  return {
    id: t.id,
    occurredOn: t.occurredOn,
    amount: Number(t.amount) || 0,
    createdAt: t.createdAt,
    // Stored as a string; an unparsable value is NaN, which the rule treats as no time.
    occurredAt: t.occurredAt ? new Date(t.occurredAt) : null,
    pending: !!t.pending,
    description: t.description ?? null,
    source: t.source ?? null,
    plaidAccountId: t.plaidAccountId ?? null,
    plaidTransactionId: t.plaidTransactionId ?? null,
  };
}

export type LedgerCashRows = CashRowsResult & {
  /**
   * `throughToday` over the rows with a Plaid account only: what the bank's own
   * feed can confirm. The Sync's reconciliation uses this (PR4e review) — see
   * `plaidSync` for why manual rows stay out of it.
   */
  plaidRowsThroughToday: { rowCount: number; net: number };
};

/**
 * What the ledger adds to `anchor` for cash today, row by row — for the
 * diagnostics that explain or test that figure against the bank.
 *
 * ⚠️ WHY THE ROWS REACH SUPERSEDE_MAX_DAYS PAST TODAY. A pending row dated today
 * is superseded by a posted row dated up to that many days later, so the outcome
 * of a row dated on or before today can depend on those rows. Later rows cannot
 * change it: posted rows pair in date order, and a posted row only replaces a
 * pending row dated at most SUPERSEDE_MAX_DAYS before it. The query is otherwise
 * the ledger's (same lower bound, same filters), and the ledger reads through its
 * window's end — for the 90-day horizon the spine and the explain route use, past
 * this bound — so `throughToday` is exactly what their `bankToday` adds.
 */
export async function classifyLedgerRowsThroughToday(opts: {
  householdId: string;
  anchor: CashAnchor;
  accountExternalId: string | null;
  todayISO: string;
}): Promise<LedgerCashRows> {
  const { householdId, anchor, accountExternalId, todayISO } = opts;
  const rows = await db
    .select()
    .from(transactionsTable)
    .where(
      ledgerActualRowsWhere({
        householdId,
        snapshotDay: anchor.day,
        todayISO,
        upperISO: addDaysISO(todayISO, SUPERSEDE_MAX_DAYS),
      }),
    );
  const cashRows = rows.map(toCashRow);
  const result = classifyCashRows(cashRows, { anchor, accountExternalId, todayISO });
  // Outcomes come back in input order. A manual row never pairs and never shares
  // a Plaid id, so leaving it out moves no other row's outcome.
  let rowCount = 0;
  let net = 0;
  result.rows.forEach((o, i) => {
    if (o.counts && o.occurredOn <= todayISO && cashRows[i]!.plaidAccountId) {
      rowCount += 1;
      net += o.contribution;
    }
  });
  return { ...result, plaidRowsThroughToday: { rowCount, net } };
}
