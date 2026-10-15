// ⭐ (F3) THE BANK BALANCE CHECK — server side.
//
// A manual Sync (`plaidSync`) reads the forecast checking account's balance and
// calls `checkBankBalanceOnSync`; the banking review calls `readBankBalanceCheck`.
// The arithmetic is avalanche-core's (`bankCheckLedger`, `bankBalanceCheckOf`);
// this file reads rows and stores the answer.
//
// What is stored (`forecast_settings.last_bank_reconciliation`,
// `BankBalanceCheckRecord`): the previous anchor (balance, when, its field, the
// deposits pending at its read), the bank's figure compared (balance, when,
// field), H2's predicted figure, bank − H2, ties / drift — or not_checked with
// its reason (`anchor_too_old`, `balance_unavailable`) instead of nothing — and
// the last earlier drift, which a re-anchoring Sync would otherwise lose.
//
// ⚠️ The forecast curve and the spine's roll-forward never read this: the
// comparison's own rules (pending deposits; see bankCheck.ts) apply here only.
// `classifyCashRows` and `ledgerActualRowsWhere` are reused unchanged.
//
// ⚠️ READ-TIME RECOMPUTE: one query over the rows, no Plaid call.

import { eq, sql } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  transactionsTable,
  type BankBalanceCheckRecord,
  type BankCheckIdList,
} from "@workspace/db";
import {
  BANK_CHECK_MAX_IDS,
  SUPERSEDE_MAX_DAYS,
  addDaysISO,
  bankBalanceCheckOf,
  bankCheckLedger,
  classifyCashRows,
  type BankBalanceCheck,
  type BankBalanceField,
  type BankCheckIds,
  type BankCheckLedger,
} from "@workspace/avalanche-core";
import { ledgerActualRowsWhere, readReversalHoldRows, toCashRow } from "./ledgerCashRows";
import { expiredHoldsRuleOn } from "./supersededPending";
import { anchorIsReconcilable, reconcileBankBalance } from "./reconcileBankBalance";
import { householdDayOf, householdTodayISO } from "./householdClock";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const money = (n: number): string => round2(n).toFixed(2);

/** A check's ids, kept when there are few enough to list (null otherwise). */
function idList(x: BankCheckIds): BankCheckIdList | null {
  return x.ids.length > BANK_CHECK_MAX_IDS ? null : { ids: x.ids, amount: money(x.amount) };
}

export type BankCheckLedgerRead = BankCheckLedger & { predicted: number };

/**
 * The database's clock. `created_at` is stamped by it, so whether a row reached
 * the ledger after the check (a late row) is judged on the same clock — the app
 * server's clock can trail it by a few milliseconds, which would mark the Sync's
 * own last rows as late.
 */
async function databaseNow(): Promise<Date> {
  try {
    const r = await db.execute(sql`select (extract(epoch from now()) * 1000)::float8 as ms`);
    const ms = Number((r as unknown as { rows?: Array<{ ms: unknown }> }).rows?.[0]?.ms);
    return Number.isFinite(ms) ? new Date(ms) : new Date();
  } catch {
    return new Date();
  }
}

/**
 * The ledger's side of a check: the rows the ledger reads from `prevAnchor`
 * (`ledgerActualRowsWhere`, through the check's day + SUPERSEDE_MAX_DAYS so a
 * pending row's posted half is among them), classified by the cash rule from
 * that anchor, then `bankCheckLedger`. ONE query.
 *
 * At the check itself (`checkDay` = today) this reads exactly the rows
 * `classifyLedgerRowsThroughToday` reads. At a later recompute the WHERE takes
 * today's date (as the ledger does now), so a posted row dated after the check's
 * day still pairs with its pending half.
 */
