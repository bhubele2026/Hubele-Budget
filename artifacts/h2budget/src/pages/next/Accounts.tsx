import { lazy, Suspense, useMemo } from "react";
import { useRoute } from "wouter";
import {
  useGetAmexWeeklyPayoff, useGetForecast, useListCategories, useListDebts,
  useListPlaidItems, useListTransactions,
  type AmexWeeklyPayoffCard,
} from "@workspace/api-client-react";
import { Page, emptyNote } from "@/ui";
import { PageGrid, Panel, TxnTable, type TxnRow } from "@/components/next";
import { AccountPageSkeleton } from "@/components/account-page/account-page-skeleton";
import { displayAmount } from "@/lib/amountDisplay";
import { txnRoute } from "@/lib/accountRoute";
import { householdToday } from "@/lib/householdDay";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import { AccountSelector, type BalanceByRow } from "./accounts/AccountSelector";
import { AccountSummary } from "./accounts/AccountSummary";
import { accountViewOf, buildEntries } from "./accounts/entries";

// Both ledgers are the existing pages, moved in whole (same hooks, bulk bars,
// dialogs and tests). Lazy, so nothing here joins the landing bundle.
const AmexLedger = lazy(() => import("@/pages/amex"));
const ChaseLedger = lazy(() => import("@/pages/transactions"));

function daysBack(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/** The combined view's window: the last 30 days, newest first, at most 100 rows. */
export const COMBINED_DAYS = 30;
export const COMBINED_LIMIT = 100;

function CombinedActivity({ entries }: { entries: ReturnType<typeof buildEntries> }) {
  const today = useMemo(() => householdToday(new Date()), []);
  const { data: txns, isLoading } = useListTransactions({ from: daysBack(today, COMBINED_DAYS), to: today, limit: COMBINED_LIMIT });
  const { data: cats } = useListCategories();
  const rows = useMemo<TxnRow[]>(() => {
    const byExt = new Map(entries.map((e) => [e.plaidAccountId, e]));
    const catName = new Map((cats ?? []).map((c) => [c.id, c.name]));
    return (txns ?? []).map((t) => {
      // A row with no linked account says where it came from (Amex import,
      // manual entry, an unlinked bank account), never "Manual entry" for all.
      // (WP7) And it opens the ledger that lists it, on its month — the Amex
      // page for a workbook row, the checking ledger for a manual one — or
      // says why no ledger does (`txnRoute`).
      const route = txnRoute(t, byExt);
      const identity = route.identity;
      return {
        id: t.id,
        date: t.occurredOn.slice(0, 10),
        description: t.displayName ?? t.description,
        amount: displayAmount(t.amount, identity, t.source),
        identity,
        pending: t.pending,
        category: t.categoryId ? catName.get(t.categoryId) ?? null : null,
        href: route.href ?? undefined,
        note: route.note,
      };
    });
  }, [txns, cats, entries]);
  // (WP7) A capped pull discloses its cap (CLAUDE.md §2): the server answers
  // newest first and cuts at the limit, so a full window lost its oldest rows.
  const capped = (txns?.length ?? 0) >= COMBINED_LIMIT;
  if (isLoading) return <AccountPageSkeleton tiles={2} />;
  return (
    <Panel title="Recent activity" sub="Last 30 days, every account. Pick an account to review and edit." span={12} data-testid="combined-activity">
      {capped ? (
        <p className="pb-2 text-label text-neutral-600" data-testid="combined-activity-cap">
          Showing the newest {COMBINED_LIMIT} rows of the last {COMBINED_DAYS} days.
        </p>
      ) : null}
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
  const { data: forecast } = useGetForecast({ days: 90 });
  const entries = useMemo(() => buildEntries(items), [items]);
  // The id may be the Plaid account_id or the items response's row id.
  const selected = entries.find((e) => e.plaidAccountId === selectedId || e.rowId === selectedId) ?? null;
  // (WP7) Which ledger the account opens: card, bank (any checking, savings or
  // other depository account, at any bank), or words for a loan or anything else.
  const view = selected ? accountViewOf(selected) : null;

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
          {selected && view === "bank" ? (
            // (C9) One account experience: a checking account opens the Chase
            // page's own layout (the same as /transactions, minus the title the
            // account page already shows), full width, with the Summary as the
            // first panel of its figures row. Nothing between this cell and the
            // ledger is a scroll container: the ledger panel inside is
            // sticky-safe, so its pane and bulk bar stick to <main>.
            // (WP7) Any checking or savings account, at any bank, and for THAT
            // account: the embedded ledger never swaps it for the bank balance's
            // account, and says so in place when the server has no ledger for it.
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
          ) : selected && view === "card" ? (
            // (C10) A card opens the Amex page's own layout the same way: full
            // width, the card's Summary first in its card row, the ledger in
            // its own sticky-safe panel. (WP7) Any card, at any bank: embedded,
            // the page asks for this card's rows by its Plaid account.
            <div className="span-12 min-w-0" data-testid="account-activity">
              <Suspense fallback={<AccountPageSkeleton tiles={3} />}>
                <AmexLedger
                  embedded
                  accountId={selected.plaidAccountId}
                  lead={
                    <AccountSummary
                      entry={selected}
                      debt={debtFor(selected.rowId)}
                      payoffCard={payoffCardFor(payoff?.cards, selected)}
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
                {/* (WP7) Said plainly: no ledger exists for these yet. */}
                <p className={emptyNote} data-testid="account-no-ledger">
                  {view === "loan" ? "H2 has no ledger for loans yet." : "H2 has no ledger for this kind of account yet."}
                </p>
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
