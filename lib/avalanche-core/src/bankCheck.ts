// ⭐ (F3) THE BANK BALANCE CHECK — does H2's ledger explain what the bank holds?
//
// A manual Sync reads the bank's own balance for the forecast's checking
// account and compares it with the previous anchor rolled forward through the
// ledger's rows (`classifyCashRows`, the ledger's one cash rule). This module is
// the comparison's own arithmetic and its answer for the banking review. Pure.
//
// Three rules sit ON TOP of the cash rule, in the comparison only — the forecast
// curve and the spine's roll-forward never read them:
//
//   1. LIKE WITH LIKE, PENDING DEPOSITS. Plaid's `available` holds pending
//      charges but NOT pending deposits. The cash rule counts an unpaired pending
//      deposit dated after the anchor (cash it expects), so comparing with
//      `available` used to report a deposit the bank has not released yet as a
//      drift. When the bank figure is `available`, an unpaired pending deposit
//      (and, at a later recompute, any row that was one at the check, or the
//      posted row that replaced it) is left out of the prediction.
//   2. DEPOSITS THE ANCHOR DID NOT HOLD. The same blind spot on the anchor's
//      side: a deposit still pending when the anchor was read (an `available`
//      read) is not in it, yet the cash rule holds every row dated before the
//      anchor's day. When the read that set the anchor recorded its pending
//      deposits, each one that has since posted adds its amount.
//   3. THE CHECK'S OWN DAYS. A row counts when it is dated on or before the
//      check's day — or it is a charge that was already on the ledger at the
//      check (a pending row Plaid re-keyed to a later posting date), or the
//      posted row that replaced a pending charge dated on or before that day.
//      At the check itself this is the same as "through today"; it keeps a later
//      recompute (`resolved_since`) from losing charges that merely posted later.
//
// ⚠️ Only rows with a Plaid account on the checked account count (PR4e: a
// manual "Log payment" row never merges with the bank's debit).

import type { CashRow, CashRowOutcome } from "./cashRows";

/** Plaid's two balance fields: `available` (what the bank presents) and `current` (posted only). */
export type BankBalanceField = "available" | "current";

/** Below this the bank and H2 tie: float noise, not a missing row (the Sync's RECONCILE_EPSILON). */
export const BANK_CHECK_EPSILON = 0.01;
/** A check older than this many days is stale. */
export const BANK_CHECK_STALE_DAYS = 7;
/** Row ids a check records (pending deposits, rows left out or added) are kept up to this many; more → not recorded. */
export const BANK_CHECK_MAX_IDS = 200;

export interface BankCheckLedgerInputs {
  /** The rows the ledger reads from the anchor (`ledgerActualRowsWhere`), in the order classified. */
  rows: readonly CashRow[];
  /** `classifyCashRows(rows, { anchor: the previous anchor, … }).rows` — one per row, same order. */
  outcomes: readonly CashRowOutcome[];
  /** The checked account's external Plaid id. */
  accountExternalId: string;
  /** The household day of the check (inclusive). */
  checkDay: string;
  /** The instant the check read the rows: a row created after it is a late row. */
  checkAt: Date;
  /** The field of the bank figure compared. Rule 1 applies to `available`. */
  bankField: BankBalanceField;
  /**
   * At a recompute: the rows that were pending deposits at the check (the
   * record's `pendingDeposits`). Null at the check itself, where a row's own
   * `pending` decides.
   */
  excludedIds?: ReadonlySet<string> | null;
  /** Rule 2: the deposits pending when the anchor was read (an `available` read), or null when not known. */
  anchorPendingDepositIds?: ReadonlySet<string> | null;
  /**
   * At a recompute: the rows rule 2 added at the check, so a deposit that
   * posted only after the check is not added. Null at the check itself.
   */
  addedIds?: ReadonlySet<string> | null;
}

export interface BankCheckIds {
  ids: string[];
  /** Σ amounts, signed, unrounded. */
  amount: number;
}

export interface BankCheckLedger {
  /** What the ledger adds to the anchor for the check (rules 1–3 applied). Unrounded. */
  net: number;
  /** Rule 1: rows left out as deposits the bank figure does not hold. */
  excluded: BankCheckIds;
  /** Rule 2: deposits the anchor did not hold that have since posted. */
  added: BankCheckIds;
  /** Unpaired pending deposits on the account in these rows: what an `available` read now does not hold. */
  pendingDeposits: BankCheckIds;
  /** Rows counted that reached the ledger after `checkAt`. */
  lateRows: number;
}

