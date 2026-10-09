import { displayAmount } from "@/lib/amountDisplay";
import { useMemo } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Panel, TxnTable, type TxnRow } from "@/components/next";
import { cardOrderOf, identityOf } from "@/lib/accountIdentity";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { usePlaidItemsQ } from "./queries";
import { useCategoriesQ, useTxnsQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { Gate, LINK, rise } from "./shared";

export const ACTIVITY_ROWS = 6;

/** The newest rows across every account, each with its account, status and
 *  category; the whole ledger is one click away. */
export default function ActivityPanel() {
  const today = householdToday(new Date());
  const txns = useTxnsQ({ from: addDaysISO(today, -30), to: today, limit: ACTIVITY_ROWS });
  const items = usePlaidItemsQ();
  const cats = useCategoriesQ();

  const rows = useMemo<TxnRow[]>(() => {
    const accounts = (items.data ?? []).flatMap((it) =>
      it.accounts.map((a) => ({
        id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
        institutionName: it.institutionName, institutionSlug: it.institutionSlug,
      })),
    );
    const order = cardOrderOf(accounts);
    const byId = new Map(accounts.map((a) => [a.id, identityOf(a, { cardOrder: order })]));
    const catName = new Map((cats.data ?? []).map((c) => [c.id, c.name]));
    return (txns.data ?? []).slice(0, ACTIVITY_ROWS).map((t) => {
      const identity =
        (t.plaidAccountId ? byId.get(t.plaidAccountId) : undefined) ??
        identityOf({ id: t.plaidAccountId ?? `manual-${t.id}`, name: t.account });
      return {
        id: t.id,
        date: t.occurredOn.slice(0, 10),
        description: t.description,
        amount: displayAmount(t.amount, identity),
        identity,
        pending: t.pending,
        category: t.categoryId ? catName.get(t.categoryId) ?? null : null,
        href: t.plaidAccountId ? `/next/accounts/${t.plaidAccountId}` : "/transactions",
      };
    });
  }, [txns.data, items.data, cats.data]);

  return (
    <Panel title="Recent activity" sub={`Newest ${ACTIVITY_ROWS} across accounts`} span={5}
      variant={["flush", "static"]}
      className={cn(rise(BELOW_FOLD.activity.rise), BELOW_FOLD.activity.minH)} data-testid="dash-activity"
      actions={<Link href="/transactions" className={cn(LINK, "text-label")} data-testid="dash-all-activity">All activity</Link>}>
      <Gate q={txns} what="Recent activity" rows={6}>{() => <TxnTable rows={rows} layout="list" />}</Gate>
    </Panel>
  );
}