export async function readBankCheckLedger(opts: {
  householdId: string;
  accountExternalId: string;
  prevAnchor: { balance: number; at: Date };
  checkDay: string;
  checkAt: Date;
  bankField: BankBalanceField;
  excludedIds?: ReadonlySet<string> | null;
  anchorPendingDepositIds?: ReadonlySet<string> | null;
  addedIds?: ReadonlySet<string> | null;
  todayISO?: string;
}): Promise<BankCheckLedgerRead> {
  const anchorDay = householdDayOf(opts.prevAnchor.at);
  const todayISO = opts.todayISO ?? householdTodayISO();
  const rows = await db
    .select()
    .from(transactionsTable)
    .where(
      ledgerActualRowsWhere({
        householdId: opts.householdId,
        snapshotDay: anchorDay,
        todayISO: todayISO < opts.checkDay ? opts.checkDay : todayISO,
        upperISO: addDaysISO(opts.checkDay, SUPERSEDE_MAX_DAYS),
      }),
    );
  const cashRows = rows.map(toCashRow);
  const ruleOn = expiredHoldsRuleOn();
  const { rows: outcomes } = classifyCashRows(cashRows, {
    anchor: { at: opts.prevAnchor.at, day: anchorDay },
    accountExternalId: opts.accountExternalId,
    todayISO: opts.checkDay,
    // (F6 round 3) An expired hold at the check's day counts nowhere (kill switch: `EXPIRED_HOLDS_RULE=off`).
    expiredHolds: ruleOn,
    // (F6 round 4) A reversal's hold before the lower edge (a second query only when one can matter).
    priorRows: await readReversalHoldRows({
      householdId: opts.householdId,
      anchorDay,
      accountExternalId: opts.accountExternalId,
      todayISO: todayISO < opts.checkDay ? opts.checkDay : todayISO,
      rows: cashRows,
      ruleOn,
    }),
  });
  const ledger = bankCheckLedger({
    rows: cashRows,
    outcomes,
    accountExternalId: opts.accountExternalId,
    checkDay: opts.checkDay,
    checkAt: opts.checkAt,
    bankField: opts.bankField,
    excludedIds: opts.excludedIds ?? null,
    anchorPendingDepositIds: opts.anchorPendingDepositIds ?? null,
    addedIds: opts.addedIds ?? null,
  });
  return { ...ledger, predicted: round2(opts.prevAnchor.balance + ledger.net) };
}

/** What the Sync read from Plaid for the account (both fields), and the anchor it wrote. */
export interface BankBalanceRead {
  available: number | null;
  current: number | null;
  /** The instant the anchor was written (`bank_snapshot_at`). */
  at: Date;
  /** The field the anchor took (`available ?? current`). */
  anchorField: BankBalanceField;
}

type Logger = {
  warn: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
};

/** The last earlier drift a new record keeps (from the record it replaces). */
function carriedDrift(previous: BankBalanceCheckRecord | null): BankBalanceCheckRecord["lastDrift"] {
  if (!previous) return null;
  if (previous.status === "drift") {
    return {
      checkedAt: previous.checkedAt,
      accountId: previous.accountId,
      unexplained: previous.unexplained,
      bank: previous.bank ?? null,
      predicted: previous.predicted ?? null,
    };
  }
  return previous.lastDrift ?? null;
}

/**
 * ⭐ THE CHECK ON A MANUAL SYNC. Called once the Sync's own rows are in (and any
 * stale-cursor backfill ran), for the forecast checking account the Sync owns
 * and re-read. Stores the answer (a failed write never fails the Sync) and
 * returns the Sync result's `balanceDrift` (unchanged shape).
 *
 *   no previous anchor   nothing stored (there is nothing to roll forward);
 *   no balance read      not_checked · balance_unavailable;
 *   anchor > 45 days     not_checked · anchor_too_old (the bank figure kept);
 *   otherwise            ties / drift, after one self-heal (`heal`) on drift.
 */
