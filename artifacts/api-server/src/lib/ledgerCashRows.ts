import { and, eq, gt, gte, lt, lte } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import {
  addDaysISO,
  classifyCashRows,
  isBankRow,
  REVERSAL_MAX_DAYS,
  SUPERSEDE_MAX_DAYS,
  type CashAnchor,
  type CashRow,
  type CashRowsResult,
} from "@workspace/avalanche-core";
import { inForecastWhere } from "./forecastInclusion";
import { expiredHoldsRuleOn } from "./supersededPending";

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

/**
 * ⭐ (F6 round 4) THE ROWS BEFORE THE LEDGER'S LOWER EDGE THAT CAN HOLD A
 * REVERSAL'S HOLD — `classifyCashRows`' `priorRows`.
 *
 * A pending credit reverses an expired hold dated up to REVERSAL_MAX_DAYS
 * before it, so the hold of a reversal the ledger reads can sit before the
 * ledger's lower edge (anchor day − SUPERSEDE_MAX_DAYS). Such a hold is dated
 * before the anchor day — held — so its reversal is the money coming back and
 * counts. These are the snapshot account's rows from REVERSAL_MAX_DAYS before
 * that edge up to it (pending and posted: a posted row tells which pending row
 * it replaced, which is then no hold).
 *
 * Read only when they can change an outcome: the rule is on (`ruleOn`), there
 * is an anchor and an account, and some row the ledger read is a pending credit
 * on that account dated after the anchor day (only a credit is a reversal, and
 * one dated on or before the anchor day is held whatever it pairs with).
 * Otherwise none, and no query — the usual case.
 */
export async function readReversalHoldRows(opts: {
  householdId: string;
  anchorDay: string | null;
  accountExternalId: string | null;
  todayISO: string;
  rows: readonly CashRow[];
  ruleOn: boolean;
}): Promise<CashRow[]> {
  const { householdId, anchorDay, accountExternalId, todayISO, rows } = opts;
  if (!opts.ruleOn || !anchorDay || !accountExternalId) return [];
  const needed = rows.some(
    (r) => r.pending && r.amount > 0 && r.occurredOn > anchorDay && isBankRow(r.source, r.plaidAccountId, accountExternalId),
  );
  if (!needed) return [];
  const edge = addDaysISO(anchorDay, -SUPERSEDE_MAX_DAYS);
  const prior = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.plaidAccountId, accountExternalId),
        inForecastWhere(todayISO),
        gte(transactionsTable.occurredOn, addDaysISO(edge, -REVERSAL_MAX_DAYS)),
        lt(transactionsTable.occurredOn, edge),
      ),
    );
  return prior.map(toCashRow);
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
    // (PR-D) A logged payment a bank row confirmed adds 0: the bank row counts.
    claimConfirmed: t.paymentState === "confirmed" && !!t.confirmedByTxnId,
    // (F6 round 5) What the row says about itself: a payment or a transfer is never a hold's reversal.
    isTransfer: t.isTransfer,
    debtId: t.debtId,
    isExternalCardPayment: t.isExternalCardPayment,
    pfcPrimary: t.pfcPrimary,
    pfcDetailed: t.pfcDetailed,
  };
}

export type LedgerCashRows = CashRowsResult & {
  /**
   * `throughToday` over the rows with a Plaid account only: what the bank's own
   * feed can confirm. The Sync's reconciliation uses this (PR4e review) — see
   * `plaidSync` for why manual rows stay out of it.
   */
  plaidRowsThroughToday: { rowCount: number; net: number };
  /**
   * (Task 4, D) The rows the rule read, in the order of `rows` (`rows[i]` is
   * `read[i]`'s verdict): what "Why this number?" lists beside each verdict.
   * Read only — never classified again.
   */
  read: CashRow[];
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
  const ruleOn = expiredHoldsRuleOn();
  // (F6 round 4) The holds before the lower edge a reversal here can pair with — the ledger's own read.
  const priorRows = await readReversalHoldRows({ householdId, anchorDay: anchor.day, accountExternalId, todayISO, rows: cashRows, ruleOn });
  const result = classifyCashRows(cashRows, { anchor, accountExternalId, todayISO, expiredHolds: ruleOn, priorRows });
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
  return { ...result, plaidRowsThroughToday: { rowCount, net }, read: cashRows };
}
