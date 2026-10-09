import { displayAmount } from "@/lib/amountDisplay";
import { useMemo } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Panel, TxnTable, type TxnRow } from "@/components/next";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries } from "@/pages/next/accounts/entries";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { usePlaidItemsQ } from "./queries";
import { categoriesByIdOf, isInflowFiledAsExpense } from "@/lib/categoryDirection";
import { RECENT_WINDOW_DAYS, useCategoriesQ, useRecentTxnsQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { useFoldMinH } from "./foldDensity";
import { Gate, LINK, rise } from "./shared";

export const ACTIVITY_ROWS = 6;

/** The newest rows across every account, each with its account, status and
 *  category; the whole ledger is one click away. */
export default function ActivityPanel() {
  const minH = useFoldMinH("activity");
  const today = householdToday(new Date());
  // The shared recent window (one request with Needs attention); the newest 6 show here.
  const txns = useRecentTxnsQ(today, addDaysISO(today, -RECENT_WINDOW_DAYS));
  const items = usePlaidItemsQ();
  const cats = useCategoriesQ();

  const rows = useMemo<TxnRow[]>(() => {
    // Keyed by Plaid's EXTERNAL account_id — what `transaction.plaidAccountId`
    // holds. (Keying by the internal row id matched nothing: every row read "Account".)
    const byExt = new Map(buildEntries(items.data).map((e) => [e.plaidAccountId, e]));
    const catName = new Map((cats.data ?? []).map((c) => [c.id, c.name]));
    const catsById = categoriesByIdOf(cats.data);
    return (txns.data ?? []).slice(0, ACTIVITY_ROWS).map((t) => {
      // (WP7) The one route rule: a row opens the ledger that lists it, on its
      // month, or says why none does — never the checking ledger by default.
      const route = txnRoute(t, byExt);
      const identity = route.identity;
      return {
        id: t.id,
        date: t.occurredOn.slice(0, 10),
        description: t.description,
        amount: displayAmount(t.amount, identity, t.source),
        identity,
        pending: t.pending,
        category: t.categoryId ? catName.get(t.categoryId) ?? null : null,
        flag: isInflowFiledAsExpense(t, catsById) ? "Income in an expense category" : null,
        href: route.href ?? undefined,
        note: route.note,
      };
    });
  }, [txns.data, items.data, cats.data]);

  return (
    <Panel title="Recent activity" sub={`Newest ${ACTIVITY_ROWS} across accounts`} span={5}
      variant={["flush", "static"]}
      className={cn(rise(BELOW_FOLD.activity.rise), minH, "self-start")} data-testid="dash-activity"
      actions={<Link href="/transactions" className={cn(LINK, "text-label")} data-testid="dash-all-activity">All activity</Link>}>
      <Gate q={txns} what="Recent activity" rows={6}>{() => <TxnTable rows={rows} layout="list" />}</Gate>
    </Panel>
  );
}
