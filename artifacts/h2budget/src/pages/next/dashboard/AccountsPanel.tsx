import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
import type { PlaidItemDetail, PlaidAccount } from "@workspace/api-client-react";
import { Panel } from "@/components/next";
import { cardOrderOf, identityOf } from "@/lib/accountIdentity";
import { CARD_WORDS, cardHasFigures, cardOwedView, creditorLabel, debtForAccount, needsLiability } from "@/lib/cardBalance";
import { freshnessStamps } from "@/lib/accountFreshness";
import { NOT_TRACKED, snapshotLine } from "@/lib/snapshotWords";
import { bankBalanceView, isSpineAccount } from "@/lib/bankBalance";
import { useSpine } from "@/hooks/useSpine";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { FreshnessLine } from "@/components/data-state";
import { isSyntheticPlaidItem, plaidReauthReason } from "@/components/plaid-reconnect-button";
import { btnSecondarySm } from "@/ui";
import { cn } from "@/lib/utils";
import { useDebtsQ, useLiabilityAccountsQ, usePlaidItemsQ } from "./queries";
import { connectionState, STATE_WORD } from "./bankState";
import { Gate, LABEL, LINK, money, ordinal, rise } from "./shared";

export { connectionState } from "./bankState";
export type { AccountState } from "./bankState";

const DOT: Record<string, string> = {
  checking: "bg-acct-checking", amex: "bg-acct-amex", card2: "bg-acct-card2", other: "bg-acct-other",
};

function SyncOne({ itemId }: { itemId: string }) {
  const { runSync, isPending } = usePlaidSync();
  return (
    <button type="button" className={btnSecondarySm} disabled={isPending}
      onClick={() => void runSync({ itemId })} data-testid={`dash-sync-${itemId}`}>
      {isPending ? "Syncing…" : "Sync"}
    </button>
  );
}

const FACTS_BOX = "col-span-2 row-start-2 flex min-w-0 flex-wrap gap-x-6 gap-y-2 pl-3 md:col-span-1 md:col-start-2 md:row-start-1 md:pl-0";
function FactsBox({ asList, children }: { asList: boolean; children: ReactNode }) {
  return asList
    ? <dl className={FACTS_BOX} data-testid="dash-account-facts">{children}</dl>
    : <div className={FACTS_BOX} data-testid="dash-account-facts">{children}</div>;
}

/** One fact beside an account's main figure, drawn only when it exists. */
function Fact({ label, value, testid }: { label: string; value: ReactNode; testid?: string }) {
  return (
    <div className="min-w-0" data-testid={testid}>
      <dt className={LABEL}>{label}</dt>
      <dd className="font-mono text-label tabular-nums text-brand-ink">{value}</dd>
    </div>
  );
}

/**
 * ⭐ ACCOUNTS: one row per linked account in ONE list surface (not a card
 * each). Full name and ••last4, wrapping and never truncated. Checking says the
 * cash it holds (the spine's roll-forward, the one balance the app reports for
 * it); savings and any other depository account its last reading, "not rolled
 * forward" (`lib/snapshotWords.ts`). Cards and loans read the ONE card model
 * (`lib/cardBalance.ts`, WP3): Owed (netted) only when on the payoff plan, the
 * card's own current balance beside it when a payment has not posted, then
 * minimum and due — only the fields that exist; an archived debt says "Paid
 * off · not on the payoff plan", a card with no debt row "Not on the payoff
 * plan". Freshness per row as three stamps (synced · balance read · data
 * through), Sync per BANK (once, on its first row), and the name opens the
 * account's own view. Checking's figure is not repeated at hero size here: the
 * summary row leads with it.
 */
