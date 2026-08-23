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
 * Biggest charges — the month's three largest single discretionary purchases,
 * ranked on a podium. Numbers come straight from the transactions (we never
 * invent a figure). Hidden until there's at least one charge.
 *
 * Light-first design: white card, a strong colored left rail + soft tint wash
 * in the rank's brand hue, matte ink. Works unchanged in dark (tokens flip).
 */

type Charge = { desc: string; amt: number; member: string | null; date: string };

const PODIUM = [
  {
    medal: "1",
    title: "Largest charge",
    accent: "--chart-1",
    quip: (m: string | null) =>
      m ? `${m}'s biggest single purchase this month.` : "The month's biggest single purchase.",
  },
  {
    medal: "2",
    title: "Second largest",
    accent: "--primary",
    quip: (m: string | null) =>
      m ? `${m}'s second-biggest purchase this month.` : "The second-biggest purchase this month.",
  },
  {
    medal: "3",
    title: "Third largest",
    accent: "--chart-2",
    quip: () => "The third-biggest purchase this month.",
  },
];

export function BiggestCharges({
  transactions,
  recurringNames = [],
  className,
}: {
  transactions: Transaction[];
  /** Household recurring-item names, so subscriptions/bills are excluded. */
  recurringNames?: string[];
  className?: string;
}) {
  const charges = useMemo<Charge[]>(() => {
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

  if (charges.length === 0) return null;

  return (
    <div className={className}>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-lg font-bold">Biggest charges this month</h2>
        <span className="text-xs text-muted-foreground">
          your largest single purchases, ranked
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {charges.map((c, i) => {
          const p = PODIUM[i];
          return (
            <div
              key={`${c.desc}-${c.date}-${i}`}
              className="relative overflow-hidden rounded-xl border border-card-border bg-card p-4 shadow-sm"
              style={{
                borderLeft: `4px solid hsl(var(${p.accent}))`,
                backgroundImage: `linear-gradient(135deg, hsl(var(${p.accent}) / 0.09), transparent 55%)`,
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="grid h-7 w-7 place-items-center rounded-full text-[13px] font-bold text-white"
                  style={{ background: `hsl(var(${p.accent}))` }}
                >
                  {p.medal}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {p.title}
                </span>
              </div>
              <div
                className="mt-3 truncate text-base font-semibold text-foreground"
                title={c.desc}
              >
                {c.desc}
              </div>
              <div className="mt-0.5 text-3xl font-bold tabular-nums leading-none text-foreground">
                {fmt$(c.amt)}
              </div>
              <p className="mt-2 text-xs font-medium leading-snug text-muted-foreground">
                {p.quip(c.member)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
