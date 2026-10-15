// ⭐ (Q3) THE ONE CARD-BALANCE WALK for the web — what a card owed after each
// of its rows. The Amex page's per-row "bal", its month-end figure and its
// 12-month chart all read a card's rows through here, so the three can never
// disagree on which rows count or which way they move the balance.
//
// WHY: a card balance is what is OWED. A purchase (or a fee, or interest)
// raises it; a payment, a refund or a credit lowers it. The rows do not all say
// that with the same sign:
//   - Plaid card rows (`plaid:amex`, `plaid:chase`, …) carry the BANK sign: a
//     purchase is NEGATIVE, a payment POSITIVE;
//   - workbook rows (`source: "amex"`) store a purchase POSITIVE.
// `normalizeCardAmount` (avalanche-core, the one card-sign rule the server's
// summary, payoff and owed figures already use) turns both into the owed sign.
// The page used to walk card rows with the CHECKING rule (`older = bal −
// amount`), so a Plaid purchase made the balance RISE going back in time.
// `computeRunningBalances` (runningBalance.ts) stays as it was, for checking.
//
// WHAT IS WALKED: posted rows only, and only rows that count (`isCounted`: an
// expired hold counts nowhere — F6). A pending row moves no balance here and
// carries no "bal": the walk is anchored on posted rows. So a pending row a
// posted row replaced (one the sync could not re-key, which can survive in
// `/transactions`) can never count twice. The anchor is the card's current
// balance — Plaid's `balances.current`, or the card's debt row — which Plaid
// documents as excluding pending activity for most issuers (`available` is the
// figure that takes pending off); no fixture can prove it for every issuer.
//
// Pure: no I/O. Integer cents throughout, so a walk back from the anchor and a
// walk forward from the opening balance agree to the cent.
import { normalizeCardAmount } from "@workspace/avalanche-core";
// Concrete module, not the account-page barrel (the barrel drags recharts
// into the entry graph via BalanceTrendChart — see check-entry-graph.mjs).
import {
  compareMonth,
  monthKeyFromISO,
  type MonthKey,
} from "@/components/account-page/month-navigator";
import { asOfWords } from "./cardBalance";
import { isCounted, type MaybeExpiredHold } from "./countedRows";
import { householdDayOfAt } from "./householdDay";
import { compareNewestFirst } from "./runningBalance";
import { formatCurrency } from "./utils";

/** What the walk reads from a card row. */
export type CardMoveInput = MaybeExpiredHold & {
  occurredOn: string;
  amount: string | number;
  /** `amex` = the workbook's sign (purchase +); anything else = the bank's (purchase −). */
  source: string | null | undefined;
  /** A pending row moves no balance here. */
  pending?: boolean | null;
};

/** A row the per-row walk can key its figure by. */
export type CardBalanceRow = CardMoveInput & {
  id: string;
  occurredAt?: string | null;
};

const toDollars = (cents: number): number => cents / 100 + 0; // `+ 0`: never -0

/**
 * A row's effect on what the card owes, in cents: positive for a purchase, a
 * fee or interest; negative for a payment, a refund or a credit.
 */
export function owedDeltaCents(row: Pick<CardMoveInput, "source" | "amount">): number {
  return Math.round(normalizeCardAmount(row.source, row.amount) * 100);
}

/**
 * Does this row move the card's posted balance? Posted rows only — and (F6 ⇄
 * Q3 merge) only rows that count (`isCounted`): an expired hold counts nowhere,
 * the card's balance included (the owner's rule, 2026-10-15). An expired hold is
 * pending by definition, so the posted-only rule already leaves it out; the
 * explicit skip keeps the walk on the one shared answer if a row ever carries
 * the server's `expiredHold` without its `pending` flag.
 */
export function movesCardBalance(row: Pick<CardMoveInput, "pending" | "expiredHold" | "expiredPair">): boolean {
  return row.pending !== true && isCounted(row);
}

/**
 * The rows that move the balance, each with its owed change in dollars
 * (`owed`): the input the month-end helper and the 12-month window sum.
 */
export function cardOwedMoves<T extends CardMoveInput>(
  rows: ReadonlyArray<T>,
): Array<{ occurredOn: string; owed: number; row: T }> {
  const out: Array<{ occurredOn: string; owed: number; row: T }> = [];
  for (const r of rows) {
    if (!movesCardBalance(r)) continue;
    out.push({ occurredOn: r.occurredOn, owed: toDollars(owedDeltaCents(r)), row: r });
  }
  return out;
}