export async function checkBankBalanceOnSync(opts: {
  householdId: string;
  ownerUserId: string;
  accountExternalId: string;
  prevAnchor: { balance: number; at: Date } | null;
  /** The record stored before this Sync. */
  previous: BankBalanceCheckRecord | null;
  /** The balance read, or null when Plaid returned none (or the call failed). */
  read: BankBalanceRead | null;
  /** One `/transactions/get` self-heal, returning the rows it added; null when one already ran this Sync. */
  heal: (() => Promise<number>) | null;
  log: Logger;
  logContext: object;
}): Promise<{ balanceDrift: { bank: string; ledger: string; unexplained: string } | null }> {
  const { previous, read, prevAnchor } = opts;
  if (!prevAnchor) return { balanceDrift: null };

  // The anchor's read, when this household's last check recorded it: its field
  // and the deposits it saw pending.
  const prevRead =
    previous?.anchor && previous.anchor.at === prevAnchor.at.toISOString() ? previous : null;
  const prevField: BankBalanceField | null = prevRead?.anchor?.field ?? null;
  const prevPendingIds = prevField === "available" ? (prevRead?.pendingDeposits?.ids ?? null) : null;
  const prevAnchorOut: BankBalanceCheckRecord["prevAnchor"] = {
    balance: money(prevAnchor.balance),
    at: prevAnchor.at.toISOString(),
    field: prevField,
    pendingDepositIds: prevPendingIds,
  };
  const lastDrift = carriedDrift(previous);
  const base = {
    accountId: opts.accountExternalId,
    prevAnchor: prevAnchorOut,
    lastDrift,
  };

  let record: BankBalanceCheckRecord;
  let balanceDrift: { bank: string; ledger: string; unexplained: string } | null = null;
  if (!read) {
    record = {
      ...base,
      checkedAt: new Date().toISOString(),
      status: "not_checked",
      reason: "balance_unavailable",
      unexplained: null,
      bank: null,
      // Nothing was re-read, so the anchor (and what its read saw pending) stands.
      anchor: prevRead?.anchor ?? null,
      pendingDeposits: prevRead?.pendingDeposits ?? null,
      predicted: null,
      excluded: null,
      added: null,
      fieldChanged: false,
    };
  } else {
    const anchorBalance = read.anchorField === "available" ? read.available! : read.current!;
    const anchorOut = { balance: money(anchorBalance), at: read.at.toISOString(), field: read.anchorField };
    // Like with like: the bank figure in the previous anchor's field when Plaid gave it.
    const compareField: BankBalanceField =
      prevField && (prevField === "available" ? read.available : read.current) != null ? prevField : read.anchorField;
    const bankFigure = (compareField === "available" ? read.available : read.current)!;
    const fieldChanged = prevField !== null && prevField !== read.anchorField;
    const bankOut = { balance: money(bankFigure), at: read.at.toISOString(), field: compareField };

    if (!anchorIsReconcilable(prevAnchor.at)) {
      record = {
        ...base,
        checkedAt: new Date().toISOString(),
        status: "not_checked",
        reason: "anchor_too_old",
        unexplained: null,
        bank: bankOut,
        anchor: anchorOut,
        // Not listed: the rows from an anchor this old are not read.
        pendingDeposits: null,
        predicted: null,
        excluded: null,
        added: null,
        fieldChanged,
      };
    } else {
      const checkDay = householdTodayISO();
      let checkAt = await databaseNow();
      const ledgerRead = (at: Date) =>
        readBankCheckLedger({
          householdId: opts.householdId,
          accountExternalId: opts.accountExternalId,
          prevAnchor,
          checkDay,
          checkAt: at,
          bankField: compareField,
          anchorPendingDepositIds: prevPendingIds ? new Set(prevPendingIds) : null,
          todayISO: checkDay,
        });
      let ledger = await ledgerRead(checkAt);
      let recon = reconcileBankBalance({
        anchorBalance: prevAnchor.balance,
        ledgerNetSinceAnchor: ledger.net,
        bankAvailable: bankFigure,
      });
      if (recon.drifted) {
        opts.log.warn(
          {
            ...opts.logContext,
            bankAvailable: bankFigure,
            bankField: compareField,
            ledgerPredicted: recon.predicted,
            unexplained: recon.unexplained,
            anchorDay: householdDayOf(prevAnchor.at),
            anchorBalance: prevAnchor.balance,
            pendingDepositsLeftOut: money(ledger.excluded.amount),
            depositsPostedSinceAnchor: money(ledger.added.amount),
          },
          "[plaid-sync] bank reconciliation: our rows do not explain the bank balance",
        );
        // Try to heal it the same way a stuck cursor is healed (one window per Sync).
        if (opts.heal) {
          try {
            const added = await opts.heal();
            if (added > 0) {
              checkAt = await databaseNow();
              ledger = await ledgerRead(checkAt);
              recon = reconcileBankBalance({
                anchorBalance: prevAnchor.balance,
                ledgerNetSinceAnchor: ledger.net,
                bankAvailable: bankFigure,
              });
              opts.log.info(
                { ...opts.logContext, recovered: added, unexplained: recon.unexplained },
                "[plaid-sync] bank reconciliation: gap-backfill recovered rows",
              );
            }
          } catch (e) {
            opts.log.warn(
              { ...opts.logContext, err: e },
              "[plaid-sync] bank reconciliation: gap-backfill failed (non-fatal)",
            );
          }
        }
        if (recon.drifted) {
          balanceDrift = {
            bank: bankFigure.toFixed(2),
            ledger: recon.predicted.toFixed(2),
            unexplained: recon.unexplained.toFixed(2),
          };
        }
      }
      record = {
        ...base,
        checkedAt: checkAt.toISOString(),
        status: recon.drifted ? "drift" : "ties",
        reason: null,
        unexplained: recon.unexplained.toFixed(2),
        bank: bankOut,
        anchor: anchorOut,
        predicted: recon.predicted.toFixed(2),
        pendingDeposits: idList(ledger.pendingDeposits),
        excluded: idList(ledger.excluded),
        added: idList(ledger.added),
        fieldChanged,
      };
    }
  }

  try {
    await db
      .update(forecastSettingsTable)
      .set({ lastBankReconciliation: record })
      .where(eq(forecastSettingsTable.userId, opts.ownerUserId));
  } catch (e) {
    opts.log.warn({ ...opts.logContext, err: e }, "[plaid-sync] bank reconciliation: could not store the tie (non-fatal)");
  }
  return { balanceDrift };
}

