import { expect } from "vitest";
import type { CashSignal } from "../../lib/cashSignal";

/** Dollars as integer cents (every figure the signal serves is `toFixed(2)`). */
const cents = (v: string | number | null | undefined): number => Math.round(Number(v) * 100);

/**
 * ⭐ (T3) `CashSignal.dayItems` IS THE WALK, READ BACK — never a second sum.
 *
 * For any cash signal:
 *   - every day: the previous close (`startingBalance` before the first day)
 *     plus that day's items is that day's close, to the cent;
 *   - Σ positive items = `projectedIncome`; Σ the rest, negated = `projectedExpenses`;
 *   - `startingBalance + projectedIncome − projectedExpenses = endingBalance`;
 *   - Σ matched bank rows = `acceptedImpact`;
 *   - every item sits inside the window, on a day the series has;
 *   - the planned expenses below zero are exactly `events` (same occurrence,
 *     day, label and amount), so the chart markers and the day panel agree;
 *   - the low point is the lowest plotted day (or nothing fell below the start).
 */
export function expectDayItemsReconcile(sig: CashSignal, what = "signal"): void {
  const daily = sig.daily ?? [];
  const items = sig.dayItems ?? [];
  expect(sig.dayItems, `${what}: dayItems present`).toBeDefined();
  const days = new Set(daily.map((d) => d.date));

  const byDay = new Map<string, number>();
  for (const it of items) {
    expect(days.has(it.date), `${what}: ${it.date} is a day of the series`).toBe(true);
    expect(it.date >= sig.fromDate! && it.date <= sig.toDate!, `${what}: ${it.date} inside the window`).toBe(true);
    if (it.kind === "bank_row") {
      expect(typeof it.txnId, `${what}: a bank row names its row`).toBe("string");
    } else {
      expect(it.kind, `${what}: the walk's sign rule`).toBe(cents(it.amount) > 0 ? "income" : "expense");
      expect(it.occurrenceKey, `${what}: the resolution key`).toBe(`${it.itemId}|${it.occurrenceDate}`);
    }
    byDay.set(it.date, (byDay.get(it.date) ?? 0) + cents(it.amount));
  }

  let prev = cents(sig.startingBalance);
  for (const d of daily) {
    const close = cents(d.balance);
    expect(prev + (byDay.get(d.date) ?? 0), `${what}: ${d.date} opening + items = close`).toBe(close);
    prev = close;
  }

  const inSum = items.reduce((s, it) => s + (cents(it.amount) > 0 ? cents(it.amount) : 0), 0);
  const outSum = items.reduce((s, it) => s + (cents(it.amount) > 0 ? 0 : -cents(it.amount)), 0);
  expect(inSum, `${what}: Σ in = projectedIncome`).toBe(cents(sig.projectedIncome));
  expect(outSum, `${what}: Σ out = projectedExpenses`).toBe(cents(sig.projectedExpenses));
  expect(
    cents(sig.startingBalance) + cents(sig.projectedIncome) - cents(sig.projectedExpenses),
    `${what}: start + in − out = end`,
  ).toBe(cents(sig.endingBalance));
  const matched = items.reduce((s, it) => s + (it.kind === "bank_row" && it.matched ? cents(it.amount) : 0), 0);
  expect(matched, `${what}: Σ matched bank rows = acceptedImpact`).toBe(cents(sig.acceptedImpact));

  const key = (e: { date: string; occurrenceKey?: string; label?: string; amount: string }) =>
    `${e.date}#${e.occurrenceKey}#${e.label}#${cents(e.amount)}`;
  const planned = items.filter((it) => it.kind === "expense" && cents(it.amount) < 0).map(key).sort();
  expect(planned, `${what}: planned expenses = events`).toEqual((sig.events ?? []).map(key).sort());

  if (daily.length > 0) {
    const min = Math.min(...daily.map((d) => cents(d.balance)));
    if (sig.lowestDate) {
      expect(cents(sig.lowestProjected), `${what}: low point = lowest plotted day`).toBe(min);
      expect(daily.find((d) => cents(d.balance) === min)?.date, `${what}: low point date = first lowest day`).toBe(sig.lowestDate);
    } else {
      expect(min >= cents(sig.startingBalance), `${what}: no low point → nothing below the start`).toBe(true);
    }
  }
}