/** Sum of the owed changes of the rows that move the balance, in dollars (exact to the cent). */
export function sumOwed(rows: ReadonlyArray<CardMoveInput>): number {
  let c = 0;
  for (const r of rows) if (movesCardBalance(r)) c += owedDeltaCents(r);
  return toDollars(c);
}

/**
 * ⭐ Walk BACK from the balance after the newest posted row: id → what the card
 * owed after that row. `balanceBefore(row) = balanceAfter(row) − owedDelta(row)`.
 * Rows are ordered newest first by the page's own comparator
 * (`compareNewestFirst`), so the figures run in the order the rows are shown.
 * Pending rows get no figure.
 */
export function walkCardBalancesBack(
  rows: ReadonlyArray<CardBalanceRow>,
  balanceAfterNewest: number,
): Map<string, number> {
  const posted = rows.filter(movesCardBalance).sort(compareNewestFirst);
  const out = new Map<string, number>();
  let bal = Math.round(balanceAfterNewest * 100);
  for (const r of posted) {
    out.set(r.id, toDollars(bal));
    bal -= owedDeltaCents(r);
  }
  return out;
}

/**
 * Walk FORWARD from the balance before the oldest posted row:
 * `balanceAfter(row) = balanceBefore(row) + owedDelta(row)`. The same figures
 * as {@link walkCardBalancesBack} from the matching end — the tests hold the
 * two to each other.
 */
export function walkCardBalancesForward(
  rows: ReadonlyArray<CardBalanceRow>,
  openingBalance: number,
): Map<string, number> {
  const posted = rows.filter(movesCardBalance).sort((a, b) => compareNewestFirst(b, a));
  const out = new Map<string, number>();
  let bal = Math.round(openingBalance * 100);
  for (const r of posted) {
    bal += owedDeltaCents(r);
    out.set(r.id, toDollars(bal));
  }
  return out;
}

/** What the card owed before the oldest posted row, from the balance after the newest. */
export function openingCardBalance(
  rows: ReadonlyArray<CardMoveInput>,
  balanceAfterNewest: number,
): number {
  let c = Math.round(balanceAfterNewest * 100);
  for (const r of rows) if (movesCardBalance(r)) c -= owedDeltaCents(r);
  return toDollars(c);
}

/** The household day an anchor was read on, and its month (the fallback month without a date). */
export function anchorDayAndMonth(
  asOf: string | null | undefined,
  fallbackMonth: MonthKey,
): { day: string | null; month: MonthKey } {
  if (!asOf) return { day: null, month: fallbackMonth };
  const day = householdDayOfAt(asOf);
  return { day, month: monthKeyFromISO(day) };
}

const monthWords = (m: MonthKey, withYear: boolean): string =>
  new Date(Date.UTC(m.year, m.month, 1)).toLocaleDateString("en-US", {
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

/**
 * The words that say what one card's "bal" figures count from:
 *   - the anchor's month (or a later one): "Balance after each row, counting
 *     back from $X (as of Sep 16)." — "counting from" when some posted row of
 *     the month is dated after the anchor's day (those count forward from it);
 *   - an earlier month: "Balance after each row, counting back from $Y at the
 *     end of August." ($Y is that month's end, the figure the newest row shows).
 */
export function cardWalkNote(args: {
  anchor: { balance: number; asOf: string | null };
  /** The date to print, when the figure's own date differs from the walk's
   *  anchor date (a debt row: the Summary's date). Default: `anchor.asOf`. */
  shownAsOf?: string | null;
  selectedMonth: MonthKey;
  /** The balance at the end of `selectedMonth` (the newest row's figure). */
  monthEndBalance: number;
  /** The month's rows of this card (pending ones are not counted). */
  monthRows: ReadonlyArray<CardMoveInput>;
  fallbackMonth: MonthKey;
}): string {
  const { anchor, shownAsOf, selectedMonth, monthEndBalance, monthRows, fallbackMonth } = args;
  const a = anchorDayAndMonth(anchor.asOf, fallbackMonth);
  if (compareMonth(selectedMonth, a.month) < 0) {
    const withYear = selectedMonth.year !== a.month.year;
    return `Balance after each row, counting back from ${formatCurrency(monthEndBalance)} at the end of ${monthWords(selectedMonth, withYear)}.`;
  }
  const after =
    compareMonth(selectedMonth, a.month) > 0 ||
    (a.day !== null &&
      monthRows.some((r) => movesCardBalance(r) && r.occurredOn.slice(0, 10) > a.day!));
  const asOf = asOfWords(shownAsOf === undefined ? anchor.asOf : shownAsOf);
  return `Balance after each row, counting ${after ? "" : "back "}from ${formatCurrency(anchor.balance)}${asOf ? ` (${asOf})` : ""}.`;
}
