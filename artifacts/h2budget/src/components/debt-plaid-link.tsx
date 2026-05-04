import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPlaidLiabilityAccounts,
  useLinkDebtToPlaid,
  useUnlinkDebtFromPlaid,
  useRefreshDebtFromPlaid,
  getListDebtsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetForecastQueryKey,
  getGetDashboardQueryKey,
  listPlaidLiabilityAccounts,
} from "@workspace/api-client-react";
import type { Debt, PlaidLiabilityAccount } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link2, Unlink, RefreshCw, Loader2, AlertTriangle, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import {
  PlaidReconnectButton,
  isPlaidReauthCode,
} from "@/components/plaid-reconnect-button";

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "never";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export function DebtPlaidIndicator({
  debt,
  field,
  className = "",
}: {
  debt: Debt;
  field: "balance" | "apr" | "minPayment";
  className?: string;
}) {
  const source =
    field === "balance"
      ? debt.balanceSource
      : field === "apr"
      ? debt.aprSource
      : debt.minPaymentSource;
  if (source === "plaid") {
    return (
      <span
        className={`text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400 ${className}`}
        title="Synced from Plaid"
      >
        • plaid
      </span>
    );
  }
  // Manual: only call this out when the debt is linked but Plaid didn't
  // provide this field — that's the "graceful fallback" hint.
  if (debt.plaidAccountId) {
    return (
      <span
        className={`text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400 ${className}`}
        title="Plaid didn't provide this — kept your manual value"
      >
        • manual
      </span>
    );
  }
  return null;
}

export function DebtLastSynced({ debt }: { debt: Debt }) {
  if (!debt.plaidAccountId) return null;
  // (#43) When the parent Plaid item's last sync failed, surface the error
  // inline so the user knows the visible balance/APR/min may be stale and
  // can act (re-link in Settings). Falls back to the normal "synced Xm ago"
  // pill when sync is healthy.
  if (debt.plaidLastSyncError) {
    return (
      <div
        className="text-[10px] text-destructive flex items-center gap-1"
        data-testid={`text-debt-sync-error-${debt.id}`}
        title={`Sync failing: ${debt.plaidLastSyncError}\nLast healthy sync: ${
          debt.plaidLastSyncedAt
            ? new Date(debt.plaidLastSyncedAt).toLocaleString()
            : "never"
        }\nFix: Settings → Linked banks → Re-link`}
      >
        <AlertTriangle className="h-3 w-3" />
        <span>
          sync failing
          {debt.plaidLastSyncedAt
            ? ` · last ok ${relTime(debt.plaidLastSyncedAt)}`
            : ""}
        </span>
      </div>
    );
  }
  return (
    <div
      className="text-[10px] text-muted-foreground"
      data-testid={`text-debt-synced-${debt.id}`}
      title={debt.plaidLastSyncedAt ?? ""}
    >
      synced {relTime(debt.plaidLastSyncedAt)}
    </div>
  );
}

export function DebtPlaidSource({ debt }: { debt: Debt }) {
  if (!debt.plaidAccountId || !debt.plaidAccount) return null;
  const a = debt.plaidAccount;
  const inst = a.institutionName ?? "Plaid";
  const acctLabel =
    a.name ?? a.mask
      ? `${a.name ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}`
      : "Linked account";
  return (
    <div
      className="text-[10px] text-muted-foreground truncate"
      data-testid={`text-debt-plaid-source-${debt.id}`}
      title={`${inst} — ${acctLabel}`}
    >
      {inst} · {acctLabel}
    </div>
  );
}

