import { useMemo, useState } from "react";
import {
  useListTransactions,
  useListRecurringItems,
  type Transaction,
} from "@workspace/api-client-react";
import { CssBars, type CssBarRow } from "@/lib/cssBars";
import { householdDayOfAt } from "@/lib/householdDay";
import { isoDaysAgo, todayISO } from "@/lib/weeklyStreak";
import {
  isSplurge,
  makeRecurringMatcher,
  merchantKey,
  recurringMerchantsFrom,
} from "@/lib/discretionarySpend";
import { emptyNote, Foot } from "@/ui";

/**
 * (W3) "Biggest charges" — moved here from the Banking page, which is now the
 * bank-review screen. Same data and the same filter as before: one-off purchases
 * (`isSplurge` + the recurring-merchant screen), so bills, subscriptions,
 * transfers, card payments and reimbursables stay out. One bounded read (the
 * last 90 days, the same window the Banking page used).
 *
 * The order is largest first (display order only; no figure changes). `CssBars`
 * positions rows by rank itself and needs a stable input order, so the sort
 * happens once per load, not per render.
 */

/** Compact money for the bar list, where the column is ~90px wide. */
function barMoney(n: number): string {
  return `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

function shortDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(`${householdDayOfAt(iso)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? undefined
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function useNarrow(): boolean {
  const [narrow] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 640px)").matches,
  );
  return narrow;
}

/** `monthStart` is the first of the month shown (YYYY-MM-01). */
export function BiggestCharges({ monthStart, monthLabel }: { monthStart: string; monthLabel: string }) {
  const narrow = useNarrow();
  const now = new Date();
  const { data: txns } = useListTransactions({
    from: isoDaysAgo(now, 90),
    to: todayISO(now),
    limit: 1000,
  });
  const { data: recurringItems } = useListRecurringItems();
  const recurringNames = useMemo(() => (recurringItems ?? []).map((r) => r.name), [recurringItems]);

  const rows = useMemo<CssBarRow[]>(() => {
    const ym = monthStart.slice(0, 7);
    const isRecurring = makeRecurringMatcher(recurringNames);
    const recurringMerchants = recurringMerchantsFrom(txns ?? []);
    return (txns ?? [])
      .filter(
        (t: Transaction) =>
          t.occurredOn?.startsWith(ym) &&
          isSplurge(t, isRecurring) &&
          !recurringMerchants.has(merchantKey(t.description ?? "")),
      )
      .map((t: Transaction) => ({
        id: t.id,
        label: t.description || "Uncategorized charge",
        value: Math.abs(Number(t.amount) || 0),
        hint: shortDate(t.occurredOn),
      }))
      .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  }, [txns, recurringNames, monthStart]);

  return (
    <div data-testid="sp-biggest-charges">
      <h3 className="text-label font-semibold text-brand-navy">Biggest charges · {monthLabel}</h3>
      <p className="mt-0.5 text-micro text-neutral-500">
        One-off purchases, largest first. Bills, subscriptions, transfers and card payments are left out.
      </p>
      {rows.length ? (
        <>
          <div className="mt-2">
            <CssBars
              rows={rows}
              topN={8}
              ramp
              format={barMoney}
              labelWidth={narrow ? 104 : 170}
              valueWidth={narrow ? 78 : 104}
              ariaLabel={`Biggest charges in ${monthLabel}, largest first`}
            />
          </div>
          <Foot>Darkest bar is the largest charge. Amounts are the posted totals.</Foot>
        </>
      ) : (
        <div className={emptyNote}>No one-off charges this month.</div>
      )}
    </div>
  );
}
