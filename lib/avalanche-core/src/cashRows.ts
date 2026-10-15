import { isInSnapshot, pendingChargeWasInBalance, type SnapshotLedgerRow } from "./snapshotInclusion";
import { expiredHolds, pairPendingWithPosted, type SupersedeRow } from "./pendingSupersede";

/** A ledger row, as the cash rule reads it. */
export type CashRow = {
  id: string;
  occurredOn: string;
  /** Signed: negative is money out. */
  amount: number;
  /** `transactions.created_at`: when the row reached the ledger. */
  createdAt: Date;
  /** `transactions.occurred_at`, parsed. An unparsable value is an invalid Date, which the rule treats as no time. */
  occurredAt: Date | null;
  pending: boolean;
  description: string | null;
  source: string | null;
  plaidAccountId: string | null;
  plaidTransactionId: string | null;
  /**
   * (PR-D) A payment the user logged in the app (`POST /debts/:id/payments`, a
   * claim) that a bank row has since confirmed (`transactions.payment_state =
   * 'confirmed'` with `confirmed_by_txn_id`). The bank row is the payment; the
   * claim beside it adds 0. Absent (every row before PR-D) means false.
   */
  claimConfirmed?: boolean;
};

/** The bank balance the rows roll forward from: the instant it was read and its household day. */
export type CashAnchor = { at: Date; day: string };

/**
 * Why a row adds what it adds:
 * - `held`: the snapshot already holds it (`isInSnapshot`) — adds 0. A posted
 *   row is held only when its pending half is held too;
 * - `not_bank`: not on the snapshot's account — adds 0;
 * - `superseded`: a pending row its posted row replaced (`pairPendingWithPosted`) — adds 0;
 * - `expired` (F6 round 3): an expired hold or its reversal (`expiredHolds`) — adds 0;
 * - `duplicate`: a second row with the same Plaid transaction id — adds 0 (defensive: the id is unique);
 * - `claim_confirmed` (PR-D): a payment logged in the app that a bank row has
 *   confirmed (`claimConfirmed`) — adds 0, because the bank row it paired with
 *   counts. Before PR-D both counted: the same payment left cash twice;
 * - `adjusted`: a posted row whose pending half was a charge already in the
 *   balance (`pendingChargeWasInBalance`) — adds posted − pending;
 * - `counted`: adds its amount.
 */
export type CashRowReason =
  | "held"
  | "not_bank"
  | "claim_confirmed"
  | "superseded"
  | "expired"
  | "duplicate"
  | "adjusted"
  | "counted";

export type CashRowOutcome = {
  id: string;
  occurredOn: string;
  reason: CashRowReason;
  /** True for `counted` and `adjusted`: the row is on the ledger, even when it adds 0.00. */
  counts: boolean;
  /** What the row adds to cash. 0 unless it counts. Unrounded. */
  contribution: number;
  /** For a posted row that replaced a pending row: that pending row's id. */
  replacedId: string | null;
  /**
   * (F6 round 4) For the pending credit that reversed an expired hold (with the
   * rule on): that hold's id — whether the credit adds 0 (`expired`) or counts
   * (the snapshot held its hold). Null for every other row.
   */
  reversalOf: string | null;
};

export type CashRowsResult = {
  /** One outcome per input row, in input order. */
  rows: CashRowOutcome[];
  /**
   * The rows that count, dated on or before `todayISO`: how many, and what they
   * add, summed in input order. With an anchor this is what the ledger adds to
   * the snapshot for cash today. Unrounded.
   */
  throughToday: { rowCount: number; net: number };
};

/**
 * Is this row on the bank account the snapshot was read from? A Plaid row must
 * carry that account's external id; with no resolved account, no Plaid row is.
 * A row with no Plaid account counts unless its source names a card
 * (`amex`, `plaid:*`): manual rows are the account's own.
 */
export function isBankRow(
  source: string | null,
  plaidAccountId: string | null,
  accountExternalId: string | null,
): boolean {
  if (plaidAccountId) {
    return accountExternalId !== null && plaidAccountId === accountExternalId;
  }
  const s = (source ?? "").toLowerCase();
  if (s === "amex" || s.startsWith("plaid:")) return false;
  return true;
}

