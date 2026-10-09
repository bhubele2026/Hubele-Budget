import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
import type { PlaidItemDetail, PlaidAccount } from "@workspace/api-client-react";
import { Panel } from "@/components/next";
import { cardOrderOf, identityOf } from "@/lib/accountIdentity";
import { effectiveDebtBalance, pendingPaymentTotalOf } from "@/lib/debtBalance";
import { useSpine } from "@/hooks/useSpine";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { FreshnessLine } from "@/components/data-state";
import { isSyntheticPlaidItem, plaidReauthReason } from "@/components/plaid-reconnect-button";
import { btnSecondarySm } from "@/ui";
import { cn } from "@/lib/utils";
import { useCashSignalQ, useDebtsQ, useLiabilityAccountsQ, usePlaidItemsQ } from "./queries";
import { connectionState, STATE_WORD } from "./bankState";
import { dayLabel, Gate, LABEL, LINK, money, ordinal, rise } from "./shared";

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
 * each). Full name and ••last4, wrapping and never truncated. Checking and
 * savings say the cash they hold (checking from the spine's roll-forward, the
 * one balance the app reports for a depository account); cards and loans say
 * what is owed, then statement, minimum and due — only the fields that exist.
 * Freshness per row, Sync per BANK (once, on its first row), and the name opens
 * the account's own view. Checking's figure is not repeated at hero size here:
 * the summary row leads with it.
 */
export default function AccountsPanel() {
  const items = usePlaidItemsQ();
  const cash = useCashSignalQ(90);
  const debts = useDebtsQ();
  const { data: spine } = useSpine();
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

  const debtFor = (acct: PlaidAccount) =>
    (debts.data ?? []).find(
      (d) => d.status !== "archived" && (d.plaidAccountId === acct.id || d.plaidAccountId === acct.accountId),
    );
  // A card or loan that is not on the debt list reads Plaid's stored
  // liability figures instead (asked only when such an account exists).
  const needLiabilities =
    debts.data !== undefined && rows.some((r) => (r.identity.isCard || r.identity.kind === "loan") && !debtFor(r.acct));
  const liab = useLiabilityAccountsQ(needLiabilities);

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
                const through = dayLabel(item.lastSyncedAt);
                const csAcct = cash.data?.account;
                const isCash =
                  identity.kind === "checking" && !!csAcct && csAcct.via !== "unresolved" &&
                  (csAcct.mask ?? "") === (acct.mask ?? "");
                const debt = debtFor(acct);
                const liability = identity.isCard || identity.kind === "loan";
                const pending = debt ? pendingPaymentTotalOf(debt) : 0;
                const la = !debt && liability ? (liab.data ?? []).find((l) => l.id === acct.id || l.accountId === acct.accountId) : undefined;
                // One basis per row: the debt row when the account is on the
                // debt list, else Plaid's stored liability figures. A field
                // neither source has is left out, never drawn as $0.
                // ⭐ A debt's Owed is NETTED of its pending payments
                // (`effectiveDebtBalance`, the app's one balance basis), so the
                // rows add up to the summary tile's "$X left" on the same
                // screen; "Paid, not posted" says what was netted.
                const owed = debt ? effectiveDebtBalance(debt) : la?.balance ?? null;
                const minPay = debt ? (Number(debt.minPayment) > 0 ? debt.minPayment : null) : la?.minPayment && Number(la.minPayment) > 0 ? la.minPayment : null;
                const dueDay = debt ? debt.dueDay ?? null : la?.suggestedDebt?.dueDay ?? null;
                const noBank = isCash && !spine?.bank.source && !spine?.bank.asOfDate;
                return (
                  <li key={acct.id} data-testid="dash-account" data-state={st} data-accent={identity.accent}
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
                              {through ? <span> · data through {through}</span> : null}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* A <dl> only when it holds facts: a sentence in its place is a plain <div> (axe: definition-list). */}
                    <FactsBox asList={liability ? owed != null || minPay != null || dueDay != null : isCash && !noBank}>
                      {liability ? (
                        owed != null || minPay != null || dueDay != null ? (
                          <>
                            {owed != null ? (
                              <Fact label="Owed" value={<span className="font-semibold text-brand-navy" data-testid="dash-account-balance">{money(owed)}</span>} />
                            ) : (
                              <Fact label="Owed" value={<span className="font-sans text-neutral-500" data-testid="dash-account-noowed">not reported</span>} />
                            )}
                            {minPay != null ? <Fact label="Minimum" value={money(minPay)} testid="dash-account-min" /> : null}
                            {dueDay ? <Fact label="Due" value={`the ${ordinal(dueDay)}`} testid="dash-account-due" /> : null}
                            {pending > 0 ? <Fact label="Paid, not posted" value={money(pending)} testid="dash-account-pending" /> : null}
                          </>
                        ) : debts.data === undefined || (needLiabilities && liab.data === undefined && !liab.isError) ? (
                          <span className="skeleton block h-8 w-48 rounded" aria-busy="true" />
                        ) : (
                          <p className="text-label text-neutral-500" data-testid="dash-account-nodebt">
                            No balance, minimum or due date reported for this card yet.
                          </p>
                        )
                      ) : isCash ? (
                        noBank ? (
                          <p className="text-label text-neutral-500" data-testid="dash-account-nobalance">No balance yet.</p>
                        ) : (
                          <Fact label="Cash held" value={<span className="font-semibold text-brand-navy" data-testid="dash-account-balance">{money(spine?.bank.balance)}</span>} />
                        )
                      ) : (
                        <p className="text-label text-neutral-500" data-testid="dash-account-nobalance">
                          {identity.kind === "savings" ? "Savings balance is not tracked yet." : "Balance is not tracked for this account."}
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
