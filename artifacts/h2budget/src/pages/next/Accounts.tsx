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
import { txnRoute } from "@/lib/accountRoute";
import { householdToday } from "@/lib/householdDay";
import { formatCurrency } from "@/lib/utils";
import { isSpineAccount, snapshotWords } from "@/lib/bankBalance";
import { useBankBalanceView } from "@/hooks/useBankBalanceView";
import { CARD_WORDS, cardOwedView, creditorLabel, debtForAccount, needsLiability } from "@/lib/cardBalance";
import { NOT_TRACKED, snapshotCaption } from "@/lib/snapshotWords";
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

function CombinedActivity({ entries, entriesKnown }: { entries: ReturnType<typeof buildEntries>; entriesKnown: boolean }) {
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
      // (WP7 review) Until the linked accounts are known (loading, or failed), a
      // Plaid row opens nowhere and says nothing: never "no longer linked".
      const route = txnRoute(t, byExt, { entriesKnown });
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
  }, [txns, cats, entries, entriesKnown]);
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
  const { data: items, isLoading, isError: itemsFailed, refetch: refetchItems } = useListPlaidItems();
  // (WP7 review) A failed read of the linked accounts is unknown, never "none".
  const itemsKnown = items !== undefined;
  const debtsQ = useListDebts();
  const debts = debtsQ.data;
  // (WP3b) Until the debts answer, a card's plan state is UNKNOWN: never "Not
  // on the payoff plan" because the list is missing, and a failed read says so.
  const debtsUnknown = debts === undefined;
  const debtsFailed = debtsUnknown && !!debtsQ.isError;
  const { data: payoff } = useGetAmexWeeklyPayoff();
  // (WP3) The checking balance comes from the spine's bank view (WP1) — the
  // figure the dashboard shows, with the snapshot under it — so this page no
  // longer asks for the whole forecast to find one number.
  const { view: bank, state: bankState, refetch: refetchBank } = useBankBalanceView();
  // (WP3b) The spine decides which depository account rolls forward: until it
  // answers, no depository balance is labelled (never "not rolled forward" for
  // the one that is).
  const bankUnknown = bank === null;
  const bankFailed = bankUnknown && bankState === "failed";
  const entries = useMemo(() => buildEntries(items), [items]);
  // The id may be the Plaid account_id or the items response's row id.
  const selected = entries.find((e) => e.plaidAccountId === selectedId || e.rowId === selectedId) ?? null;
  // (WP7) Which ledger the account opens: card, bank (any checking, savings or
  // other depository account, at any bank), or words for a loan or anything else.
  const view = selected ? accountViewOf(selected) : null;

  // (WP3) The debt row by the account's INTERNAL row id only, any status —
  // the card model says what an archived row is. The dashboard's own rule.
  const debtFor = (rowId: string) => debtForAccount(debts, { id: rowId });
  const owes = (e: (typeof entries)[number]) => e.identity.isCard || e.identity.kind === "loan";
  // A card or loan with no debt row — or an archived one — reads Plaid's STORED
  // liability figures, as the dashboard does (same key; asked only when such an
  // account exists and never with `refresh`).
  const needLiabilities = debts !== undefined && entries.some((e) => owes(e) && needsLiability(debtFor(e.rowId)));
  const { data: liabs } = useListPlaidLiabilityAccounts(undefined, {
    query: { queryKey: getListPlaidLiabilityAccountsQueryKey(), staleTime: 30 * 60_000, enabled: needLiabilities },
  });
  const liabilityFor = (rowId: string) =>
    needsLiability(debtFor(rowId)) ? (liabs ?? []).find((l) => l.id === rowId) ?? null : null;
  // The account the bank balance rolls forward on — BY ID (`isSpineAccount`),
  // never by mask.
  const allKeys = entries.map((e) => ({ id: e.rowId, accountId: e.plaidAccountId, mask: e.identity.mask4 || null }));
  const isSpine = (e: (typeof entries)[number]) =>
    !owes(e) && isSpineAccount({ id: e.rowId, accountId: e.plaidAccountId, mask: e.identity.mask4 || null }, bank?.account, allKeys);
  const bankFor = (e: (typeof entries)[number]) => (isSpine(e) ? bank : null);
  const pendingFor = (e: (typeof entries)[number]) =>
    owes(e)
      ? debtsUnknown ? { failed: debtsFailed, what: "Debts", onRetry: () => void debtsQ.refetch() } : null
      : bankUnknown ? { failed: bankFailed, what: "Your bank balance", onRetry: () => void refetchBank() } : null;
  const balances: BalanceByRow = {};
  for (const e of entries) {
    if (owes(e) ? debtsUnknown : bankUnknown) {
      // Not known yet: a dash, or the words when the read failed.
      const failed = owes(e) ? debtsFailed : bankFailed;
      balances[e.rowId] = { label: null, figure: null, words: failed ? (owes(e) ? "Debts did not load" : "Balance did not load") : null };
    } else if (owes(e)) {
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
            ) : !itemsKnown && itemsFailed ? (
              <p role="alert" className="text-body text-neutral-600" data-testid="accounts-failed">
                Your linked accounts did not load.{" "}
                <button type="button" onClick={() => void refetchItems()} className="text-label font-semibold text-brand-navy underline">
                  Try again
                </button>
              </p>
            ) : entries.length ? (
              <AccountSelector entries={entries} selectedId={selected?.plaidAccountId ?? null} balances={balances} />
            ) : (
              <p className={emptyNote}>No linked accounts yet.</p>
            )}
            {entries.length && debtsFailed ? (
              <p role="alert" className="mt-2 text-label text-neutral-600" data-testid="accounts-debts-failed">
                Debts did not load ·{" "}
                <button type="button" onClick={() => void debtsQ.refetch()} className="font-semibold text-brand-navy underline">Try again</button>
              </p>
            ) : null}
            {entries.length && bankFailed ? (
              <p role="alert" className="mt-2 text-label text-neutral-600" data-testid="accounts-bank-failed">
                Your bank balance did not load ·{" "}
                <button type="button" onClick={() => void refetchBank()} className="font-semibold text-brand-navy underline">Try again</button>
              </p>
            ) : null}
            {selectedId && !selected && itemsKnown ? (
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
                      pending={pendingFor(selected)}
                      payoffCard={null}
                      bank={bankFor(selected)}
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
                      pending={pendingFor(selected)}
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
                pending={pendingFor(selected)}
                liability={liabilityFor(selected.rowId)}
                payoffCard={null}
                bank={bankFor(selected)}
              />
              <Panel title="Activity" accent={selected.identity.accent} span={8} className="min-w-0" variant="static" data-testid="account-activity">
                {/* (WP7) Said plainly: no ledger exists for these yet. */}
                <p className={emptyNote} data-testid="account-no-ledger">
                  {view === "loan" ? "H2 has no ledger for loans yet." : "H2 has no ledger for this kind of account yet."}
                </p>
              </Panel>
            </>
          ) : selectedId && !itemsKnown ? (
            // (WP7d) An account's route while the linked accounts load: its own
            // view's skeleton, never a flash of every account's activity (which
            // also asked GET /transactions with no account on a card's page). A
            // failed read is said above; nothing is guessed below it.
            itemsFailed ? null : <div className="span-12 min-w-0"><AccountPageSkeleton tiles={3} /></div>
          ) : (
            <CombinedActivity entries={entries} entriesKnown={itemsKnown} />
          )}
        </PageGrid>
      </Page>
    </div>
  );
}