/**
 * ⭐ THE REVIEW'S BALANCE CHECK for one account (`GET /banking/review`). Reads
 * the stored record; for a check that compared, recomputes it from the stored
 * previous anchor over the rows as they stand now (ONE query, no Plaid call) to
 * tell `resolved_since` and late rows (`rows_since`).
 */
export async function readBankBalanceCheck(opts: {
  householdId: string;
  record: BankBalanceCheckRecord | null;
  isForecastAccount: boolean;
  accountIds: readonly string[];
  currentAnchorAt: Date | null;
  now?: Date;
}): Promise<BankBalanceCheck> {
  const now = opts.now ?? new Date();
  const rec = opts.record;
  let recompute: { predicted: number; lateRows: number } | null = null;
  const applies = opts.isForecastAccount && !!rec && opts.accountIds.includes(rec.accountId);
  if (
    applies &&
    rec &&
    (rec.status === "ties" || rec.status === "drift") &&
    rec.prevAnchor &&
    rec.bank &&
    // A check whose pending deposits could not be listed cannot be recomputed like with like.
    (rec.bank.field !== "available" || rec.pendingDeposits != null)
  ) {
    const checkAt = new Date(rec.checkedAt);
    const prevPending = rec.prevAnchor.pendingDepositIds;
    const r = await readBankCheckLedger({
      householdId: opts.householdId,
      accountExternalId: rec.accountId,
      prevAnchor: { balance: Number(rec.prevAnchor.balance), at: new Date(rec.prevAnchor.at) },
      checkDay: householdDayOf(checkAt),
      checkAt,
      bankField: rec.bank.field,
      excludedIds: new Set(rec.pendingDeposits?.ids ?? []),
      anchorPendingDepositIds: prevPending ? new Set(prevPending) : null,
      addedIds: new Set(rec.added?.ids ?? []),
      todayISO: householdTodayISO(now),
    });
    recompute = { predicted: r.predicted, lateRows: r.lateRows };
  }
  return bankBalanceCheckOf({
    record: rec,
    isForecastAccount: opts.isForecastAccount,
    accountIds: opts.accountIds,
    now,
    currentAnchorAt: opts.currentAnchorAt ? opts.currentAnchorAt.toISOString() : null,
    recompute,
  });
}
