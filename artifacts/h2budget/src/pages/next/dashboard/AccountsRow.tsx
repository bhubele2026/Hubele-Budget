import { useMemo } from "react";
import { Link } from "wouter";
import type { PlaidItemDetail, PlaidAccount } from "@workspace/api-client-react";
import { AccountChip } from "@/components/next";
import { cardOrderOf, identityOf, type AccountIdentity } from "@/lib/accountIdentity";
import { useSpine } from "@/hooks/useSpine";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { FreshnessLine } from "@/components/data-state";
import { isPlaidReauthCode, isSyntheticPlaidItem, plaidReauthReason } from "@/components/plaid-reconnect-button";
import { btnSecondarySm } from "@/ui";
import { cn } from "@/lib/utils";
import { useAmexQ, useCashSignalQ, useDebtsQ, usePlaidItemsQ } from "./queries";
import { dayLabel, Empty, Gate, money, ordinal, rise } from "./shared";

const STALE_MS = 36 * 60 * 60 * 1000;
const EDGE: Record<AccountIdentity["accent"], string> = {
  checking: "panel-accent-checking", amex: "panel-accent-amex", card2: "panel-accent-card2", other: "panel-accent-other",
};

export type AccountState = "ok" | "stale" | "reauth" | "failed" | "never";

/** The words an account's connection state uses. Reauth reuses the app's own reason copy. */
export function connectionState(item: PlaidItemDetail, now: number): AccountState {
  if (isPlaidReauthCode(item.lastSyncErrorCode)) return "reauth";
  if (item.lastSyncError) return "failed";
  if (!item.lastSyncedAt) return "never";
  return now - Date.parse(item.lastSyncedAt) > STALE_MS ? "stale" : "ok";
}

const STATE_WORD: Record<AccountState, string> = {
  ok: "Up to date", stale: "Out of date", reauth: "Needs reconnecting", failed: "Last sync failed", never: "Not synced yet",
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="font-mono text-label tabular-nums text-brand-ink">{value}</dd>
    </div>
  );
}

export default function AccountsRow() {
  const items = usePlaidItemsQ();
  const cash = useCashSignalQ(90);
  const debts = useDebtsQ();
  const amex = useAmexQ();
  const { data: spine } = useSpine();
  const now = Date.now();

  const rows = useMemo(() => {
    const list: Array<{ item: PlaidItemDetail; acct: PlaidAccount }> = [];
    for (const item of items.data ?? []) {
      if (isSyntheticPlaidItem(item)) continue;
      for (const acct of item.accounts) list.push({ item, acct });
    }
    const asInput = ({ item, acct }: { item: PlaidItemDetail; acct: PlaidAccount }) => ({
      id: acct.id, name: acct.name, mask: acct.mask, type: acct.type, subtype: acct.subtype,
      institutionName: item.institutionName, institutionSlug: item.institutionSlug,
    });
    const cardOrder = cardOrderOf(list.map(asInput));
    return list.map((r) => ({ ...r, identity: identityOf(asInput(r), { cardOrder }) }));
  }, [items.data]);

  return (
    <div className={cn("span-12", rise(0))} data-testid="dash-accounts">
      <Gate q={items} what="Accounts" rows={2}>
        {() =>
          rows.length === 0 ? (
            <Empty>No bank accounts are linked yet.</Empty>
          ) : (
            <ul className="grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
              {rows.map(({ item, acct, identity }) => {
                const st = connectionState(item, now);
                const through = dayLabel(item.lastSyncedAt);
                const csAcct = cash.data?.account;
                const isCash =
                  identity.kind === "checking" && !!csAcct && csAcct.via !== "unresolved" &&
                  (csAcct.mask ?? "") === (acct.mask ?? "");
                const debt = (debts.data ?? []).find(
                  (d) => d.status !== "archived" && (d.plaidAccountId === acct.id || d.plaidAccountId === acct.accountId),
                );
                const card = (amex.data?.cards ?? []).find((c) => c.plaidAccountId === acct.id);
                const balance = isCash ? spine?.bank.balance : debt?.balance;
                const liability = identity.isCard || identity.kind === "loan";
                const minPay = debt && Number(debt.minPayment) > 0 ? money(debt.minPayment) : "—";
                const due = debt?.dueDay ? `The ${ordinal(debt.dueDay)}` : "—";
                return (
                  <li key={acct.id} data-testid="dash-account" data-state={st}
                    className={cn("panel panel-link flex flex-col", EDGE[identity.accent])}>
                    <div className="flex items-start justify-between gap-2 p-4 pb-2">
                      <Link href={`/next/accounts/${acct.id}`}
                        className="min-w-0 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
                        data-testid="dash-account-link">
                        <AccountChip identity={identity} />
                      </Link>
                      <SyncOne itemId={item.id} />
                    </div>
                    <div className="px-4">
                      <div className="text-micro uppercase tracking-wide text-neutral-500">
                        {liability ? "Balance owed" : "Balance"}
                      </div>
                      <div className="font-mono text-title font-semibold tabular-nums text-brand-navy" data-testid="dash-account-balance">
                        {money(balance)}
                      </div>
                    </div>
                    {liability ? (
                      <dl className="grid grid-cols-3 gap-2 px-4 pt-2">
                        <Fact label="Statement" value={card ? money(card.statementBalance) : "—"} />
                        <Fact label="Minimum" value={minPay} />
                        <Fact label="Due" value={due} />
                      </dl>
                    ) : null}
                    <div className="mt-auto p-4 pt-3 text-micro text-neutral-500" data-testid="dash-account-fresh">
                      {st === "reauth" ? (
                        <span className="font-semibold text-bad" data-testid="dash-account-state">
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
                          <span className={cn("font-semibold", st === "ok" ? "text-neutral-600" : "text-bad")} data-testid="dash-account-state">
                            {STATE_WORD[st]}
                          </span>
                          {through ? <span> · Data through {through}</span> : null}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Gate>
    </div>
  );
}