/** ⭐ The ledger's side of the check. See the file header. */
export function bankCheckLedger(inp: BankCheckLedgerInputs): BankCheckLedger {
  const byId = new Map(inp.rows.map((r) => [r.id, r] as const));
  // A pending row a posted row replaced: held rows keep reason "held", so the pair is read from the posted side.
  const replaced = new Set<string>();
  for (const o of inp.outcomes) if (o.replacedId) replaced.add(o.replacedId);
  const checkMs = inp.checkAt.getTime();
  const available = inp.bankField === "available";
  const excludedIds = inp.excludedIds ?? null;

  const inWindow = (r: CashRow, o: CashRowOutcome): boolean => {
    if (r.occurredOn <= inp.checkDay) return true;
    if (r.amount >= 0) return false;
    if (r.createdAt.getTime() <= checkMs) return true;
    const p = o.replacedId ? byId.get(o.replacedId) : undefined;
    return !!p && p.occurredOn <= inp.checkDay && p.amount < 0;
  };
  const isPendingDeposit = (r: CashRow): boolean => r.pending && r.amount > 0;
  const wasPendingDeposit = (r: CashRow, o: CashRowOutcome): boolean =>
    isPendingDeposit(r) || (!!excludedIds && (excludedIds.has(r.id) || (!!o.replacedId && excludedIds.has(o.replacedId))));

  let net = 0;
  let lateRows = 0;
  const excluded: BankCheckIds = { ids: [], amount: 0 };
  const added: BankCheckIds = { ids: [], amount: 0 };
  const pendingDeposits: BankCheckIds = { ids: [], amount: 0 };
  inp.rows.forEach((r, i) => {
    const o = inp.outcomes[i];
    if (!o || !r.plaidAccountId || r.plaidAccountId !== inp.accountExternalId) return;
    if (isPendingDeposit(r) && !replaced.has(r.id) && (o.reason === "held" || o.counts)) {
      pendingDeposits.ids.push(r.id);
      pendingDeposits.amount += r.amount;
    }
    if (o.counts) {
      if (!inWindow(r, o)) return;
      if (available && wasPendingDeposit(r, o)) {
        excluded.ids.push(r.id);
        excluded.amount += o.contribution;
        return;
      }
      net += o.contribution;
      if (r.createdAt.getTime() > checkMs) lateRows += 1;
      return;
    }
    // Rule 2: a deposit the anchor's read saw pending, posted since and held by the anchor.
    const anchorPending = inp.anchorPendingDepositIds;
    if (
      anchorPending &&
      o.reason === "held" &&
      !r.pending &&
      r.amount > 0 &&
      (anchorPending.has(r.id) || (!!o.replacedId && anchorPending.has(o.replacedId))) &&
      (!inp.addedIds || inp.addedIds.has(r.id))
    ) {
      added.ids.push(r.id);
      added.amount += r.amount;
      net += r.amount;
    }
  });
  return { net, excluded, added, pendingDeposits, lateRows };
}

// ── The review's answer ──────────────────────────────────────────────────────

export type BankCheckStatus = "matches" | "off_by" | "resolved_since" | "not_checked";
export type BankCheckReason = "never" | "not_forecast_account" | "anchor_too_old" | "balance_unavailable";
export type BankCheckStaleReason = "age" | "anchor_changed" | "rows_since";
export type BankCheckDirection = "bank_higher" | "bank_lower";

/** A stored check as the review reads it (the shape `forecast_settings.last_bank_reconciliation` holds). */
export interface BankCheckRecordInput {
  checkedAt: string;
  accountId: string;
  status: "ties" | "drift" | "not_checked";
  /** bank − H2 at the check, two decimals; null when not checked. */
  unexplained: string | null;
  reason?: "anchor_too_old" | "balance_unavailable" | null;
  bank?: { balance: string; at: string; field: BankBalanceField } | null;
  /** The anchor in effect after the Sync (the one it wrote, or the one it kept). */
  anchor?: { balance: string; at: string; field: BankBalanceField } | null;
  predicted?: string | null;
  lastDrift?: { checkedAt: string; accountId: string; unexplained: string | null } | null;
}

export interface BankBalanceCheck {
  status: BankCheckStatus;
  reason: BankCheckReason | null;
  stale: boolean;
  staleReason: BankCheckStaleReason | null;
  checkedAt: string | null;
  /** The bank's figure the check compared (its field and when it was read); null when none was read. */
  bank: { balanceCents: number; at: string; field: BankBalanceField } | null;
  /** H2's figure at the check: the previous anchor rolled forward through the ledger. */
  h2: { balanceCents: number } | null;
  /** |bank − H2| at the check, cents; null when not compared. */
  differenceCents: number | null;
  /** Which side is higher; null when they tie or were not compared. */
  direction: BankCheckDirection | null;
  /** The last EARLIER check that was off (a later Sync re-anchors, so it is kept): null when none. */
  lastDrift: { checkedAt: string; differenceCents: number; direction: BankCheckDirection | null } | null;
}

