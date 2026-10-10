import { displayAmount } from "@/lib/amountDisplay";
import { useMemo } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Panel, TxnTable, type TxnRow } from "@/components/next";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries } from "@/pages/next/accounts/entries";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { usePlaidItemsQ } from "./queries";
import { accountTypesOf, categoriesByIdOf, isCardTxn, isInflowFiledAsExpense } from "@/lib/categoryDirection";
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
  // (WP7 review) Where a Plaid row opens needs the linked accounts. Until they
  // answer (or when they failed) such a row has no link and no note, and its
  // chip names only the institution: an empty list must never read as "no
  // longer linked".
  const accountsKnown = items.data !== undefined;

  const rows = useMemo<TxnRow[]>(() => {
    // Keyed by Plaid's EXTERNAL account_id — what `transaction.plaidAccountId`
    // holds. (Keying by the internal row id matched nothing: every row read "Account".)
    const byExt = new Map(buildEntries(items.data).map((e) => [e.plaidAccountId, e]));
    const catName = new Map((cats.data ?? []).map((c) => [c.id, c.name]));
    const catsById = categoriesByIdOf(cats.data);
    // (WP5c) A card's credit is never "income": the flag waits for the bank
    // items, which say which accounts are cards.
    const types = items.data === undefined ? null : accountTypesOf(items.data);
    return (txns.data ?? []).slice(0, ACTIVITY_ROWS).map((t) => {
      // (WP7) The one route rule: a row opens the ledger that lists it, on its
      // month, or says why none does — never the checking ledger by default.
      const route = txnRoute(t, byExt, { entriesKnown: accountsKnown });
      const identity = route.identity;
      return {
        id: t.id,
        date: t.occurredOn.slice(0, 10),
        description: t.description,
        amount: displayAmount(t.amount, identity, t.source),
        identity,
        pending: t.pending,
        category: t.categoryId ? catName.get(t.categoryId) ?? null : null,
        flag:
          types && isInflowFiledAsExpense(t, catsById, { isCardAccount: isCardTxn(t, types) })
            ? "Income in an expense category"
            : null,
        href: route.href ?? undefined,
        note: route.note,
      };
    });
  }, [txns.data, items.data, cats.data, accountsKnown]);

  return (
    <Panel title="Recent activity" sub={`Newest ${ACTIVITY_ROWS} across accounts`} span={5}
      variant={["flush", "static"]}
      className={cn(rise(BELOW_FOLD.activity.rise), minH, "self-start")} data-testid="dash-activity"
      actions={<Link href="/transactions" className={cn(LINK, "text-label")} data-testid="dash-all-activity">All activity</Link>}>
      <Gate q={txns} what="Recent activity" rows={6}>
        {() => (
          <>
            {!accountsKnown && items.isError ? (
              <p role="alert" data-testid="dash-activity-accounts-failed"
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-2 text-label text-neutral-600">
                <span>Your linked accounts did not load, so these rows are not linked to them.</span>
                <button type="button" onClick={() => void items.refetch()} className="font-semibold text-brand-navy underline">
                  Try again
                </button>
              </p>
            ) : null}
            <TxnTable rows={rows} layout="list" />
          </>
        )}
      </Gate>
    </Panel>
  );
}
