import type { CashSignal, Debt, RecurringItem } from "@workspace/api-client-react";
import { frequencyWord } from "@/lib/billsRowAmount";
import type { DueBill } from "@/lib/attention";
import { money, weekdayLabel } from "./shared";

/**
 * ⭐ ONE NEXT OBLIGATION, ONE AMOUNT. Everything on the dashboard that names a
 * payment about to leave checking (the header's "Next:", Needs attention's
 * "due today / tomorrow", the Coming up list) reads it from HERE: the cash
 * signal's own events, which are hook-aware and are what the forecast takes
 * out of checking. A Weekly/Monthly Spend hook is the CARD PAYOFF the forecast
 * puts in place of the item's stored amount, so it is worded the same way
 * everywhere: "Weekly Spend · card payoff $477.57 (plan $450)".
 *
 * (The morning text and the Bills page quote the bills summary instead: the
 * single STORED payment, $450 for that hook — see the refinement review note.)
 */
export const UPCOMING_COUNT = 5;

export interface UpcomingRow {
  key: string;
  date: string;
  label: string;
  /** One payment, signed like the plan (negative is money out). */
  amount: number;
  frequency: string | null;
  kind: "bill" | "card" | "debt";
  /** A Weekly/Monthly Spend hook: the forecast pays the card payoff, not the item's own amount. */
  hook: { storedAmount: number; cadence: string } | null;
}

/** The next obligations on the cash curve: money out only, today or later,
 *  soonest first (stable within a day). Pure. */
export function upcomingRows(i: {
  signal: Pick<CashSignal, "events" | "hookAmountIgnored"> | undefined;
  recurring?: readonly Pick<RecurringItem, "id" | "frequency" | "debtId">[] | undefined;
  debts?: readonly Pick<Debt, "id" | "type">[] | undefined;
  today: string;
  count?: number;
}): UpcomingRow[] {
  const byItem = new Map((i.recurring ?? []).map((r) => [r.id, r]));
  const debtById = new Map((i.debts ?? []).map((d) => [d.id, d]));
  const hooks = new Map((i.signal?.hookAmountIgnored ?? []).map((h) => [h.itemId, h]));
  const rows: UpcomingRow[] = [];
  (i.signal?.events ?? []).forEach((e, idx) => {
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount >= 0 || e.date < i.today) return;
    const item = e.itemId ? byItem.get(e.itemId) : undefined;
    const debt = item?.debtId ? debtById.get(item.debtId) : undefined;
    const hook = e.itemId ? hooks.get(e.itemId) : undefined;
    rows.push({
      key: e.occurrenceKey ?? `${e.itemId ?? "x"}-${e.date}-${idx}`,
      date: e.date,
      label: e.label,
      amount,
      frequency: frequencyWord(hook?.cadence ?? item?.frequency),
      kind: debt ? ((debt.type ?? "").toLowerCase().includes("credit") ? "card" : "debt") : "bill",
      hook: hook ? { storedAmount: Math.abs(Number(hook.storedAmount)), cadence: hook.cadence } : null,
    });
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows.slice(0, i.count ?? UPCOMING_COUNT);
}

/** "$450" for a round plan amount, "$451.20" otherwise. */
function planMoney(n: number): string {
  return money(n).replace(/\.00$/, "");
}

/** "Mortgage $1,650.00" · "Weekly Spend · card payoff $477.57 (plan $450)". */
export function obligationWords(r: Pick<UpcomingRow, "label" | "amount" | "hook">): string {
  const out = money(Math.abs(r.amount));
  return r.hook ? `${r.label} · card payoff ${out} (plan ${planMoney(r.hook.storedAmount)})` : `${r.label} ${out}`;
}

/** The words plus the day: "Weekly Spend · card payoff $477.57 (plan $450) · Sat Oct 10". */
export function obligationLine(r: Pick<UpcomingRow, "label" | "amount" | "hook" | "date">): string {
  return `${obligationWords(r)} · ${weekdayLabel(r.date)}`;
}

/** What leaves checking today or tomorrow, as Needs attention's "due soon"
 *  items, worded like everywhere else. Pure. */
export function dueSoonOf(rows: readonly UpcomingRow[], today: string, tomorrow: string): DueBill[] {
  return rows
    .filter((r) => r.date === today || r.date === tomorrow)
    .map((r) => ({ name: r.label, amount: Math.abs(r.amount), dueOn: r.date, label: obligationWords(r) }));
}
