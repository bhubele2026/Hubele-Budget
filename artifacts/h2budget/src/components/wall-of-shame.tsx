import { useMemo } from "react";
import type { Transaction } from "@workspace/api-client-react";
import {
  isSplurge,
  makeRecurringMatcher,
  merchantKey,
  recurringMerchantsFrom,
} from "@/lib/discretionarySpend";

const fmt$ = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/**
 * Wall of Shame — the month's three most reckless single charges, ranked on a
 * podium and roasted. Numbers come straight from the transactions (we never
 * invent a figure); the captions are the savage voice wrapped around them. Aims
 * at the PURCHASE, never the person. Hidden until there's at least one charge.
 */

type Crime = { desc: string; amt: number; member: string | null; date: string };

const PODIUM = [
  {
    medal: "1",
    title: "Largest charge",
    grad: "tile-grad-5",
    quip: (m: string | null) =>
      m ? `${m}'s biggest single purchase this month.` : "The month's biggest single purchase.",
  },
  {
    medal: "2",
    title: "Second largest",
    grad: "tile-grad-3",
    quip: (m: string | null) =>
      m ? `${m}'s second-biggest purchase this month.` : "The second-biggest purchase this month.",
  },
  {
    medal: "3",
    title: "Third largest",
    grad: "tile-grad-1",
    quip: () => "The third-biggest purchase this month.",
  },
];

export function WallOfShame({
  transactions,
  recurringNames = [],
  className,
}: {
  transactions: Transaction[];
  /** Household recurring-item names, so subscriptions/bills are excluded. */
  recurringNames?: string[];
  className?: string;
}) {
  const crimes = useMemo<Crime[]>(() => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const isRecurring = makeRecurringMatcher(recurringNames);
    const recurringMerchants = recurringMerchantsFrom(transactions);
    return (transactions ?? [])
      .filter(
        (t) =>
          t.occurredOn?.startsWith(ym) &&
          isSplurge(t, isRecurring) &&
          !recurringMerchants.has(merchantKey(t.description ?? "")),
      )
      .map((t) => ({
        desc: t.description || "Something",
        amt: Number(t.amount) || 0,
        member: t.member ?? null,
        date: t.occurredOn,
      }))
      .sort((a, b) => a.amt - b.amt)
      .slice(0, 3);
  }, [transactions, recurringNames]);

  if (crimes.length === 0) return null;

  return (
    <div className={className}>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-lg font-bold">Biggest charges this month</h2>
        <span className="text-xs text-muted-foreground">
          your largest single purchases, ranked
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {crimes.map((c, i) => {
          const p = PODIUM[i];
          return (
            <div
              key={`${c.desc}-${c.date}-${i}`}
              className={`stat-card ${p.grad} relative overflow-hidden rounded-[1.25rem] p-4 text-white`}
            >
              <div className="relative z-10">
                <div className="flex items-center justify-between">
                  <span className="text-2xl">{p.medal}</span>
                  <span className="text-[10px] font-bold uppercase tracking-widest text-white/85">
                    {p.title}
                  </span>
                </div>
                <div className="mt-3 truncate text-base font-semibold" title={c.desc}>
                  {c.desc}
                </div>
                <div className="mt-0.5 text-3xl font-bold tabular-nums leading-none drop-shadow-sm">
                  {fmt$(c.amt)}
                </div>
                <p className="mt-2 text-xs font-medium leading-snug text-white/90">
                  {p.quip(c.member)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
