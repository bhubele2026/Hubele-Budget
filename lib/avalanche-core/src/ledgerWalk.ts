// ⭐ (PR-B1) THE DAILY BALANCE WALK — the cash curve's arithmetic, pure.
//
// ⚠️ THIS IS A MOVE, NOT A NEW CALCULATION. Both functions below are the two
// loops `computeCashSignal` (`artifacts/api-server/src/lib/cashSignal.ts`) ran
// inline, lifted here line for line so a caller that already holds the
// ledger's items (the money position today; scenarios later) can re-walk them
// without a second copy of the loop that could drift:
//
//   - `rollForwardBalance`: the anchor balance carried through every item
//     dated before the window — the curve's `startingBalance`;
//   - `walkLedger`: the window itself — each day's end-of-day balance, the
//     lowest one and the first day it was reached.
//
// `forecastLedger.golden.integration.test.ts` pins `computeCashSignal`'s full
// output byte for byte, and `ledgerWalk.test.ts` holds both functions to a
// copy of the old inline loops on 2,000 random ledgers each.
//
// The arithmetic is the old loop's exactly, float for float: every step rounds
// the running balance to the cent (`Math.round((bal + amount) * 100) / 100`),
// and a day's balance is reported as `toFixed(2)` of that rounded number.
//
// ⚠️ ORDER MATTERS AND IS NOT CHECKED. The ledger hands its items sorted by
// date. The walk reads them the way the old loop did: it skips the LEADING
// items dated before the window, then on each day applies the items from the
// cursor while they are dated on or before that day. An unsorted list is
// walked exactly as the old loop would have walked it (the equivalence test
// covers unsorted lists too); it is simply not a meaningful curve.

import { addDaysISO } from "./householdTime";

/** What the walk reads from an item: the day it lands on and its signed amount. */
export interface LedgerWalkItem {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed dollars: positive raises the balance, negative lowers it. */
  amount: number;
}

export interface LedgerWalkDay {
  date: string;
  /** End-of-day balance, `toFixed(2)`. */
  balance: string;
}

export interface LedgerWalkResult {
  /** One entry per day from `fromISO` through `toISO`, both inclusive. */
  daily: LedgerWalkDay[];
  /** The lowest end-of-day balance in the window, or the starting balance when no day went below it. */
  lowest: number;
  /** The first day that reached `lowest`; null when no day went below the starting balance. */
  lowestDate: string | null;
  /** The balance at the end of `toISO` (the starting balance for an empty window). */
  endingBalance: number;
}

const roundCents = (n: number): number => Math.round(n * 100) / 100;

function r2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * The balance at the START of `fromISO`: `anchorBalance` carried through every
 * leading item dated before it. The old loop, verbatim: it stops at the first
 * item dated on or after `fromISO`.
 */
export function rollForwardBalance(
  items: readonly LedgerWalkItem[],
  anchorBalance: number,
  fromISO: string,
): number {
  let bal = anchorBalance;
  for (const it of items) {
    if (it.date >= fromISO) break;
    bal = roundCents(bal + it.amount);
  }
  return bal;
}

/**
 * ⭐ Walk `items` day by day from `fromISO` through `toISO` (both inclusive),
 * starting from `startingBalance` — the balance at the start of `fromISO`
 * (`rollForwardBalance`). Leading items dated before the window are skipped:
 * the starting balance already holds them.
 *
 * `onApply` is called once for each item the walk applies, in the order it
 * applies them — `computeCashSignal` sums its projected income, expenses and
 * accepted impact through it, exactly where its own loop used to.
 */
export function walkLedger<T extends LedgerWalkItem>(
  items: readonly T[],
  startingBalance: number,
  fromISO: string,
  toISO: string,
  onApply?: (item: T) => void,
): LedgerWalkResult {
  const daily: LedgerWalkDay[] = [];
  let bal = startingBalance;
  let lowest = startingBalance;
  let lowestDate: string | null = null;

  let cursor = 0;
  // Skip items before the window (the starting balance already holds them).
  while (cursor < items.length && items[cursor]!.date < fromISO) cursor++;

  for (let dISO = fromISO; dISO <= toISO; dISO = addDaysISO(dISO, 1)) {
    while (cursor < items.length && items[cursor]!.date <= dISO) {
      const it = items[cursor]!;
      bal = roundCents(bal + it.amount);
      onApply?.(it);
      cursor++;
    }
    if (bal < lowest) {
      lowest = bal;
      lowestDate = dISO;
    }
    daily.push({ date: dISO, balance: r2(bal) });
  }
  return { daily, lowest, lowestDate, endingBalance: bal };
}
