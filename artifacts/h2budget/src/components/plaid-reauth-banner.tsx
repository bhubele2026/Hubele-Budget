import { useEffect, useMemo, useState } from "react";
import {
  useListPlaidItems,
  type PlaidItemDetail,
} from "@workspace/api-client-react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PlaidReconnectButton,
  isPlaidReauthCode,
} from "@/components/plaid-reconnect-button";

/**
 * (#217) Page-top "reconnect your bank" banner driven off `/plaid/items`.
 *
 * The earlier <DebtReauthBanner> only flagged Plaid items that were tied to
 * a Debt row, which missed the (common) case where the same Plaid item also
 * feeds Amex / checking transactions and the bank balance — there, a re-auth
 * state has no page-level surface, just the easy-to-miss Sync chip in
 * Settings. This banner reads every linked item the user has and shows up
 * whenever ANY of them needs re-authentication.
 *
 * Reused on Transactions / Amex / Forecast (the non-debt pages where stale
 * Plaid data is most visible). Debts / Avalanche keep using <DebtReauthBanner>
 * because its copy is debt-specific ("balance, APR, and minimum payment may
 * be out of date").
 */
export type PlaidItemsReauthSummary = {
  /** Affected items, sorted alphabetically by institution name for stable UI. */
  items: PlaidItemDetail[];
  /** Item the inline Reconnect button targets. Null when nothing's affected. */
  worst: PlaidItemDetail | null;
};

export function findPlaidItemsNeedingReauth(
  items: PlaidItemDetail[] | null | undefined,
): PlaidItemsReauthSummary {
  const affected = (items ?? []).filter((it) =>
    isPlaidReauthCode(it.lastSyncErrorCode),
  );
  // Stable, deterministic ordering so re-renders don't flicker between
  // candidates when several items are failing at once.
  const sorted = [...affected].sort((a, b) => {
    const an = a.institutionName ?? "";
    const bn = b.institutionName ?? "";
    if (an !== bn) return an.localeCompare(bn);
    return a.id.localeCompare(b.id);
  });
  return {
    items: sorted,
    worst: sorted[0] ?? null,
  };
}

/**
 * Pure presentation — separated from <PlaidReauthBanner> so tests can drive
 * it with a fixed `items` list without having to mock `useListPlaidItems`.
 */
export function PlaidReauthBannerView({
  items,
}: {
  items: PlaidItemDetail[] | null | undefined;
}) {
  const summary = useMemo(() => findPlaidItemsNeedingReauth(items), [items]);
  const dismissKey = useMemo(
    () => summary.items.map((i) => i.id).sort().join("|"),
    [summary.items],
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

  if (!summary.worst) return null;
  if (dismissedKey === dismissKey) return null;

  const worst = summary.worst;
  const worstName = worst.institutionName ?? "Your bank";
  const otherCount = summary.items.length - 1;
  const headline =
    otherCount > 0
      ? `${worstName} and ${otherCount} more bank${otherCount === 1 ? "" : "s"} need reconnecting`
      : `${worstName} needs reconnecting`;
  const subline =
    "Transactions and balances may be out of date — reconnect to refresh.";

  return (
    <div
      className="relative flex items-center gap-3 rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100"
      data-testid="banner-plaid-reauth"
      role="alert"
    >
      <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 min-w-0">
        <div className="font-medium" data-testid="text-plaid-reauth-headline">
          {headline}
        </div>
        <div
          className="text-sm opacity-90"
          data-testid="text-plaid-reauth-subline"
        >
          {subline}
        </div>
      </div>
      <PlaidReconnectButton
        itemId={worst.id}
        institutionName={worst.institutionName}
        size="sm"
      />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setDismissedKey(dismissKey)}
        aria-label="Dismiss"
        data-testid="button-plaid-reauth-dismiss"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * Self-fetching variant — drop-in for pages that don't already query
 * `/plaid/items`. Renders nothing while loading or when no item needs
 * re-authentication.
 */
export function PlaidReauthBanner() {
  const { data: items } = useListPlaidItems();
  return <PlaidReauthBannerView items={items} />;
}
