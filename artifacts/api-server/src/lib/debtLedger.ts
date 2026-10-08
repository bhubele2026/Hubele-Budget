import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  debtLedgerEventsTable,
  debtStatementsTable,
  debtsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, classifyLiabilityRow } from "@workspace/avalanche-core";
import { householdTodayISO } from "./householdClock";
import { logger } from "./logger";

/**
 * (PR-D) THE LIABILITY LEDGER. Every posted row on a debt's own account — a
 * credit card or loan Plaid feeds us (`plaid_accounts.type` credit/loan, linked
 * to a debt), or a legacy workbook `amex` row when a manual Amex debt exists —
 * becomes one `debt_ledger_events` row: interest, fee, payment, charge or
 * credit (`classifyLiabilityRow`). Idempotent on `transaction_id`: re-running
 * rewrites the same event; a row whose amount became 0 loses its event; a
 * deleted transaction takes its event with it (FK cascade).
 *
 * Pending rows are skipped: a pending charge is replaced by its posted row, and
 * counting both would double the new charges.
 *
 * Called with the synced ids at the end of every Plaid sync
 * (`afterPlaidSyncDebtPass`) and over a window by `POST /debt-plan/reconcile`.
 */
export const LEDGER_RECONCILE_DAYS = 120;

const AMEX_NAME = /(amex|american\s*express)/i;

type LiabilityScope = {
  /** External Plaid account id → the debt it is linked to. */
  debtByExternalAccount: Map<string, string>;
  /** A manual (not Plaid-linked) Amex debt for workbook `amex` rows, if any. */
  amexManualDebtId: string | null;
};

async function loadLiabilityScope(householdId: string): Promise<LiabilityScope> {
  const [accts, debts] = await Promise.all([
    db
      .select({ id: plaidAccountsTable.id, accountId: plaidAccountsTable.accountId })
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.householdId, householdId),
          inArray(plaidAccountsTable.type, ["credit", "loan"]),
        ),
      ),
    db
      .select({ id: debtsTable.id, name: debtsTable.name, plaidAccountId: debtsTable.plaidAccountId })
      .from(debtsTable)
      .where(eq(debtsTable.householdId, householdId)),
  ]);
  const debtByInternal = new Map<string, string>();
  for (const d of debts) if (d.plaidAccountId) debtByInternal.set(d.plaidAccountId, d.id);
  const debtByExternalAccount = new Map<string, string>();
  for (const a of accts) {
    const debtId = debtByInternal.get(a.id);
    if (debtId) debtByExternalAccount.set(a.accountId, debtId);
  }
  // Workbook rows carry no account. They belong to a debt only when the
  // household tracks Amex as a MANUAL debt — never to a Plaid-linked card,
  // whose own feed already lands here.
  const amexManual = debts
    .filter((d) => !d.plaidAccountId && AMEX_NAME.test(d.name))
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  return { debtByExternalAccount, amexManualDebtId: amexManual?.id ?? null };
}

