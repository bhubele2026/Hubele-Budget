import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPlaidLiabilityAccounts,
  useLinkDebtToPlaid,
  useUnlinkDebtFromPlaid,
  useRefreshDebtFromPlaid,
  useCreateDebtFromPlaidAccount,
  useListPlaidItems,
  getListPlaidItemsQueryKey,
  getListDebtsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetForecastQueryKey,
  getGetDashboardQueryKey,
  listPlaidLiabilityAccounts,
} from "@workspace/api-client-react";
import type {
  Debt,
  PlaidLiabilityAccount,
  PlaidItemDetail,
} from "@workspace/api-client-react";
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
import {
  PlaidLinkButton,
  PLAID_LINK_TOKEN_STORAGE_KEY,
  PLAID_RETURN_TO_STORAGE_KEY,
} from "@/components/plaid-link-button";
import {
  PlaidReconnectButton,
  isPlaidReauthCode,
  isSyntheticPlaidItem,
  plaidReauthReason,
} from "@/components/plaid-reconnect-button";
import { formatPlaidErrorForDisplay } from "@/hooks/use-plaid-sync";

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

// (#link-button-bug) Tokens we strip before comparing institution and debt
// names — they appear in nearly every bank/card name and would create
// spurious matches (e.g. a "Bank of America" institution false-matching a
// "Chase Bank" debt on the shared "bank" token).
const INSTITUTION_MATCH_STOP_WORDS = new Set<string>([
  "the", "of", "and", "&", "a", "an",
  "card", "cards", "bank", "banking", "credit", "debit",
  "account", "accounts", "savings", "checking",
]);

// (#link-button-bug, follow-up from architect review) Minimal alias map
// for high-frequency US banks whose colloquial name (what users type into
// the debt label) differs from the formal institution name Plaid returns.
// Each entry expands one alias into the set of tokens it should ALSO
// match — bidirectionally — when checking institution overlap.
//   "citi"   ↔ "citibank"
//   "wf"     ↔ "wells fargo"
//   "boa"    ↔ "bank of america"
//   "amex"   ↔ "american express"
//   "cap1"   ↔ "capital one"
const INSTITUTION_ALIAS_EXPANSIONS: Record<string, string[]> = {
  citi: ["citibank"],
  citibank: ["citi"],
  wf: ["wells", "fargo"],
  wellsfargo: ["wells", "fargo"],
  boa: ["bank", "america"],
  bofa: ["bank", "america"],
  amex: ["american", "express"],
  cap1: ["capital", "one"],
  capitalone: ["capital", "one"],
};

// (#link-button-bug, follow-up) Split a string into normalized tokens,
// stripping stopwords. We split on whitespace, hyphens, underscores,
// punctuation AND case boundaries — so "CapitalOne" and "WellsFargo"
// (common in user-typed debt labels) tokenize to ["capital","one"] /
// ["wells","fargo"] and reach the institution-name tokens.
function tokenizeInstitutionName(s: string): string[] {
  // We split TWO ways and union the tokens so neither path drops valid
  // matches:
  //   (1) plain split — preserves short acronyms like "BoA"/"BofA" so
  //       the alias map can still expand them to ["bank","america"]
  //   (2) case-boundary split — turns user-typed joined words like
  //       "CapitalOne" / "WellsFargo" into ["capital","one"] /
  //       ["wells","fargo"] so they match Plaid's spaced institution
  //       name without needing alias entries.
  const withCaseBreaks = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const splitOne = s
    .toLowerCase()
    .split(/[\s\-_,./]+/)
    .filter((t) => t.length > 0 && !INSTITUTION_MATCH_STOP_WORDS.has(t));
  const splitTwo = withCaseBreaks
    .toLowerCase()
    .split(/[\s\-_,./]+/)
    .filter((t) => t.length > 0 && !INSTITUTION_MATCH_STOP_WORDS.has(t));
  const out = new Set<string>([...splitOne, ...splitTwo]);
  // Expand aliases. A single token like "citi" matches an institution
  // tokenized as ["citibank"] only after we add "citibank" to the set.
  for (const t of [...splitOne, ...splitTwo]) {
    const aliases = INSTITUTION_ALIAS_EXPANSIONS[t];
    if (aliases) for (const a of aliases) out.add(a);
  }
  return Array.from(out);
}

