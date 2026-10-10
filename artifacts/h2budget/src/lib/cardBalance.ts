// (WP3) From the `pendingDebt` sub-path, not the package index: the dashboard's
// Accounts row imports this module on the landing, and the index would bring
// the payoff simulator into the entry chunk with it.
import { effectiveDebtBalance, pendingPaymentTotalOf } from "@workspace/avalanche-core/pendingDebt";
import { dayOf } from "./accountFreshness";

/**
 * ⭐ ONE CARD-BALANCE MODEL for every surface that shows a card or a loan: the
 * dashboard's Accounts row, the account chips, the account's Summary and the
 * Amex register. (WP3, financial-consistency audit 2026-10-09.)
 *
 * Why it exists: Amex Platinum read "Owed $1,227.27" on the dashboard and
 * "Current balance $3,842.98" on its own page. Both were right — the first is
 * the creditor's balance NETTED of payments H2 has seen leave checking but the
 * card has not posted yet (`effectiveDebtBalance`, the app's one debt basis),
 * the second the creditor's own figure — but nothing said which was which, and
 * each page picked its own. Every surface now reads the concepts below from
 * here and prints them under the same words:
 *
 *   - `owed`            netted; ONLY for a debt on the payoff plan (active)
 *   - `creditorCurrent` what the card (or lender) itself reports, with its as-of
 *   - `pending`         the payments that make the difference
 *   - `statement`       a real statement (the API's `statement`, once it sends
 *                       one) — never the current balance under another name
 *
 * An archived debt is "Paid off · not on the payoff plan": never "Owed", never
 * in a total. Its card's own current balance is Plaid's stored liability figure
 * when there is one, else the row's only while Plaid keeps the row current
 * (`balanceSource: "plaid"`): a manual archived row holds the $0.00 it was
 * archived at, not what the card owes now that it is in use again. A card with
 * no debt row reads Plaid's stored liability figures and is "Not on the payoff
 * plan". A field no source has is null, never 0.
 */

/** The debt fields this model reads. `liabilityAsOf` and `statement` arrive with
 *  the pending-payments package (WP2); until then they are simply absent. */
export interface CardDebtInput {
  balance: string;
  status: string;
  minPayment?: string | null;
  dueDay?: number | null;
  plaidAccountId?: string | null;
  lastBalanceUpdate?: string | null;
  plaidLastSyncedAt?: string | null;
  balanceSource?: string | null;
  pendingPaymentTotal?: string | null;
  pendingPaymentCount?: number | null;
  liabilityAsOf?: string | null;
  statement?: {
    date?: string | null;
    balance?: string | null;
    minPayment?: string | null;
    dueDate?: string | null;
  } | null;
}

/** Plaid's stored liability figures (`GET /plaid/liability-accounts`). */
export interface CardLiabilityInput {
  id?: string;
  balance?: string | null;
  minPayment?: string | null;
  lastFetchedAt?: string | null;
  suggestedDebt?: { dueDay?: number | null } | null;
}

export const CARD_WORDS = {
  owed: "Owed",
  pending: "Paid, not posted",
  statement: "Statement balance",
  minimum: "Minimum",
  due: "Due",
  onPlan: "On the payoff plan",
  archived: "Paid off · not on the payoff plan",
  offPlan: "Not on the payoff plan",
  nothing: "No balance, minimum or due date reported for this card yet.",
} as const;

/** "Card's current balance" / "Loan's current balance": the creditor's own figure. */
export const creditorLabel = (loan?: boolean): string => `${loan ? "Loan" : "Card"}'s current balance`;

export type CardPlanState = "on_plan" | "archived" | "off_plan";

export interface CardOwedView {
  state: CardPlanState;
  onPlan: boolean;
  archived: boolean;
  /** Netted of pending payments — on the payoff plan only, else null. */
  owed: number | null;
  pending: { total: number; count: number; since: string | null } | null;
  creditorCurrent: { balance: number; asOf: string | null; source: "plaid" | "manual" } | null;
  statement: { date: string | null; balance: number | null; minPayment: number | null; dueDate: string | null } | null;
  /** Null when unknown — the API's "0" minimum means "not reported". */
  minPayment: number | null;
  dueDay: number | null;
  /** The plan words: `CARD_WORDS.onPlan` / `.archived` / `.offPlan`. */
  status: string;
}