export default function AccountsPanel() {
  const items = usePlaidItemsQ();
  const debts = useDebtsQ();
  const { data: spine } = useSpine();
  // (WP3) The account the bank balance rolls forward on, BY ID, from the spine
  // itself (WP1's `bank.account`): matching the cash signal's mask made every
  // account without a mask "the checking account" (`"" === ""`), and two
  // accounts can share four digits.
  const spineAcct = spine ? bankBalanceView(spine.bank).account : null;
  const now = Date.now();

  const rows = useMemo(() => {
    const list: Array<{ item: PlaidItemDetail; acct: PlaidAccount; firstOfItem: boolean }> = [];
    for (const item of items.data ?? []) {
      if (isSyntheticPlaidItem(item)) continue;
      item.accounts.forEach((acct, i) => list.push({ item, acct, firstOfItem: i === 0 }));
    }
    const asInput = ({ item, acct }: { item: PlaidItemDetail; acct: PlaidAccount }) => ({
      id: acct.id, name: acct.name, mask: acct.mask, type: acct.type, subtype: acct.subtype,
      institutionName: item.institutionName, institutionSlug: item.institutionSlug,
    });
    const cardOrder = cardOrderOf(list.map(asInput));
    return list.map((r) => ({ ...r, identity: identityOf(asInput(r), { cardOrder }) }));
  }, [items.data]);

  const allAccts = rows.map((r) => r.acct);
  // (WP3) The debt row by the account's internal id only, any status: an
  // archived row is still this card's row, and the card model says what it is.
  const debtFor = (acct: PlaidAccount) => debtForAccount(debts.data, acct);
  // A card or loan with no debt row — or an archived one — reads Plaid's stored
  // liability figures (asked only when such an account exists).
  const needLiabilities =
    debts.data !== undefined && rows.some((r) => (r.identity.isCard || r.identity.kind === "loan") && needsLiability(debtFor(r.acct)));
  const liab = useLiabilityAccountsQ(needLiabilities);
  const liabPending = needLiabilities && liab.data === undefined && !liab.isError;

  return (
    <Panel
      title="Accounts"
      span={12}
      variant={["flush", "static"]}
      className={rise(2)}
      data-testid="dash-accounts"
      actions={<Link href="/next/accounts" className={cn(LINK, "text-label")} data-testid="dash-all-accounts">All accounts</Link>}
    >
      <Gate q={items} what="Accounts" rows={3}>
        {() =>
          rows.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="dash-accounts-empty">
              <p className="text-body text-neutral-600">No bank accounts are linked yet.</p>
              <Link href="/settings" className={btnSecondarySm} data-testid="dash-accounts-link-bank">Link a bank in Settings</Link>
            </div>
          ) : (
            <ul className="list-none divide-y divide-brand-line p-0">
              {rows.map(({ item, acct, identity, firstOfItem }) => {
                const st = connectionState(item, now);
                const liability = identity.isCard || identity.kind === "loan";
                const isCash = !liability && isSpineAccount(acct, spineAcct, allAccts);
                const debt = liability ? debtFor(acct) : null;
                const la = liability && needsLiability(debt) ? (liab.data ?? []).find((l) => l.id === acct.id) : undefined;
                // Off the plan, the card's figures wait for Plaid's stored ones:
                // never a flash of an archived row's old $0.00.
                const waiting = liability && (debts.data === undefined || (needsLiability(debt) && liabPending));
                // ⭐ ONE card model (WP3): the same view the account chips, the
                // account's Summary and the Amex register read. Owed is NETTED
                // (`effectiveDebtBalance`) and only for a debt on the payoff
                // plan; the card's own figure shows beside it when a payment has
                // not posted, so the two numbers are on one row, each named.
                const view = liability ? cardOwedView({ debt, liability: la }) : null;
                const snap = !liability && !isCash ? acct.snapshot ?? null : null;
                const noBank = isCash && !spine?.bank.source && !spine?.bank.asOfDate;
                const stamps = freshnessStamps({
                  syncedAt: item.lastSyncedAt,
                  balanceAt: view ? view.creditorCurrent?.asOf : snap?.at,
                  dataThrough: item.lastBankTxOn,
                }, now);
                const planWords = view && !view.onPlan ? view.status : null;
                return (
                  <li key={acct.id} data-testid="dash-account" data-state={st} data-accent={identity.accent} data-plan={view?.state}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(14rem,1.2fr)_minmax(0,2fr)_auto] md:items-center md:gap-x-6">
                    <div className="col-start-1 row-start-1 flex min-w-0 items-start gap-2">
                      <span aria-hidden className={cn("mt-2 h-6 w-1 shrink-0 rounded-full", DOT[identity.accent])} />
                      <div className="min-w-0 flex-1">
                        <Link href={`/next/accounts/${acct.id}`}
                          className="group inline-block max-w-full rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
                          data-testid="dash-account-link">
                          <span className="text-body font-semibold text-brand-ink [overflow-wrap:anywhere] group-hover:underline" data-testid="dash-account-name">
                            {identity.label}
                          </span>
                          {identity.mask4 ? (
                            <span className="ml-1.5 whitespace-nowrap font-mono text-label tabular-nums text-neutral-500">••{identity.mask4}</span>
                          ) : null}
                        </Link>
                        <div className="mt-0.5 text-micro text-neutral-500" data-testid="dash-account-fresh">
                          {st === "reauth" ? (
                            <span className="font-semibold text-bad-ink" data-testid="dash-account-state">
                              Needs reconnecting
                              {item.lastSyncErrorCode ? (
                                <span className="font-normal text-neutral-600" data-testid="dash-account-reason">
                                  {" "}· {plaidReauthReason(item.lastSyncErrorCode, {
                                    consentExpirationAt: item.consentExpirationAt, institutionName: item.institutionName,
                                  })}
                                </span>
                              ) : null}
                            </span>
                          ) : isCash && spine?.bank.source && spine.bank.asOfDate ? (
                            <span data-testid="dash-account-state"><FreshnessLine bank={spine.bank} /></span>
                          ) : (
                            <>
                              <span className={cn("font-semibold", st === "ok" ? "text-neutral-600" : "text-bad-ink")} data-testid="dash-account-state">
                                {STATE_WORD[st]}
                              </span>
                              {stamps.length ? <span data-testid="dash-account-stamps"> · {stamps.join(" · ")}</span> : null}
                            </>
                          )}
                        </div>
                        {planWords ? (
                          <div className="mt-0.5 text-micro font-semibold text-neutral-600" data-testid="dash-account-plan">{planWords}</div>
                        ) : null}
                      </div>
                    </div>
                    {/* A <dl> only when it holds facts: a sentence in its place is a plain <div> (axe: definition-list). */}
                    <FactsBox asList={view ? !waiting && cardHasFigures(view) : isCash && !noBank}>
                      {view ? (
                        waiting ? (
                          <span className="skeleton block h-8 w-48 rounded" aria-busy="true" />
                        ) : cardHasFigures(view) ? (
                          <>
                            {view.owed != null ? (
                              <Fact label={CARD_WORDS.owed} value={<span className="font-semibold text-brand-navy" data-testid="dash-account-balance">{money(view.owed)}</span>} />
                            ) : null}
                            {view.creditorCurrent && (!view.onPlan || view.pending) ? (
                              <Fact label={creditorLabel(identity.kind === "loan")} testid="dash-account-creditor"
                                value={<span className={cn(!view.onPlan && "font-semibold text-brand-navy")}>{money(view.creditorCurrent.balance)}</span>} />
                            ) : null}
                            {view.owed == null && !view.creditorCurrent ? (
                              <Fact label={creditorLabel(identity.kind === "loan")} value={<span className="font-sans text-neutral-500" data-testid="dash-account-noowed">not reported</span>} />
                            ) : null}
                            {view.minPayment != null ? <Fact label={CARD_WORDS.minimum} value={money(view.minPayment)} testid="dash-account-min" /> : null}
                            {view.dueDay ? <Fact label={CARD_WORDS.due} value={`the ${ordinal(view.dueDay)}`} testid="dash-account-due" /> : null}
                            {view.pending ? <Fact label={CARD_WORDS.pending} value={money(view.pending.total)} testid="dash-account-pending" /> : null}
                          </>
                        ) : (
                          <p className="text-label text-neutral-500" data-testid="dash-account-nodebt">{CARD_WORDS.nothing}</p>
                        )
                      ) : isCash ? (
                        noBank ? (
                          <p className="text-label text-neutral-500" data-testid="dash-account-nobalance">No balance yet.</p>
                        ) : (
                          <Fact label="Cash held" value={<span className="font-semibold text-brand-navy" data-testid="dash-account-balance">{money(spine?.bank.balance)}</span>} />
                        )
                      ) : snap ? (
                        <p className="text-label text-neutral-600" data-testid="dash-account-snapshot">{snapshotLine(snap)}</p>
                      ) : (
                        <p className="text-label text-neutral-500" data-testid="dash-account-nobalance">
                          {identity.kind === "savings" ? NOT_TRACKED.savings : NOT_TRACKED.other}
                        </p>
                      )}
                    </FactsBox>
                    <div className="col-start-2 row-start-1 flex items-start justify-end self-start md:col-start-3 md:self-center">
                      {firstOfItem ? <SyncOne itemId={item.id} /> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Gate>
    </Panel>
  );
}