export function DebtPlaidActions({ debt }: { debt: Debt }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const invalidateDebtConsumers = () => {
    qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
    qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  };
  const refresh = useRefreshDebtFromPlaid({
    mutation: {
      onSuccess: () => {
        invalidateDebtConsumers();
        toast({ title: "Refreshed from Plaid" });
      },
      onError: (err) =>
        toast({
          title: "Could not refresh",
          description: String(err),
          variant: "destructive",
        }),
    },
  });
  const unlink = useUnlinkDebtFromPlaid({
    mutation: {
      onSuccess: () => {
        invalidateDebtConsumers();
        qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
        toast({ title: "Unlinked from Plaid" });
      },
    },
  });

  if (debt.plaidAccountId) {
    // (#198) When Plaid reports the parent item is in a re-auth state
    // (ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION, PENDING_DISCONNECT) the
    // refresh icon is useless until the user reconnects — clicking it just
    // hits the same wall. Surface a Reconnect button inline on the debt
    // row instead, so the user can fix it from where they noticed the
    // stale balance. Reuses <PlaidReconnectButton> from the Sync chip.
    const needsReauth =
      isPlaidReauthCode(debt.plaidLastSyncErrorCode) &&
      !!debt.plaidAccount?.itemId;
    return (
      <div className="flex items-center gap-1 justify-end">
        {needsReauth ? (
          <PlaidReconnectButton
            itemId={debt.plaidAccount!.itemId!}
            institutionName={debt.plaidAccount?.institutionName ?? null}
            size="sm"
          />
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          title="Refresh from Plaid"
          disabled={refresh.isPending}
          onClick={(e) => {
            e.stopPropagation();
            refresh.mutate({ id: debt.id });
          }}
          data-testid={`button-debt-refresh-${debt.id}`}
        >
          {refresh.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Unlink from Plaid"
          disabled={unlink.isPending}
          onClick={(e) => {
            e.stopPropagation();
            if (confirm("Unlink this debt from Plaid? Values will go back to manual.")) {
              unlink.mutate({ id: debt.id });
            }
          }}
          data-testid={`button-debt-unlink-${debt.id}`}
        >
          <Unlink className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        data-testid={`button-debt-link-plaid-${debt.id}`}
      >
        <Link2 className="h-3.5 w-3.5 mr-1" />
        Link
      </Button>
      {open && (
        <PlaidAccountPicker
          debt={debt}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

function PlaidAccountPicker({
  debt,
  open,
  onOpenChange,
}: {
  debt: Debt;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const accounts = useListPlaidLiabilityAccounts(undefined, {
    query: { enabled: open, queryKey: getListPlaidLiabilityAccountsQueryKey() },
  });
  const link = useLinkDebtToPlaid({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
        qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
        qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
        qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        toast({ title: "Linked to Plaid" });
        onOpenChange(false);
      },
      onError: (err) =>
        toast({
          title: "Could not link",
          description: String(err),
          variant: "destructive",
        }),
    },
  });

  const items: PlaidLiabilityAccount[] = useMemo(
    () => accounts.data ?? [],
    [accounts.data],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Link {debt.name} to Plaid</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Pick a credit, loan, or mortgage account to sync balance, APR, and
              minimum payment.
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  // Force a server-side Plaid liabilities fetch, then refetch.
                  await listPlaidLiabilityAccounts({ refresh: true });
                } catch {
                  // ignore — refetch below will still pick up cached values
                }
                await accounts.refetch();
                setRefreshing(false);
              }}
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              Refresh
            </Button>
          </div>
          {accounts.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Loading accounts…
            </div>
          ) : items.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No linked Plaid accounts look like debts. Link a bank or card
              first.
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto border rounded-md divide-y">
              {items.map((a) => {
                const taken = a.linkedDebt && a.linkedDebt.id !== debt.id;
                return (
                  <div
                    key={a.id}
                    className="flex items-center justify-between p-3 gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {a.name ?? a.officialName ?? "Account"}{" "}
                        {a.mask ? (
                          <span className="text-muted-foreground">
                            •••• {a.mask}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {a.institutionName ?? ""}
                        {a.subtype ? ` · ${a.subtype}` : ""}
                        {a.balance ? ` · bal $${Number(a.balance).toFixed(2)}` : ""}
                        {a.apr ? ` · APR ${(Number(a.apr) * 100).toFixed(2)}%` : ""}
                      </div>
                      {taken ? (
                        <Badge variant="secondary" className="mt-1">
                          linked to {a.linkedDebt!.name}
                        </Badge>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      disabled={link.isPending || !!taken}
                      onClick={() =>
                        link.mutate({
                          id: debt.id,
                          data: { plaidAccountId: a.id },
                        })
                      }
                      data-testid={`button-pick-plaid-${a.id}`}
                    >
                      {link.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Use this"
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground mb-2">
              Don't see your account? Link another institution:
            </p>
            <PlaidLinkButton
              label="Link another institution"
              onLinked={() => {
                accounts.refetch();
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * (#211) Page-level grouping of Plaid-linked debts whose parent item is in
 * a re-auth state (ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION, etc.). Powers
 * the page-top reconnect banner so the user doesn't have to scroll the
 * debt table to discover the inline Reconnect button added in #198.
 */
export type ReauthInstitution = {
  itemId: string;
  institutionName: string | null;
  debts: Debt[];
};

export type DebtsReauthSummary = {
  institutions: ReauthInstitution[];
  totalDebts: number;
  /** The institution with the most affected debts — the Reconnect button targets this one. */
  worst: ReauthInstitution | null;
};

export function findDebtsNeedingReauth(
  debts: Debt[] | null | undefined,
): DebtsReauthSummary {
  const groups = new Map<string, ReauthInstitution>();
  for (const d of debts ?? []) {
    if (!isPlaidReauthCode(d.plaidLastSyncErrorCode)) continue;
    const itemId = d.plaidAccount?.itemId;
    if (!itemId) continue;
    const existing = groups.get(itemId);
    if (existing) {
      existing.debts.push(d);
    } else {
      groups.set(itemId, {
        itemId,
        institutionName: d.plaidAccount?.institutionName ?? null,
        debts: [d],
      });
    }
  }
  const institutions = Array.from(groups.values()).sort(
    (a, b) => b.debts.length - a.debts.length,
  );
  const totalDebts = institutions.reduce((s, g) => s + g.debts.length, 0);
  return {
    institutions,
    totalDebts,
    worst: institutions[0] ?? null,
  };
}

/**
 * Page-top banner that surfaces "your bank needs reconnecting" without
 * requiring the user to scroll the debt table. Renders nothing when no
 * Plaid-linked debt is in a re-auth state. Auto-clears after a successful
 * reconnect (the underlying error code goes away on the next sync). The
 * dismiss × hides the banner for the current snapshot of affected items;
 * if a *new* institution starts failing, the banner reappears.
 */
export function DebtReauthBanner({ debts }: { debts: Debt[] | null | undefined }) {
  const summary = useMemo(() => findDebtsNeedingReauth(debts), [debts]);
  const dismissKey = useMemo(
    () => summary.institutions.map((i) => i.itemId).sort().join("|"),
    [summary.institutions],
  );
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // Reset dismissal whenever the set of affected items changes — a newly
  // failing institution should re-show the banner even if the user
  // dismissed an earlier one.
  useEffect(() => {
    if (dismissedKey && dismissedKey !== dismissKey) {
      setDismissedKey(null);
    }
  }, [dismissKey, dismissedKey]);

  if (!summary.worst || summary.totalDebts === 0) return null;
  if (dismissedKey === dismissKey) return null;

  const worst = summary.worst;
  const worstName = worst.institutionName ?? "Your bank";
  const otherCount = summary.institutions.length - 1;
  const headline =
    otherCount > 0
      ? `${worstName} and ${otherCount} more bank${otherCount === 1 ? "" : "s"} need reconnecting`
      : `${worstName} needs reconnecting`;
  const debtCount = summary.totalDebts;
  const subline = `${debtCount} debt${debtCount === 1 ? "" : "s"} may be out of date`;

  return (
    <div
      className="relative flex items-center gap-3 rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100"
      data-testid="banner-debt-reauth"
      role="alert"
    >
      <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 min-w-0">
        <div className="font-medium" data-testid="text-debt-reauth-headline">
          {headline}
        </div>
        <div className="text-sm opacity-90" data-testid="text-debt-reauth-subline">
          {subline} — reconnect to refresh balance, APR, and minimum payment.
        </div>
      </div>
      <PlaidReconnectButton
        itemId={worst.itemId}
        institutionName={worst.institutionName}
        size="sm"
      />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setDismissedKey(dismissKey)}
        aria-label="Dismiss"
        data-testid="button-debt-reauth-dismiss"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
