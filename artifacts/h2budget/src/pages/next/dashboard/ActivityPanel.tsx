import { displayAmount } from "@/lib/amountDisplay";
import { useMemo } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Panel, TxnTable, type TxnRow } from "@/components/next";
import { resolveTxnAccount } from "@/lib/accountIdentity";
import { buildEntries } from "@/pages/next/accounts/entries";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { usePlaidItemsQ, useTxnsQ } from "./queries";
import { useCategoriesQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { Gate, rise } from "./shared";

export const ACTIVITY_ROWS = 12;

export default function ActivityPanel() {
  const today = householdToday(new Date());
  const txns = useTxnsQ({ from: addDaysISO(today, -30), to: today, limit: ACTIVITY_ROWS });
  const items = usePlaidItemsQ();
  const cats = useCategoriesQ();

  const rows = useMemo<TxnRow[]>(() => {
    // Keyed by Plaid's EXTERNAL account_id — what `transaction.plaidAccountId`
    // holds. (Keying by the internal row id matched nothing: every row read "Account".)
    const byExt = new Map(buildEntries(items.data).map((e) => [e.plaidAccountId, e]));
    const catName = new Map((cats.data ?? []).map((c) => [c.id, c.name]));
    return (txns.data ?? []).slice(0, ACTIVITY_ROWS).map((t) => {
      const identity = resolveTxnAccount(t, byExt);
      return {
        id: t.id,
        date: t.occurredOn.slice(0, 10),
        description: t.description,
        amount: displayAmount(t.amount, identity),
        identity,
        pending: t.pending,
        category: t.categoryId ? catName.get(t.categoryId) ?? null : null,
        href: identity.known && t.plaidAccountId ? `/next/accounts/${encodeURIComponent(t.plaidAccountId)}` : "/transactions",
      };
    });
  }, [txns.data, items.data, cats.data]);

  return (
    <Panel title="Recent activity" sub={`Newest ${ACTIVITY_ROWS} across accounts`} span={8} className={cn(rise(BELOW_FOLD.activity.rise), BELOW_FOLD.activity.minH)} data-testid="dash-activity"
      actions={<Link href="/next/accounts" className="text-label font-semibold text-brand-navy underline">All accounts</Link>}>
      <Gate q={txns} what="Recent activity" rows={6}>{() => <TxnTable rows={rows} />}</Gate>
    </Panel>
  );
}
