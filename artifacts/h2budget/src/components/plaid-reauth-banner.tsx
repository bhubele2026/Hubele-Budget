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
  isSyntheticPlaidItem,
  plaidReauthReason,
} from "@/components/plaid-reconnect-button";
import { formatPlaidErrorForDisplay } from "@/hooks/use-plaid-sync";

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
  // (#710) Exclude synthetic seed rows (itemId starting with `seed-`,
  // e.g. the April-2026 Chase placeholder) — they're never real Plaid
  // connections, so Reconnect can't do anything for them. Without this
  // filter the dashboard banner shouts "Chase needs reconnect" any time
  // the env-mismatch remediation has stamped INVALID_ACCESS_TOKEN on
  // the placeholder row, even when the user's real Chase item is
  // healthy and syncing.
  const affected = (items ?? []).filter(
    (it) => isPlaidReauthCode(it.lastSyncErrorCode) && !isSyntheticPlaidItem(it),
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
  // (#228) Show the per-code reason (e.g. "Your saved login expired…") so
  // the user knows what to expect from the Plaid Link popup. Falls back to
  // the generic "needs to re-authorize" copy via plaidReauthReason() when
  // the code is unknown.
  // (#238) Pass the institution's `consent_expiration_time` cutoff so
  // PENDING_EXPIRATION / PENDING_DISCONNECT subline copy is dated
  // ("Chase will disconnect on May 21 — reconnect now to keep it
  // linked.") when Plaid actually reports one.
  const subline = plaidReauthReason(worst.lastSyncErrorCode, {
    consentExpirationAt: worst.consentExpirationAt,
    institutionName: worst.institutionName,
  });
  // (#320) Mirror the Settings → Linked Accounts inline warning: when the
  // disconnect-date check itself has been failing, surface that here too
  // so a user looking at the page-top banner ("Chase will disconnect on
  // May 21") can tell that the cutoff date may be stale. Distinct from
  // `lastSyncError` so a healthy /transactions/sync doesn't erase a
  // stuck consent-refresh failure (and vice versa).
  const consentRefreshError = worst.consentExpirationLastRefreshError ?? null;

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
        {consentRefreshError && (
          <div
            className="text-xs opacity-90 mt-0.5"
            data-testid={`text-plaid-reauth-consent-refresh-error-${worst.id}`}
          >
            Couldn't verify disconnect date:{" "}
            {formatPlaidErrorForDisplay(consentRefreshError)}
          </div>
        )}
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
