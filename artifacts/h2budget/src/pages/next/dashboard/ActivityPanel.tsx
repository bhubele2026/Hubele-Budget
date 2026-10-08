import { displayAmount } from "@/lib/amountDisplay";
import { useMemo } from "react";
import { Link } from "wouter";
import { Panel, TxnTable, type TxnRow } from "@/components/next";
import { cardOrderOf, identityOf } from "@/lib/accountIdentity";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { useCategoriesQ, usePlaidItemsQ, useTxnsQ } from "./queries";
import { Gate, rise } from "./shared";

export const ACTIVITY_ROWS = 12;

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
    <Panel title="Recent activity" sub={`Newest ${ACTIVITY_ROWS} across accounts`} span={8} className={rise(6)} data-testid="dash-activity"
      actions={<Link href="/next/accounts" className="text-label font-semibold text-brand-navy underline">All accounts</Link>}>
      <Gate q={txns} what="Recent activity" rows={6}>{() => <TxnTable rows={rows} />}</Gate>
    </Panel>
  );
}