/**
 * The debt row of a linked account, by the account's INTERNAL row id only.
 * `debts.plaid_account_id` is a uuid foreign key to `plaid_accounts.id`, so
 * Plaid's text `account_id` can never be a debt's link; matching it too only
 * invites a false hit. Any status — the view decides what an archived row says.
 */
export function debtForAccount<D extends { plaidAccountId?: string | null }>(
  debts: readonly D[] | null | undefined,
  acct: { id: string },
): D | null {
  return (debts ?? []).find((d) => !!d.plaidAccountId && d.plaidAccountId === acct.id) ?? null;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const positive = (v: string | null | undefined): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};
/** The debt's real statement (GET /debts `statement`, archived rows included), or null. */
const statementOf = (debt: CardDebtInput | null | undefined): CardOwedView["statement"] => {
  const st = debt?.statement;
  return st ? { date: st.date ?? null, balance: num(st.balance), minPayment: num(st.minPayment), dueDate: st.dueDate ?? null } : null;
};

/** The one view of a card or loan. Pure. */
export function cardOwedView({
  debt, liability,
}: {
  debt?: CardDebtInput | null;
  liability?: CardLiabilityInput | null;
}): CardOwedView {
  // Archived with Plaid's own figure: the card's current balance (and minimum)
  // are the card's, read from the liability; the row only says it was paid off.
  const fromLiability = !!debt && debt.status !== "active" && num(liability?.balance) != null;
  if (debt && !fromLiability) {
    const onPlan = debt.status === "active";
    const plaid = debt.balanceSource === "plaid";
    const total = pendingPaymentTotalOf(debt);
    // An archived row's own balance is the card's only while Plaid keeps it current.
    const bal = onPlan || plaid ? num(debt.balance) : null;
    return {
      state: onPlan ? "on_plan" : "archived",
      onPlan,
      archived: !onPlan,
      owed: onPlan ? effectiveDebtBalance(debt) : null,
      pending: total > 0
        ? {
            total,
            count: debt.pendingPaymentCount ?? 0,
            // The server counts a tagged payment as pending when it is dated
            // after the creditor's last reported balance (`Debt.pendingPaymentTotal`).
            since: debt.liabilityAsOf ?? (plaid ? debt.plaidLastSyncedAt : debt.lastBalanceUpdate) ?? null,
          }
        : null,
      creditorCurrent: bal == null
        ? null
        : { balance: bal, asOf: debt.liabilityAsOf ?? debt.lastBalanceUpdate ?? debt.plaidLastSyncedAt ?? null, source: plaid ? "plaid" : "manual" },
      statement: statementOf(debt),
      minPayment: positive(debt.minPayment),
      dueDay: debt.dueDay ?? null,
      status: onPlan ? CARD_WORDS.onPlan : CARD_WORDS.archived,
    };
  }
  const bal = num(liability?.balance);
  return {
    state: debt ? "archived" : "off_plan",
    onPlan: false,
    archived: !!debt,
    owed: null,
    pending: null,
    creditorCurrent: bal == null ? null : { balance: bal, asOf: liability?.lastFetchedAt ?? null, source: "plaid" },
    // An archived debt still has its statements (GET /debts serves them).
    statement: statementOf(debt),
    minPayment: positive(liability?.minPayment),
    dueDay: liability?.suggestedDebt?.dueDay ?? debt?.dueDay ?? null,
    status: debt ? CARD_WORDS.archived : CARD_WORDS.offPlan,
  };
}

/**
 * Whether a card needs Plaid's stored liability figures: no debt row at all, or
 * an archived one (whose own balance may be the $0.00 it was archived at).
 */
export const needsLiability = (debt: { status: string } | null | undefined): boolean => !debt || debt.status !== "active";

/** Whether the view has any figure to draw (otherwise the row says so in words). */
export const cardHasFigures = (v: CardOwedView): boolean =>
  v.owed != null || v.creditorCurrent != null || v.minPayment != null || v.dueDay != null;

/** "as of Oct 8", or null when the moment is unknown. */
export function asOfWords(iso: string | null | undefined): string | null {
  const d = dayOf(iso);
  return d ? `as of ${d}` : null;
}

/** "2 payments since Oct 8" / "1 payment". */
export function pendingWords(p: NonNullable<CardOwedView["pending"]>): string {
  const n = `${p.count} payment${p.count === 1 ? "" : "s"}`;
  const since = dayOf(p.since);
  return since ? `${n} since ${since}` : n;
}