const cents = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const directionOf = (unexplainedCents: number): BankCheckDirection | null =>
  unexplainedCents >= 1 ? "bank_higher" : unexplainedCents <= -1 ? "bank_lower" : null;

export interface BankBalanceCheckArgs {
  record: BankCheckRecordInput | null;
  /** Is the reviewed account the forecast's checking account? */
  isForecastAccount: boolean;
  /** The reviewed account's external Plaid ids: a record for another account is "never" here. */
  accountIds: readonly string[];
  now: Date;
  /** `forecast_settings.bank_snapshot_at` now (ISO), or null. */
  currentAnchorAt: string | null;
  /** The read-time recompute from the stored previous anchor (one query, no Plaid call); null when not run. */
  recompute: { predicted: number; lateRows: number } | null;
}

/**
 * (Final #13) Is the anchor the check read still the anchor now? The same
 * MOMENT, whatever its format: "2026-10-14T07:00:00-05:00" and
 * "2026-10-14T12:00:00.000Z" are one anchor (a string compare called it
 * changed, and the tile read "Checked 1 d ago" instead of "Matches bank"). A
 * time that does not parse is compared as written. No anchor now: changed.
 */
export function sameAnchorMoment(checked: string, current: string | null): boolean {
  if (current == null) return false;
  const a = Date.parse(checked);
  const b = Date.parse(current);
  return Number.isNaN(a) || Number.isNaN(b) ? checked === current : a === b;
}

/**
 * ⭐ THE REVIEW'S BALANCE CHECK.
 *
 *   not_checked     never (no check of this account) · not_forecast_account ·
 *                   anchor_too_old / balance_unavailable (the last Sync's own reason);
 *   matches         the last check tied;
 *   off_by          it did not: `difference` and `direction` as found;
 *   resolved_since  it did not, but recomputed now — the same previous anchor,
 *                   the same days, the rows as they stand — it ties: rows that
 *                   arrived late explain it.
 *
 * Stale (first reason wins): `anchor_changed` (a newer anchor or a typed
 * balance replaced the one this check read) · `rows_since` (rows dated on or
 * before the check's day reached the ledger after it) · `age` (more than
 * BANK_CHECK_STALE_DAYS days old). A not-checked outcome is stale by age only.
 */
export function bankBalanceCheckOf(args: BankBalanceCheckArgs): BankBalanceCheck {
  const none: BankBalanceCheck = {
    status: "not_checked",
    reason: "never",
    stale: false,
    staleReason: null,
    checkedAt: null,
    bank: null,
    h2: null,
    differenceCents: null,
    direction: null,
    lastDrift: null,
  };
  if (!args.isForecastAccount) return { ...none, reason: "not_forecast_account" };
  const rec = args.record;
  if (!rec || !args.accountIds.includes(rec.accountId)) return none;

  const ld = rec.lastDrift && args.accountIds.includes(rec.lastDrift.accountId) ? rec.lastDrift : null;
  const ldCents = ld ? cents(ld.unexplained) : null;
  const lastDrift = ld && ldCents != null ? { checkedAt: ld.checkedAt, differenceCents: Math.abs(ldCents), direction: directionOf(ldCents) } : null;
  const bankCents = rec.bank ? cents(rec.bank.balance) : null;
  const bank = rec.bank && bankCents != null ? { balanceCents: bankCents, at: rec.bank.at, field: rec.bank.field } : null;
  const old = args.now.getTime() - Date.parse(rec.checkedAt) > BANK_CHECK_STALE_DAYS * 86_400_000;

  if (rec.status === "not_checked") {
    return {
      ...none,
      reason: rec.reason ?? "never",
      stale: old,
      staleReason: old ? "age" : null,
      checkedAt: rec.checkedAt,
      bank,
      lastDrift,
    };
  }

  const unexplainedCents = cents(rec.unexplained) ?? 0;
  const predictedCents = cents(rec.predicted);
  let status: BankCheckStatus = rec.status === "ties" ? "matches" : "off_by";
  if (status === "off_by" && bank && args.recompute) {
    const gapNow = bank.balanceCents - Math.round(args.recompute.predicted * 100);
    if (Math.abs(gapNow) < 1) status = "resolved_since";
  }
  const anchorChanged = !!rec.anchor && !sameAnchorMoment(rec.anchor.at, args.currentAnchorAt);
  const rowsSince = (args.recompute?.lateRows ?? 0) > 0;
  const staleReason: BankCheckStaleReason | null = anchorChanged ? "anchor_changed" : rowsSince ? "rows_since" : old ? "age" : null;
  return {
    status,
    reason: null,
    stale: staleReason !== null,
    staleReason,
    checkedAt: rec.checkedAt,
    bank,
    h2: predictedCents != null ? { balanceCents: predictedCents } : null,
    differenceCents: Math.abs(unexplainedCents),
    direction: directionOf(unexplainedCents),
    lastDrift,
  };
}
