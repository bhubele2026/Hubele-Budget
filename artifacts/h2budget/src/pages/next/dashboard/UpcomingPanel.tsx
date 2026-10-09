import { useMemo } from "react";
import { Link } from "wouter";
import { AccountChip, Panel } from "@/components/next";
import { identityOf } from "@/lib/accountIdentity";
import { householdToday } from "@/lib/householdDay";
import { cn } from "@/lib/utils";
import { useCashSignalQ, useDebtsQ } from "./queries";
import { useRecurringQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { useFoldMinH } from "./foldDensity";
import { Empty, Gate, LINK, money, rise, weekdayLabel } from "./shared";
import { UPCOMING_COUNT, upcomingRows, type UpcomingRow } from "./obligations";

export { UPCOMING_COUNT, upcomingRows, type UpcomingRow } from "./obligations";

const KIND_WORD: Record<UpcomingRow["kind"], string | null> = { bill: null, card: "card payment", debt: "debt payment" };

export default function UpcomingPanel() {
  const minH = useFoldMinH("upcoming");
  const cash = useCashSignalQ(90);
  const debts = useDebtsQ();
  const recurring = useRecurringQ();
  const today = householdToday(new Date());

  const rows = useMemo(
    () => upcomingRows({ signal: cash.data, recurring: recurring.data, debts: debts.data, today }),
    [cash.data, recurring.data, debts.data, today],
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
                {rows.map((r, idx) => (
                  <li key={r.key} data-testid="dash-up-row" data-next={idx === 0 ? "true" : undefined}
                    className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2">
                    <span className="font-mono text-micro tabular-nums text-neutral-500">{weekdayLabel(r.date)}</span>
                    <span className="min-w-0">
                      <span className="block text-label font-medium text-brand-ink [overflow-wrap:anywhere]">{r.label}</span>
                      <span className="block text-micro text-neutral-500">
                        {[r.frequency, KIND_WORD[r.kind]].filter(Boolean).join(" · ")}
                        {r.hook ? (
                          <span data-testid="dash-up-hook">
                            {r.frequency || KIND_WORD[r.kind] ? " · " : ""}card payoff (plan {money(r.hook.storedAmount).replace(/\.00$/, "")})
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