/**
 * (#link-button-bug) True when an account's institution looks like a
 * plausible match for a debt's name. Used by `PlaidAccountPicker` to
 * filter the candidate list so a "Chase Amazon Prime Visa" debt doesn't
 * surface the user's existing Amex card accounts as options.
 *
 * Match rule: any non-stop-word token from the institution name appears
 * as a whole token in the debt name (case-insensitive), or the
 * institution_slug appears as a whole token in the debt name. The slug
 * fallback handles aliases like "amex" ↔ "American Express" without us
 * having to hard-code a synonym list.
 *
 * Examples:
 *   debt="Chase Amazon Prime Visa" + inst="Chase"            → true
 *   debt="Chase Amazon Prime Visa" + inst="American Express" → false
 *   debt="Amex Platinum"           + inst="American Express" → true (via slug "amex")
 *   debt="Visa"                    + inst="Chase"            → false
 */
export function isInstitutionMatch(
  debtName: string | null | undefined,
  institutionName: string | null | undefined,
  institutionSlug: string | null | undefined,
): boolean {
  if (!debtName) return false;
  const debtTokens = new Set(tokenizeInstitutionName(debtName));
  if (debtTokens.size === 0) return false;
  const slug = (institutionSlug ?? "").trim().toLowerCase();
  if (slug && debtTokens.has(slug)) return true;
  if (institutionName) {
    for (const t of tokenizeInstitutionName(institutionName)) {
      if (debtTokens.has(t)) return true;
    }
  }
  return false;
}

