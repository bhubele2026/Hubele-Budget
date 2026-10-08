import { useMemo } from "react";
import { Link } from "wouter";
import { AccountChip, Panel, shortDate } from "@/components/next";
import { identityOf } from "@/lib/accountIdentity";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { useSpine } from "@/hooks/useSpine";
import { cn, formatCurrency } from "@/lib/utils";
import { useCashSignalQ, useDebtsQ, useRecurringQ } from "./queries";
import { Empty, Gate, LinkRow, rise } from "./shared";

export const UPCOMING_DAYS = 14;
type Kind = "income" | "bill" | "card" | "debt";
const GROUPS: Array<{ kind: Kind; title: string }> = [
  { kind: "income", title: "Income" },
  { kind: "bill", title: "Bills" },
  { kind: "card", title: "Card payments" },
  { kind: "debt", title: "Debt payments" },
];

export default function UpcomingPanel() {
  const cash = useCashSignalQ(90);
  const debts = useDebtsQ();
  const recurring = useRecurringQ();
  const { data: spine } = useSpine();
  const today = householdToday(new Date());
  const end = addDaysISO(today, UPCOMING_DAYS);

  const groups = useMemo(() => {
    const debtById = new Map((debts.data ?? []).map((d) => [d.id, d]));
    const debtOfItem = new Map((recurring.data ?? []).map((r) => [r.id, r.debtId ?? null]));
    const out: Record<Kind, Array<{ key: string; date: string; label: string; amount: number }>> = { income: [], bill: [], card: [], debt: [] };
    (cash.data?.events ?? []).forEach((e, i) => {
      if (e.date < today || e.date > end) return;
      const amount = Number(e.amount);
      if (!Number.isFinite(amount)) return;
      const debt = e.itemId ? debtById.get(debtOfItem.get(e.itemId) ?? "") : undefined;
      const kind: Kind = amount > 0 ? "income" : debt ? ((debt.type ?? "").toLowerCase().includes("credit") ? "card" : "debt") : "bill";
      out[kind].push({ key: `${e.itemId ?? "x"}-${e.date}-${i}`, date: e.date, label: e.label, amount });
    });
    for (const k of Object.keys(out) as Kind[]) out[k].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }, [cash.data, debts.data, recurring.data, today, end]);

  const acct = cash.data?.account;
  const identity = acct && acct.via !== "unresolved"
    ? identityOf({ id: "cash", name: acct.name, mask: acct.mask, subtype: acct.subtype, type: "depository" })
    : null;
  const next = spine?.nextBill ?? null;
  const total = GROUPS.reduce((n, g) => n + groups[g.kind].length, 0);

  return (
    <Panel title="Upcoming 14 days" span={4} className={rise(3)} data-testid="dash-upcoming">
      <Gate q={cash} what="Upcoming" rows={5}>
        {() => (
          <div className="space-y-3">
            {next ? (
              <div className="rounded-control bg-platinum-3 px-3 py-2" data-testid="dash-next-bill">
                <div className="text-micro uppercase tracking-wide text-neutral-500">Next bill</div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-label font-semibold text-brand-navy">{next.name}</span>
                  <span className="font-mono text-label tabular-nums">{formatCurrency(Number(next.amount))}</span>
                </div>
                <div className="text-micro text-neutral-500">Due {shortDate(next.dueDate)}</div>
              </div>
            ) : null}
            {total === 0 ? <Empty>Nothing scheduled in the next {UPCOMING_DAYS} days.</Empty> : null}
            {GROUPS.map(({ kind, title }) =>
              groups[kind].length === 0 ? null : (
                <div key={kind} data-testid={`dash-up-${kind}`}>
                  <h3 className="text-label font-semibold text-brand-navy">{title}</h3>
                  <ul className="mt-1 list-none space-y-1 p-0">
                    {groups[kind].map((r) => (
                      <li key={r.key} className="flex items-center justify-between gap-2 text-label">
                        <span className="w-12 shrink-0 font-mono text-micro tabular-nums text-neutral-500">{shortDate(r.date)}</span>
                        <span className="min-w-0 flex-1 truncate">{r.label}</span>
                        <span className={cn("font-mono tabular-nums", r.amount < 0 ? "text-brand-ink" : "text-brand-navy")}>
                          {r.amount > 0 ? "+" : ""}{formatCurrency(r.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
            {identity ? <div className="flex items-center gap-2 text-micro text-neutral-500">Paid from <AccountChip identity={identity} size="sm" /></div> : null}
            <LinkRow>
              <Link href="/bills" className="text-brand-navy underline">Bills</Link>
              <Link href="/forecast" className="text-brand-navy underline">Forecast</Link>
            </LinkRow>
          </div>
        )}
      </Gate>
    </Panel>
  );
}
