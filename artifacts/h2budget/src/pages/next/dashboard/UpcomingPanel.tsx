import { useMemo } from "react";
import { Link } from "wouter";
import type { CashSignal, Debt, RecurringItem, SpineNextBill } from "@workspace/api-client-react";
import { AccountChip, Panel } from "@/components/next";
import { identityOf } from "@/lib/accountIdentity";
import { frequencyWord } from "@/lib/billsRowAmount";
import { householdToday } from "@/lib/householdDay";
import { useSpine } from "@/hooks/useSpine";
import { cn } from "@/lib/utils";
import { useCashSignalQ, useDebtsQ } from "./queries";
import { useRecurringQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { useFoldMinH } from "./foldDensity";
import { Empty, Gate, LINK, money, rise, weekdayLabel } from "./shared";

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
  /** This row is the spine's next bill (same item name and due day). */
  isNextBill: boolean;
}

/**
 * The next N obligations on the cash curve, from the cash signal's own events:
 * money out only, today or later, soonest first. Each amount is that ONE
 * payment as the forecast pays it. A hook item (Weekly/Monthly Spend) is the
 * card payoff the forecast puts in its place, so it is labelled as such with
 * the item's own plan amount beside it. Pure.
 */
export function upcomingRows(i: {
  signal: Pick<CashSignal, "events" | "hookAmountIgnored"> | undefined;
  recurring: readonly Pick<RecurringItem, "id" | "frequency" | "debtId">[] | undefined;
  debts: readonly Pick<Debt, "id" | "type">[] | undefined;
  nextBill: SpineNextBill | null | undefined;
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
    const due = e.occurrenceDate ?? e.originalDate ?? e.date;
    rows.push({
      key: e.occurrenceKey ?? `${e.itemId ?? "x"}-${e.date}-${idx}`,
      date: e.date,
      label: e.label,
      amount,
      frequency: frequencyWord(hook?.cadence ?? item?.frequency),
      kind: debt ? ((debt.type ?? "").toLowerCase().includes("credit") ? "card" : "debt") : "bill",
      hook: hook ? { storedAmount: Math.abs(Number(hook.storedAmount)), cadence: hook.cadence } : null,
      isNextBill: !!i.nextBill && i.nextBill.name === e.label && (i.nextBill.dueDate === due || i.nextBill.dueDate === e.date),
    });
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows.slice(0, i.count ?? UPCOMING_COUNT);
}

const KIND_WORD: Record<UpcomingRow["kind"], string | null> = { bill: null, card: "card payment", debt: "debt payment" };

export default function UpcomingPanel() {
  const minH = useFoldMinH("upcoming");
  const cash = useCashSignalQ(90);
  const debts = useDebtsQ();
  const recurring = useRecurringQ();
  const { data: spine } = useSpine();
  const today = householdToday(new Date());

  const rows = useMemo(
    () => upcomingRows({ signal: cash.data, recurring: recurring.data, debts: debts.data, nextBill: spine?.nextBill, today }),
    [cash.data, recurring.data, debts.data, spine?.nextBill, today],
  );
  const payday = useMemo(() => {
    const e = (cash.data?.events ?? []).filter((x) => Number(x.amount) > 0 && x.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    return e ? { date: e.date, label: e.label, amount: Number(e.amount) } : null;
  }, [cash.data, today]);

  const acct = cash.data?.account;
  const identity = acct && acct.via !== "unresolved"
    ? identityOf({ id: "cash", name: acct.name, mask: acct.mask, subtype: acct.subtype, type: "depository" })
    : null;

  return (
    <Panel
      title="Coming up"
      sub={`Next ${UPCOMING_COUNT} payments the forecast expects`}
      span={4}
      variant="static"
      className={cn(rise(BELOW_FOLD.upcoming.rise), minH)}
      data-testid="dash-upcoming"
      bodyClassName="flex flex-col"
    >
      <Gate q={cash} what="Coming up" rows={5}>
        {() => (
          <div className="flex flex-1 flex-col">
            {identity ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-micro text-neutral-500" data-testid="dash-up-from">
                Paid from <AccountChip identity={identity} size="sm" wrap />
              </div>
            ) : null}
            {rows.length === 0 ? <Empty>Nothing is scheduled to go out.</Empty> : (
              <ul className="list-none divide-y divide-brand-line p-0" data-testid="dash-up-list">
                {rows.map((r) => (
                  <li key={r.key} data-testid="dash-up-row" data-next-bill={r.isNextBill ? "true" : undefined}
                    className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2">
                    <span className="font-mono text-micro tabular-nums text-neutral-500">{weekdayLabel(r.date)}</span>
                    <span className="min-w-0">
                      <span className="block text-label font-medium text-brand-ink [overflow-wrap:anywhere]">{r.label}</span>
                      <span className="block text-micro text-neutral-500">
                        {[r.frequency, KIND_WORD[r.kind]].filter(Boolean).join(" · ")}
                        {r.hook ? (
                          <span data-testid="dash-up-hook">
                            {r.frequency || KIND_WORD[r.kind] ? " · " : ""}card payoff · plan {money(r.hook.storedAmount)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="font-mono text-label tabular-nums text-brand-ink" data-testid="dash-up-amount">
                      {money(Math.abs(r.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {payday ? (
              <p className="mt-2 border-t border-brand-line pt-2 text-micro text-neutral-500" data-testid="dash-up-payday">
                Next money in: <span className="font-medium text-neutral-700">{payday.label}</span>{" "}
                <span className="font-mono tabular-nums text-brand-navy">+{money(payday.amount)}</span> on {weekdayLabel(payday.date)}
              </p>
            ) : null}
            <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-3 text-label">
              <Link href="/bills" className={LINK} data-testid="dash-all-bills">All bills</Link>
              <Link href="/forecast" className={LINK}>Forecast</Link>
            </div>
          </div>
        )}
      </Gate>
    </Panel>
  );
}