/**
 * ⭐ WHAT EACH ROW ADDS TO CASH — THE ONE RULE (PR4e).
 *
 * The ledger (`bankToday` and the curve), "Why this number?" and the Sync's
 * bank reconciliation all call this. Before it they each summed rows by
 * calendar day, and the two diagnostics disagreed with the figure they were
 * diagnosing whenever the snapshot held a row or a pending row had been
 * replaced. Moved verbatim from `buildForecastLedger` (PR4b, PR4c).
 *
 * In order, a row:
 *   1. adds 0 when the anchor holds it (`isInSnapshot`; never without an anchor)
 *      — and, for the posted half of a pair, its pending half as well. A held
 *      posted row whose pending half is not held still counts: it reached the
 *      ledger after that pending half and is dated on or after it, so it cannot
 *      be inside a balance the pending half was not (PR4c review);
 *   2. adds 0 when it is not on the snapshot's account (`isBankRow`);
 *   2b. (PR-D) adds 0 when it is a confirmed claim (`claimConfirmed`): the bank
 *      row that confirmed it is the same payment, and that row counts;
 *   3. adds 0 when it is the pending half of a pair (`pairPendingWithPosted`,
 *      run over the bank rows only, held ones included);
 *   3b. ⭐ (F6 round 3, with `expiredHolds: true`) adds 0 when it is an expired
 *      hold — pending more than SUPERSEDE_MAX_DAYS after its date, never
 *      replaced — or the reversal paired with one (`expiredHolds`, over the
 *      same bank rows and pairs). ONE EXCEPTION: a reversal whose hold the
 *      anchor holds still counts. `available` held that hold, so the reversal
 *      is the money coming back (the cash today the ledger read before the
 *      rule). (F6 round 4) A reversal comes up to REVERSAL_MAX_DAYS after its
 *      hold, so its hold can sit before the rows passed in: `priorRows` carries
 *      those (dated before the anchor day, so held — the reversal counts).
 *      Without an anchor nothing is held: the pair adds 0;
 *   4. adds 0 when an earlier row carried the same Plaid transaction id;
 *   5. otherwise adds its amount — less the pending amount when it is the
 *      posted half of a pair whose pending half was a charge with evidence it
 *      was in the balance (`pendingChargeWasInBalance`: never a deposit).
 *
 * ⚠️ THE CALLER CHOOSES THE ROWS, AND PAIRING MAKES THAT MATTER. A row's outcome
 * depends on the other rows passed in: a pending row is superseded only if its
 * posted row is among them, and because pairing is one to one, a row can change
 * which pending row a later posted row takes. To get the ledger's outcomes for
 * rows dated on or before a day D, pass the same rows the ledger reads — from the
 * anchor day − SUPERSEDE_MAX_DAYS — through at least D + SUPERSEDE_MAX_DAYS.
 *   - The upper edge is safe: posted rows pair in date order, and a posted row
 *     replaces a pending row dated at most SUPERSEDE_MAX_DAYS earlier, so later
 *     rows cannot change those outcomes.
 *   - The lower edge is the ledger's, not a complete one: a pending row dated
 *     before it, left out, can leave a posted row to take a different pending row
 *     and so change a pair after the anchor. The ledger reads the same bound, so
 *     every caller of `lib/ledgerCashRows.ts` still agrees with it.
 */
