import { lazy, Suspense, useMemo } from "react";
import { useRoute } from "wouter";
import {
  useGetAmexWeeklyPayoff, useListCategories, useListDebts,
  useListPlaidItems, useListPlaidLiabilityAccounts, useListTransactions,
  getListPlaidLiabilityAccountsQueryKey,
  type AmexWeeklyPayoffCard,
} from "@workspace/api-client-react";
import { Page, emptyNote } from "@/ui";
import { PageGrid, Panel, TxnTable, type TxnRow } from "@/components/next";
import { AccountPageSkeleton } from "@/components/account-page/account-page-skeleton";
import { displayAmount } from "@/lib/amountDisplay";
import { resolveTxnAccount } from "@/lib/accountIdentity";
import { householdToday } from "@/lib/householdDay";
import { formatCurrency } from "@/lib/utils";
import { isSpineAccount, snapshotWords } from "@/lib/bankBalance";
import { useBankBalanceView } from "@/hooks/useBankBalanceView";
import { CARD_WORDS, cardOwedView, creditorLabel, debtForAccount } from "@/lib/cardBalance";
import { NOT_TRACKED, snapshotCaption } from "@/lib/snapshotWords";
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
    return (txns ?? []).map((t) => {
      const e = t.plaidAccountId ? byExt.get(t.plaidAccountId) : undefined;
      // A row with no linked account says where it came from (Amex import,
      // manual entry, an unlinked bank account), never "Manual entry" for all.
      const identity = resolveTxnAccount(t, byExt);
      return {
        id: t.id,
        date: t.occurredOn.slice(0, 10),
        description: t.displayName ?? t.description,
        amount: displayAmount(t.amount, identity, t.source),
        identity,
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

/**
 * The weekly-payoff card for an account. The payoff card carries the
 * EXTERNAL Plaid account_id as `accountId` and the INTERNAL plaid_accounts
 * row id as `plaidAccountId` (api-server `lib/amexAnchor.ts`); the items
 * response gives the entry both (`plaidAccountId` = external, `rowId` =
 * internal). Match on either, as the route itself accepts either.
 */
export function payoffCardFor(
  cards: readonly AmexWeeklyPayoffCard[] | undefined,
  entry: { plaidAccountId: string; rowId: string },
): AmexWeeklyPayoffCard | null {
  return (
    (cards ?? []).find(
      (c) => c.accountId === entry.plaidAccountId || (!!c.plaidAccountId && c.plaidAccountId === entry.rowId),
    ) ?? null
  );
}

export default function NextAccountsPage() {
  const [, params] = useRoute("/next/accounts/:plaidAccountId");
  const selectedId = params?.plaidAccountId ? decodeURIComponent(params.plaidAccountId) : null;
  const { data: items, isLoading } = useListPlaidItems();
  const { data: debts } = useListDebts();
  const { data: payoff } = useGetAmexWeeklyPayoff();
  // (WP3) The checking balance comes from the spine's bank view (WP1) — the
  // figure the dashboard shows, with the snapshot under it — so this page no
  // longer asks for the whole forecast to find one number.
  const { view: bank } = useBankBalanceView();
  const entries = useMemo(() => buildEntries(items), [items]);
  // The id may be the Plaid account_id or the items response's row id.
  const selected = entries.find((e) => e.plaidAccountId === selectedId || e.rowId === selectedId) ?? null;

  // (WP3) The debt row by the account's INTERNAL row id only, any status —
  // the card model says what an archived row is. The dashboard's own rule.
  const debtFor = (rowId: string) => debtForAccount(debts, { id: rowId });
  const owes = (e: (typeof entries)[number]) => e.identity.isCard || e.identity.kind === "loan";
  // A card or loan with no debt row reads Plaid's STORED liability figures, as
  // the dashboard does (same key; asked only when such an account exists and
  // never with `refresh`).
  const needLiabilities = debts !== undefined && entries.some((e) => owes(e) && !debtFor(e.rowId));
  const { data: liabs } = useListPlaidLiabilityAccounts(undefined, {
    query: { queryKey: getListPlaidLiabilityAccountsQueryKey(), staleTime: 30 * 60_000, enabled: needLiabilities },
  });
  const liabilityFor = (rowId: string) => (debtFor(rowId) ? null : (liabs ?? []).find((l) => l.id === rowId) ?? null);
  // The account the bank balance rolls forward on — BY ID (`isSpineAccount`),
  // never by mask.
  const allKeys = entries.map((e) => ({ id: e.rowId, accountId: e.plaidAccountId, mask: e.identity.mask4 || null }));
  const isSpine = (e: (typeof entries)[number]) =>
    !owes(e) && isSpineAccount({ id: e.rowId, accountId: e.plaidAccountId, mask: e.identity.mask4 || null }, bank?.account, allKeys);
  const bankFor = (e: (typeof entries)[number]) => (isSpine(e) ? bank : null);
  const balances: BalanceByRow = {};
  for (const e of entries) {
    if (owes(e)) {
      // ⭐ The ONE card model: the chip prints what the dashboard row prints.
      const v = cardOwedView({ debt: debtFor(e.rowId), liability: liabilityFor(e.rowId) });
      balances[e.rowId] = v.owed != null
        ? { label: CARD_WORDS.owed, figure: formatCurrency(v.owed), balanceAt: v.creditorCurrent?.asOf }
        : {
            label: v.creditorCurrent ? creditorLabel(e.identity.kind === "loan") : null,
            figure: v.creditorCurrent ? formatCurrency(v.creditorCurrent.balance) : null,
            plan: v.status,
            balanceAt: v.creditorCurrent?.asOf,
          };
    } else if (isSpine(e) && bank) {
      // ⭐ The checking balance: the dashboard's figure ("Balance" = the
      // snapshot rolled forward), with the bank's own snapshot under it, dated,
      // and how many entries rolled on top (WP1's `snapshotWords`).
      balances[e.rowId] = {
        label: "Balance",
        figure: bank.balance != null ? formatCurrency(bank.balance) : null,
        sub: snapshotWords(bank),
        balanceAt: bank.snapshot?.at,
      };
    } else {
      // Every other depository account (savings, a second checking account):
      // its last reading, never rolled forward, or words (`lib/snapshotWords.ts`).
      const r = e.snapshot;
      balances[e.rowId] = r
        ? { label: "Snapshot", figure: formatCurrency(r.balance), words: snapshotCaption(r), balanceAt: r.at }
        : { label: null, figure: null, words: e.identity.kind === "savings" ? NOT_TRACKED.savings : NOT_TRACKED.other };
    }
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
                      bank={bankFor(selected)}
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
                      liability={liabilityFor(selected.rowId)}
                      payoffCard={payoffCardFor(payoff?.cards, selected)}
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
                liability={liabilityFor(selected.rowId)}
                payoffCard={null}
                bank={bankFor(selected)}
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