// (#link-button-bug) Wipe any stale Plaid link_token saved during a
// prior OAuth round-trip. If we don't, opening the picker (which mounts
// a fresh PlaidLinkButton at the bottom) can run alongside a stale token
// in localStorage that PlaidOAuthPage / SDK state would otherwise resume,
// surfacing the wrong institution's 2FA modal on top of our dialog.
function clearStaleStoredPlaidLinkToken(): void {
  try {
    localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY);
    localStorage.removeItem(PLAID_RETURN_TO_STORAGE_KEY);
  } catch {
    // ignore — storage may be unavailable
  }
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
          // (#link-button-bug) Belt-and-braces: clear stale OAuth tokens
          // before the picker dialog (and the PlaidLinkButton inside it)
          // mounts, so a half-finished prior link can't bleed in.
          clearStaleStoredPlaidLinkToken();
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
  // (#795) Existing Plaid items, used to PROACTIVELY detect when this
  // debt's institution is already linked and healthy. If so, we steer
  // the user into Plaid's update-mode "add new account" flow against the
  // existing item instead of a fresh OAuth grant — which at OAuth banks
  // like Chase silently invalidates the prior item's session.
  const plaidItems = useListPlaidItems({
    query: { enabled: open, queryKey: getListPlaidItemsQueryKey() },
  });
  // (#795) The healthy existing item whose institution matches this
  // debt's name (e.g. a "Chase Prime Visa" debt matching the user's
  // existing healthy "Chase" item that holds their checking account).
  // "Healthy" mirrors the server-side dup-guard: a real (non-synthetic)
  // item with no outstanding sync error code. We never steer toward an
  // item that needs reconnecting — that's the reauth flow's job.
  const matchedHealthyItem: PlaidItemDetail | null = useMemo(() => {
    const list = plaidItems.data ?? [];
    return (
      list.find(
        (it) =>
          !isSyntheticPlaidItem(it) &&
          !it.lastSyncErrorCode &&
          isInstitutionMatch(
            debt.name,
            it.institutionName ?? null,
            it.institutionSlug ?? null,
          ),
      ) ?? null
    );
  }, [plaidItems.data, debt.name]);
  const matchedInstLabel =
    matchedHealthyItem?.institutionName?.trim() || "your bank";
  // (#44) Shared invalidator — every consumer (Avalanche debts list,
  // Bills summary, Forecast, Dashboard, Amex anchor tile, the picker
  // itself) needs to refetch when a debt appears or its Plaid link
  // changes, so both Link and "Add as new debt" funnel through here.
  const invalidateAfterDebtChange = () => {
    qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
    qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    // The Amex Ending balance tile derives from the linked Amex debt
    // when present, so refresh its anchor query too.
    qc.invalidateQueries({ queryKey: ["/api/amex/anchor"] });
  };
  const link = useLinkDebtToPlaid({
    mutation: {
      onSuccess: () => {
        invalidateAfterDebtChange();
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
  // (#44) "Add as new debt" — creates a brand-new debt row from the
  // Plaid account's cached liability data and links it. Used for
  // unmatched accounts in the picker so the user doesn't have to
  // manually create a debt and then come back to link it.
  const createDebt = useCreateDebtFromPlaidAccount({
    mutation: {
      onSuccess: (res) => {
        invalidateAfterDebtChange();
        const action = (res as { action?: string } | undefined)?.action;
        const debtName =
          (res as { debt?: { name?: string } } | undefined)?.debt?.name ?? "debt";
        toast({
          title:
            action === "linked-existing"
              ? `Linked existing "${debtName}"`
              : `Added "${debtName}" as a new debt`,
        });
        onOpenChange(false);
      },
      onError: (err) =>
        toast({
          title: "Could not add as debt",
          description: String(err),
          variant: "destructive",
        }),
    },
  });

  const items: PlaidLiabilityAccount[] = useMemo(
    () => accounts.data ?? [],
    [accounts.data],
  );

  // (#link-button-bug) Prefilter to accounts whose institution looks
  // like a plausible match for this debt's name. Without this, a debt
  // for "Chase Amazon Prime Visa" surfaces the user's existing Amex
  // cards as candidates, which is at best confusing and at worst lets
  // them mis-link the debt to the wrong account.
  const matchedItems = useMemo(
    () =>
      items.filter((a) =>
        isInstitutionMatch(
          debt.name,
          a.institutionName ?? null,
          a.institutionSlug ?? null,
        ),
      ),
    [items, debt.name],
  );

  // (#link-button-bug) Clear any stale Plaid link_token in localStorage
  // when the picker opens, so the inner PlaidLinkButton starts from a
  // clean slate. Mirrors the same wipe in DebtPlaidActions's Link click
  // — both run because the dialog can also be opened by tests or
  // re-mounted by parent re-renders without re-firing the click handler.
  useEffect(() => {
    if (open) clearStaleStoredPlaidLinkToken();
  }, [open]);

  // (#link-button-bug follow-up) Escape hatch toggle that lets the user
  // bypass the institution prefilter from the no-matches empty state.
  // Resets when the dialog closes so each open starts filtered.
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  useEffect(() => {
    if (!open) setShowAllAccounts(false);
  }, [open]);

  // (#804-followup) Plaid SDK renders its Link modal as an iframe at
  // the document root, OUTSIDE our React tree. While our shadcn Dialog
  // is `modal={true}` (the default), Radix's FocusScope traps focus
  // inside DialogContent and applies aria-hidden to siblings — which
  // makes Plaid's CAPTCHA checkbox unclickable and text inputs
  // unfocusable. Flip the picker Dialog to non-modal whenever the
  // inner PlaidLinkButton is about to open Plaid, and restore the trap
  // when Plaid closes (success OR exit). Resets defensively when the
  // picker itself closes so a new open() starts in the trapped state.
  const [yieldingToPlaid, setYieldingToPlaid] = useState(false);
  useEffect(() => {
    if (!open) setYieldingToPlaid(false);
  }, [open]);
  const handlePlaidLinked = () => {
    setYieldingToPlaid(false);
    accounts.refetch();
  };
  const handlePlaidOpen = () => setYieldingToPlaid(true);
  const handlePlaidExit = () => setYieldingToPlaid(false);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      modal={!yieldingToPlaid}
    >
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
            <div
              className="py-6 px-3 text-center text-sm space-y-3"
              data-testid={`text-debt-picker-empty-${debt.id}`}
            >
              {matchedHealthyItem ? (
                // (#795) The user has no debt-like Plaid accounts yet,
                // but DOES have a healthy item at this debt's bank (e.g.
                // Chase checking). Steer them into add-account mode so
                // the new card joins that existing connection instead of
                // a fresh OAuth grant that would break the first item.
                <>
                  <p className="text-muted-foreground">
                    You already have {matchedInstLabel} linked. Add{" "}
                    {debt.name} to that connection to keep its history and
                    login.
                  </p>
                  <div className="flex justify-center">
                    <PlaidLinkButton
                      label={`Add ${debt.name} to ${matchedInstLabel}`}
                      addAccountItemId={matchedHealthyItem.id}
                      onLinked={handlePlaidLinked}
                      onOpen={handlePlaidOpen}
                      onExit={handlePlaidExit}
                    />
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground">
                  No linked Plaid accounts look like debts. Link a bank or
                  card first.
                </p>
              )}
            </div>
          ) : matchedItems.length === 0 && !showAllAccounts ? (
            // (#link-button-bug) Existing linked accounts are present
            // but none match this debt's institution. Steer the user
            // straight to "Link another institution" instead of showing
            // unrelated cards (e.g. surfacing Amex cards for a Chase
            // debt) which is what made the original flow look broken.
            // (#link-button-bug follow-up from architect review) Keep
            // an escape hatch — "Show all linked accounts anyway" — so
            // a heuristic miss can never trap a user from mapping an
            // existing account.
            <div
              className="py-6 px-3 text-center text-sm space-y-3 border rounded-md bg-muted/30"
              data-testid={`text-debt-picker-no-matches-${debt.id}`}
            >
              <p className="text-muted-foreground">
                {matchedHealthyItem
                  ? `You already have ${matchedInstLabel} linked. Add ${debt.name} to that connection to keep its history and login.`
                  : `None of your linked accounts look like ${debt.name}. Link a new bank or card to continue.`}
              </p>
              <div className="flex justify-center">
                {matchedHealthyItem ? (
                  // (#795) Proactive add-account steer — the new card
                  // joins the existing healthy item instead of a fresh
                  // OAuth grant that would invalidate it.
                  <PlaidLinkButton
                    label={`Add ${debt.name} to ${matchedInstLabel}`}
                    addAccountItemId={matchedHealthyItem.id}
                    onLinked={handlePlaidLinked}
                    onOpen={handlePlaidOpen}
                    onExit={handlePlaidExit}
                  />
                ) : (
                  <PlaidLinkButton
                    label={`Link a bank for ${debt.name}`}
                    onLinked={handlePlaidLinked}
                    onOpen={handlePlaidOpen}
                    onExit={handlePlaidExit}
                  />
                )}
              </div>
              <button
                type="button"
                className="text-xs underline text-muted-foreground hover:text-foreground"
                onClick={() => setShowAllAccounts(true)}
                data-testid={`button-debt-picker-show-all-${debt.id}`}
              >
                Show all {items.length} linked account{items.length === 1 ? "" : "s"} anyway
              </button>
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto border rounded-md divide-y">
              {(showAllAccounts ? items : matchedItems).map((a) => {
                const taken = a.linkedDebt && a.linkedDebt.id !== debt.id;
                // (#44) Only offer "Add as new debt" when the account is
                // unmatched. Already-linked accounts only get the
                // "linked to" badge.
                const canAddAsNew = !taken && !a.linkedDebt;
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
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        disabled={link.isPending || createDebt.isPending || !!taken}
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
                      {canAddAsNew ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={link.isPending || createDebt.isPending}
                          onClick={() =>
                            createDebt.mutate({ plaidAccountId: a.id })
                          }
                          title={
                            a.suggestedDebt
                              ? `Create "${a.suggestedDebt.name}" as a new debt`
                              : "Create a new debt from this account"
                          }
                          data-testid={`button-add-as-debt-${a.id}`}
                        >
                          {createDebt.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            "Add as new debt"
                          )}
                        </Button>
                      ) : null}
                    </div>
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
              onLinked={handlePlaidLinked}
              onOpen={handlePlaidOpen}
              onExit={handlePlaidExit}
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
  /**
   * (#228) Plaid error code for this institution (e.g. ITEM_LOGIN_REQUIRED,
   * PENDING_EXPIRATION, PENDING_DISCONNECT). Captured from the first
   * affected debt — the same item can't simultaneously hold two different
   * codes, so any debt under it is representative. Drives the per-code
   * subline copy via plaidReauthReason().
   */
  lastSyncErrorCode: string | null;
  /**
   * (#238) Plaid's `consent_expiration_time` cutoff for this institution
   * (mirrored from the parent item via `Debt.plaidConsentExpirationAt`).
   * Drives the dated PENDING_EXPIRATION / PENDING_DISCONNECT subline copy
   * ("Chase will disconnect on May 21 — reconnect now to keep it
   * linked."). Null when Plaid never reported a cutoff for the item.
   */
  consentExpirationAt: string | null;
  /**
   * (#320) Mirror of the parent Plaid item's
   * `consentExpirationLastRefreshError` (latest /item/get failure on the
   * consent-refresh path: manual button, on-sync PENDING_EXPIRATION
   * refresh, or daily cron). Captured from the first affected debt under
   * the same item-level invariant as the other fields here. Drives the
   * "Couldn't verify disconnect date: …" subline so a user reading the
   * banner's dated cutoff knows when that date itself may be stale.
   */
  consentExpirationLastRefreshError: string | null;
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
        // (#228) The first debt's code stands in for the institution; the
        // server writes the same lastSyncErrorCode on every account under
        // an item, so any debt is representative.
        lastSyncErrorCode: d.plaidLastSyncErrorCode ?? null,
        // (#238) Same item-level invariant: every debt under an item
        // shares the parent item's consent_expiration_time, so the first
        // debt's value is representative.
        consentExpirationAt: d.plaidConsentExpirationAt ?? null,
        // (#320) Same item-level invariant — every debt under the item
        // shares its parent's consent-refresh failure, so the first
        // debt's value is representative.
        consentExpirationLastRefreshError:
          d.plaidConsentExpirationLastRefreshError ?? null,
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
  // (#228) Lead with the per-code reason ("Your saved login expired…" /
  // "This bank's connection is about to expire…") so the user knows what
  // the Plaid Link popup is going to ask for. The debt-count fragment
  // stays on its own line so the debt-specific impact ("balance, APR,
  // and minimum payment may be out of date") is still visible.
  // (#238) Pass the institution's `consent_expiration_time` cutoff so
  // the dated PENDING_EXPIRATION / PENDING_DISCONNECT subline copy
  // ("Chase will disconnect on May 21 — reconnect now to keep it
  // linked.") fires when Plaid actually reports a date.
  const reason = plaidReauthReason(worst.lastSyncErrorCode, {
    consentExpirationAt: worst.consentExpirationAt,
    institutionName: worst.institutionName,
  });
  const debtImpact = `${debtCount} debt${debtCount === 1 ? "" : "s"} may be out of date — reconnect to refresh balance, APR, and minimum payment.`;
  // (#320) Surface the consent-refresh failure inline (matches the copy
  // already shown on Settings → Linked Accounts and on the page-top
  // PlaidReauthBanner) so a user looking only at the debts page can tell
  // when the disconnect cutoff date itself may be stale.
  const consentRefreshError = worst.consentExpirationLastRefreshError;

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
          {reason}
        </div>
        <div
          className="text-xs opacity-80 mt-0.5"
          data-testid="text-debt-reauth-impact"
        >
          {debtImpact}
        </div>
        {consentRefreshError && (
          <div
            className="text-xs opacity-90 mt-0.5"
            data-testid={`text-debt-reauth-consent-refresh-error-${worst.itemId}`}
          >
            Couldn't verify disconnect date:{" "}
            {formatPlaidErrorForDisplay(consentRefreshError)}
          </div>
        )}
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
