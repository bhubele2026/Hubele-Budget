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

/**
 * What the ledger adds to `anchor` for cash today, row by row — for the
 * diagnostics that explain or test that figure against the bank.
 *
 * ⚠️ WHY THE ROWS REACH SUPERSEDE_MAX_DAYS PAST TODAY. A pending row dated today
 * is superseded by a posted row dated up to that many days later, so the outcome
 * of every row dated on or before today is final only once those rows are in.
 * Later rows cannot change it: posted rows pair in date order, and a posted row
 * only replaces a pending row dated at most SUPERSEDE_MAX_DAYS before it. The
 * ledger reads through its window's end, which for the 90-day horizon the spine
 * and the explain route use is past this bound, so `throughToday` is exactly what
 * their `bankToday` adds.
 */
export async function classifyLedgerRowsThroughToday(opts: {
  householdId: string;
  anchor: CashAnchor;
  accountExternalId: string | null;
  todayISO: string;
}): Promise<CashRowsResult> {
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
  return classifyCashRows(rows.map(toCashRow), { anchor, accountExternalId, todayISO });
}