export function classifyCashRows(
  rows: readonly CashRow[],
  opts: {
    anchor: CashAnchor | null;
    accountExternalId: string | null;
    todayISO: string;
    /**
     * (F6 round 3) Apply the expired-hold rule (step 3b). The server passes
     * `expiredHoldsRuleOn()` (its kill switch, `EXPIRED_HOLDS_RULE=off`); false
     * reads every row exactly as before the rule.
     */
    expiredHolds: boolean;
    /**
     * ⭐ (F6 round 4) Rows dated BEFORE `rows` — the ledger's lower edge, the
     * anchor day − SUPERSEDE_MAX_DAYS — that an expired hold in them may own a
     * reversal in `rows` from (a reversal comes up to REVERSAL_MAX_DAYS after
     * its hold). Read ONLY by the expired-hold rule: never classified, never in
     * the pending → posted pairing of `rows`, absent from the outcomes. Such a
     * hold is dated before the anchor day, so it is held, and its reversal is
     * the money coming back: it counts. Without them a reversal that is itself
     * more than 7 days old and whose hold sits before `rows` would read as an
     * expired credit and add 0 — on a snapshot more than 8 days old, the bank
     * balance would drop by a refund the day it turned 8 days old.
     * `lib/ledgerCashRows.ts` (`readReversalHoldRows`) reads them.
     */
    priorRows?: readonly CashRow[];
  },
): CashRowsResult {
  const { anchor, accountExternalId, todayISO } = opts;
  const toSnapshotRow = (r: CashRow): SnapshotLedgerRow => ({
    occurredOn: r.occurredOn,
    amount: r.amount,
    createdAt: r.createdAt,
    occurredAt: r.occurredAt,
    plaidAccountId: r.plaidAccountId,
  });
  const held = (r: CashRow): boolean => !!anchor && isInSnapshot(toSnapshotRow(r), anchor.at, anchor.day);
  const pendingWasInBalance = (r: CashRow): boolean =>
    !!anchor && pendingChargeWasInBalance(toSnapshotRow(r), anchor.at, anchor.day);

  const toSupersedeRow = (r: CashRow): SupersedeRow => ({
    id: r.id,
    plaidAccountId: r.plaidAccountId,
    pending: r.pending,
    occurredOn: r.occurredOn,
    amount: r.amount,
    description: r.description,
    createdAt: r.createdAt,
  });
  const bankRows = rows.filter((r) => isBankRow(r.source, r.plaidAccountId, accountExternalId)).map(toSupersedeRow);
  const supersededBy = pairPendingWithPosted(bankRows);
  const supersededIds = new Set([...supersededBy.values()].map((p) => p.id));
  const rowById = new Map(rows.map((r) => [r.id, r] as const));
  // (F6 round 3) Expired holds and their reversals, on the same bank rows and pairs.
  // (F6 round 4) With the rows before them that can hold a reversal's hold
  // (`priorRows`): their own replaced rows are paired among them and `rows` (a
  // posted row up to 7 days later sits in either), only to know which of them
  // can be a hold; the pairs of `rows` stay `supersededBy`.
  let expired: ReturnType<typeof expiredHolds> | null = null;
  const holdById = new Map(rowById);
  if (opts.expiredHolds) {
    const priorBank = (opts.priorRows ?? []).filter((r) => isBankRow(r.source, r.plaidAccountId, accountExternalId));
    let replaced: ReadonlySet<string> = supersededIds;
    if (priorBank.length > 0) {
      const priorIds = new Set(priorBank.map((r) => r.id));
      for (const r of priorBank) holdById.set(r.id, r);
      const wider = pairPendingWithPosted([...priorBank.map(toSupersedeRow), ...bankRows]);
      replaced = new Set([...supersededIds, ...[...wider.values()].map((p) => p.id).filter((id) => priorIds.has(id))]);
    }
    expired = expiredHolds([...priorBank.map(toSupersedeRow), ...bankRows], todayISO, replaced);
  }
  const expiredHere = (r: CashRow): boolean => {
    if (!expired?.expiredIds.has(r.id)) return false;
    const holdId = expired.holdOf.get(r.id);
    const hold = holdId ? holdById.get(holdId) : undefined;
    // A reversal of a hold the anchor holds is the money coming back: it counts.
    return !(hold && held(hold));
  };

  const out: CashRowOutcome[] = [];
  let rowCount = 0;
  let net = 0;
  const seenPlaidIds = new Set<string>();
  for (const r of rows) {
    const replaced = supersededBy.get(r.id);
    const replacedRow = replaced ? rowById.get(replaced.id) : undefined;
    const base = {
      id: r.id,
      occurredOn: r.occurredOn,
      replacedId: replaced?.id ?? null,
      reversalOf: expired?.holdOf.get(r.id) ?? null,
    };
    let reason: CashRowReason;
    let contribution = 0;
    if (held(r) && (!replacedRow || held(replacedRow))) {
      reason = "held";
    } else if (!isBankRow(r.source, r.plaidAccountId, accountExternalId)) {
      reason = "not_bank";
    } else if (r.claimConfirmed === true) {
      reason = "claim_confirmed";
    } else if (supersededIds.has(r.id)) {
      reason = "superseded";
    } else if (expiredHere(r)) {
      reason = "expired";
    } else if (r.plaidTransactionId && seenPlaidIds.has(r.plaidTransactionId)) {
      reason = "duplicate";
    } else {
      if (r.plaidTransactionId) seenPlaidIds.add(r.plaidTransactionId);
      contribution = r.amount;
      reason = "counted";
      if (replacedRow && pendingWasInBalance(replacedRow)) {
        contribution -= replacedRow.amount;
        reason = "adjusted";
      }
    }
    const counts = reason === "counted" || reason === "adjusted";
    out.push({ ...base, reason, counts, contribution });
    if (counts && r.occurredOn <= todayISO) {
      rowCount += 1;
      net += contribution;
    }
  }
  return { rows: out, throughToday: { rowCount, net } };
}