export async function syncDebtLedgerEvents(
  householdId: string,
  opts: { plaidTransactionIds?: readonly string[]; sinceISO?: string } = {},
): Promise<{ written: number; cleared: number }> {
  if (opts.plaidTransactionIds && opts.plaidTransactionIds.length === 0) {
    return { written: 0, cleared: 0 };
  }
  const scope = await loadLiabilityScope(householdId);
  const extIds = [...scope.debtByExternalAccount.keys()];
  if (extIds.length === 0 && !scope.amexManualDebtId) return { written: 0, cleared: 0 };

  const t = transactionsTable;
  const onLiability = or(
    extIds.length > 0 ? inArray(t.plaidAccountId, extIds) : sql`false`,
    scope.amexManualDebtId ? and(eq(t.source, "amex"), isNull(t.plaidAccountId)) : sql`false`,
  );
  const window = opts.plaidTransactionIds
    ? inArray(t.plaidTransactionId, [...opts.plaidTransactionIds])
    : gte(t.occurredOn, opts.sinceISO ?? addDaysISO(householdTodayISO(), -LEDGER_RECONCILE_DAYS));
  const rows = await db
    .select({
      id: t.id,
      occurredOn: t.occurredOn,
      amount: t.amount,
      source: t.source,
      description: t.description,
      pfcPrimary: t.pfcPrimary,
      pfcDetailed: t.pfcDetailed,
      isExternalCardPayment: t.isExternalCardPayment,
      plaidAccountId: t.plaidAccountId,
    })
    .from(t)
    .where(and(eq(t.householdId, householdId), eq(t.pending, false), onLiability, window));

  const values: Array<typeof debtLedgerEventsTable.$inferInsert> = [];
  const zeroIds: string[] = [];
  for (const r of rows) {
    const debtId = r.plaidAccountId
      ? scope.debtByExternalAccount.get(r.plaidAccountId)
      : scope.amexManualDebtId;
    if (!debtId) continue;
    const c = classifyLiabilityRow(r);
    if (!c) {
      zeroIds.push(r.id);
      continue;
    }
    values.push({
      householdId,
      debtId,
      transactionId: r.id,
      kind: c.kind,
      amount: c.amount.toFixed(2),
      occurredOn: r.occurredOn,
    });
  }
  for (let i = 0; i < values.length; i += 500) {
    await db
      .insert(debtLedgerEventsTable)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: debtLedgerEventsTable.transactionId,
        targetWhere: sql`${debtLedgerEventsTable.transactionId} IS NOT NULL`,
        set: {
          debtId: sql`excluded.debt_id`,
          kind: sql`excluded.kind`,
          amount: sql`excluded.amount`,
          occurredOn: sql`excluded.occurred_on`,
        },
      });
  }
  if (zeroIds.length > 0) {
    await db
      .delete(debtLedgerEventsTable)
      .where(
        and(
          eq(debtLedgerEventsTable.householdId, householdId),
          inArray(debtLedgerEventsTable.transactionId, zeroIds),
        ),
      );
  }
  return { written: values.length, cleared: zeroIds.length };
}

/** A statement as Plaid's /liabilities/get reports it for one account. */
export type StatementFact = {
  /** External Plaid account id. */
  accountId: string;
  statementDate: string | null | undefined;
  statementBalance: number | null | undefined;
  minPayment: number | null | undefined;
  dueDate: string | null | undefined;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/**
 * (PR-D) Statement facts land in `debt_statements` when the liabilities fetch
 * runs: one row per debt per statement date, upserted (a re-fetch of the same
 * statement rewrites it). Only accounts linked to a debt, only facts with a
 * statement date. Best-effort: a failure is logged and never breaks the fetch.
 */
export async function recordDebtStatements(
  householdId: string,
  facts: readonly StatementFact[],
): Promise<number> {
  try {
    const usable = facts.filter((f) => typeof f.statementDate === "string" && ISO_DAY.test(f.statementDate));
    if (usable.length === 0) return 0;
    const scope = await loadLiabilityScope(householdId);
    const values: Array<typeof debtStatementsTable.$inferInsert> = [];
    for (const f of usable) {
      const debtId = scope.debtByExternalAccount.get(f.accountId);
      if (!debtId) continue;
      const num = (n: number | null | undefined) =>
        n == null || !Number.isFinite(Number(n)) ? null : Number(n).toFixed(2);
      values.push({
        householdId,
        debtId,
        statementDate: f.statementDate!.slice(0, 10),
        statementBalance: num(f.statementBalance),
        minPayment: num(f.minPayment),
        dueDate: typeof f.dueDate === "string" && ISO_DAY.test(f.dueDate) ? f.dueDate.slice(0, 10) : null,
        source: "plaid",
      });
    }
    if (values.length === 0) return 0;
    await db
      .insert(debtStatementsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [debtStatementsTable.debtId, debtStatementsTable.statementDate],
        set: {
          statementBalance: sql`excluded.statement_balance`,
          minPayment: sql`excluded.min_payment`,
          dueDate: sql`excluded.due_date`,
          source: sql`excluded.source`,
        },
      });
    return values.length;
  } catch (err) {
    logger.error({ err, householdId }, "[debt-plan] recording statement facts failed");
    return 0;
  }
}
