import { lazy, Suspense, useMemo } from "react";
import { useRoute } from "wouter";
import {
  useGetAmexWeeklyPayoff, useGetForecast, useListCategories, useListDebts,
  useListPlaidItems, useListTransactions,
} from "@workspace/api-client-react";
import { Page, emptyNote } from "@/ui";
import { PageGrid, Panel, TxnTable, type TxnRow } from "@/components/next";
import { AccountPageSkeleton } from "@/components/account-page/account-page-skeleton";
import { displayAmount } from "@/lib/amountDisplay";
import { identityOf } from "@/lib/accountIdentity";
import { householdToday } from "@/lib/householdDay";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import { AccountSelector, type BalanceByRow } from "./accounts/AccountSelector";
import { AccountSummary } from "./accounts/AccountSummary";
import { buildEntries } from "./accounts/entries";

// Both ledgers are the existing pages, moved in whole (same hooks, bulk bars,
// dialogs and tests). Lazy, so nothing here joins the landing bundle.
const AmexLedger = lazy(() => import("@/pages/amex"));
const ChaseLedger = lazy(() => import("@/pages/transactions"));

function daysBack(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

function CombinedActivity({ entries }: { entries: ReturnType<typeof buildEntries> }) {
  const today = useMemo(() => householdToday(new Date()), []);
  const { data: txns, isLoading } = useListTransactions({ from: daysBack(today, 30), to: today, limit: 100 });
  const { data: cats } = useListCategories();
  const rows = useMemo<TxnRow[]>(() => {
    const byExt = new Map(entries.map((e) => [e.plaidAccountId, e]));
    const catName = new Map((cats ?? []).map((c) => [c.id, c.name]));
    const manual = identityOf({ id: "manual", name: "Manual", institutionName: "Manual entry" });
    return (txns ?? []).map((t) => {
      const e = t.plaidAccountId ? byExt.get(t.plaidAccountId) : undefined;
      return {
        id: t.id,
        date: t.occurredOn.slice(0, 10),
        description: t.displayName ?? t.description,
        amount: displayAmount(t.amount, e?.identity ?? manual),
        identity: e?.identity ?? manual,
        pending: t.pending,
        category: t.categoryId ? catName.get(t.categoryId) ?? null : null,
        href: e ? `/next/accounts/${encodeURIComponent(e.plaidAccountId)}` : undefined,
      };
    });
  }, [txns, cats, entries]);
  if (isLoading) return <AccountPageSkeleton tiles={2} />;
  return (
    <Panel title="Recent activity" sub="Last 30 days, every account. Pick an account to review and edit." span={12} data-testid="combined-activity">
      {rows.length ? <TxnTable rows={rows} /> : <p className={emptyNote}>No activity in the last 30 days.</p>}
    </Panel>
  );
}

export default function NextAccountsPage() {
  const [, params] = useRoute("/next/accounts/:plaidAccountId");
  const selectedId = params?.plaidAccountId ? decodeURIComponent(params.plaidAccountId) : null;
  const { data: items, isLoading } = useListPlaidItems();
  const { data: debts } = useListDebts();
  const { data: payoff } = useGetAmexWeeklyPayoff();
  const { data: forecast } = useGetForecast({ days: 90 });
  const entries = useMemo(() => buildEntries(items), [items]);
  // The id may be the Plaid account_id or the items response's row id.
  const selected = entries.find((e) => e.plaidAccountId === selectedId || e.rowId === selectedId) ?? null;

  const debtFor = (rowId: string) => (debts ?? []).find((d) => d.plaidAccountId === rowId) ?? null;
  const snapshotFor = (rowId: string) =>
    deriveEffectiveSnapshot({
      bankSnapshot: forecast?.bankSnapshot ?? null,
      accountSnapshots: forecast?.accountSnapshots ?? {},
      selectedAccountInternalId: rowId,
      plaidCheckingAccounts: forecast?.plaidCheckingAccounts ?? [],
    });
  const balances: BalanceByRow = {};
  for (const e of entries) {
    balances[e.rowId] = e.identity.isCard ? debtFor(e.rowId)?.balance : e.identity.kind === "checking" ? snapshotFor(e.rowId)?.balance : undefined;
  }

  return (
    <div data-testid="page-next-accounts">
      <Page title={selected ? selected.identity.label : "Accounts"} sub={selected ? undefined : "Every card and bank in one place"}>
        <PageGrid>
          <div className="span-12 min-w-0">
            {isLoading ? (
              <AccountPageSkeleton tiles={2} />
            ) : entries.length ? (
              <AccountSelector entries={entries} selectedId={selected?.plaidAccountId ?? null} balances={balances} />
            ) : (
              <p className={emptyNote}>No linked accounts yet.</p>
            )}
            {selectedId && !selected && !isLoading ? (
              <p role="status" className="mt-2 text-label text-neutral-600">That account is not linked here. Showing all accounts.</p>
            ) : null}
          </div>
          {selected && !selected.identity.isCard && selected.identity.kind === "checking" ? (
            // (C9) One account experience: a checking account opens the Chase
            // page's own layout (the same as /transactions, minus the title the
            // account page already shows), full width, with the Summary as the
            // first panel of its figures row. Nothing between this cell and the
            // ledger is a scroll container: the ledger panel inside is
            // sticky-safe, so its pane and bulk bar stick to <main>.
            <div className="span-12 min-w-0" data-testid="account-activity">
              <Suspense fallback={<AccountPageSkeleton tiles={3} />}>
                <ChaseLedger
                  embedded
                  accountKey={selected.rowId}
                  lead={
                    <AccountSummary
                      entry={selected}
                      debt={debtFor(selected.rowId)}
                      payoffCard={null}
                      snapshot={snapshotFor(selected.rowId)}
                    />
                  }
                />
              </Suspense>
            </div>
          ) : selected && selected.identity.isCard ? (
            // (C10) A card opens the Amex page's own layout the same way: full
            // width, the card's Summary first in its card row, the ledger in
            // its own sticky-safe panel.
            <div className="span-12 min-w-0" data-testid="account-activity">
              <Suspense fallback={<AccountPageSkeleton tiles={3} />}>
                <AmexLedger
                  embedded
                  accountId={selected.plaidAccountId}
                  lead={
                    <AccountSummary
                      entry={selected}
                      debt={debtFor(selected.rowId)}
                      payoffCard={(payoff?.cards ?? []).find((c) => c.plaidAccountId === selected.plaidAccountId) ?? null}
                      snapshot={null}
                    />
                  }
                />
              </Suspense>
            </div>
          ) : selected ? (
            <>
              <AccountSummary
                entry={selected}
                debt={debtFor(selected.rowId)}
                payoffCard={null}
                snapshot={snapshotFor(selected.rowId)}
              />
              <Panel title="Activity" accent={selected.identity.accent} span={8} className="min-w-0" variant="static" data-testid="account-activity">
                <p className={emptyNote}>This account type has no activity view yet.</p>
              </Panel>
            </>
          ) : (
            <CombinedActivity entries={entries} />
          )}
        </PageGrid>
      </Page>
    </div>
  );
}
