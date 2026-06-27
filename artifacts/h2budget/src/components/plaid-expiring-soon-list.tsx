import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPlaidItems,
  useDismissPlaidExpirationWarning,
  getListPlaidItemsQueryKey,
  type PlaidItemDetail,
} from "@workspace/api-client-react";
import { CalendarClock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PlaidReconnectButton,
  isPlaidReauthCode,
  formatPlaidConsentExpirationDate,
} from "@/components/plaid-reconnect-button";

/**
 * (#257) Proactive "banks about to disconnect" alerts list.
 *
 * The existing <PlaidReauthBanner> only renders once Plaid actually flips
 * an item into ITEM_LOGIN_REQUIRED / PENDING_EXPIRATION / PENDING_DISCONNECT
 * — by then the next sync already errored out, which is exactly the
 * surprise we want to avoid. Now that the daily consent refresh
 * (#253) keeps every linked item's `consentExpirationAt` fresh, we can
 * surface the upcoming cutoff *before* Plaid flips the code, giving
 * the user a window to re-consent on their schedule.
 *
 * Items are filtered to those whose `consentExpirationAt` falls within
 * the next ~7 days. Items that are *already* in a re-auth state are
 * intentionally excluded — those are covered by <PlaidReauthBanner>
 * and we don't want to double-notify the user about the same bank.
 */
export const EXPIRING_SOON_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PlaidExpiringSoonEntry = {
  item: PlaidItemDetail;
  /** Parsed cutoff (always non-null — we filter unparseable items out). */
  expiresAt: Date;
  /** Whole days from `now` until the cutoff; negative when already past. */
  daysUntil: number;
};

/**
 * Pure helper — selects items whose `consentExpirationAt` falls within
 * the alert window, sorted soonest-first so the most urgent reconnect
 * surfaces at the top of the list.
 *
 * Inclusion rules:
 *  - Item has a parseable `consentExpirationAt`.
 *  - The cutoff is at most `withinDays` days into the future.
 *  - The cutoff is not more than 1 day in the past — past-due items
 *    almost always have already been flipped into a re-auth code by
 *    Plaid (and would be covered by <PlaidReauthBanner>); allowing a
 *    1-day grace tolerates the brief gap before the daily consent
 *    refresh / Plaid's own state transition catches up.
 *  - Item is NOT already in a re-auth state — those are covered by
 *    <PlaidReauthBanner>; surfacing them here too would double-notify.
 */
export function findPlaidItemsExpiringSoon(
  items: PlaidItemDetail[] | null | undefined,
  now: Date = new Date(),
  withinDays: number = EXPIRING_SOON_WINDOW_DAYS,
): PlaidExpiringSoonEntry[] {
  const cutoffMs = now.getTime() + withinDays * MS_PER_DAY;
  const graceMs = now.getTime() - MS_PER_DAY;
  const out: PlaidExpiringSoonEntry[] = [];
  for (const item of items ?? []) {
    if (isPlaidReauthCode(item.lastSyncErrorCode)) continue;
    if (!item.consentExpirationAt) continue;
    const expiresAt = new Date(item.consentExpirationAt);
    const t = expiresAt.getTime();
    if (Number.isNaN(t)) continue;
    if (t > cutoffMs) continue;
    if (t < graceMs) continue;
    // (#274) Persistent dismissal — the server stamps the cutoff the
    // user dismissed for. Suppress the row only while it still matches
    // the live cutoff; if Plaid moves the cutoff (e.g. a successful
    // re-consent rolls it months out, which usually drops the item
    // out of the window anyway) the alert returns automatically.
    if (
      item.consentWarningDismissedForCutoff &&
      new Date(item.consentWarningDismissedForCutoff).getTime() === t
    ) {
      continue;
    }
    const daysUntil = Math.floor((t - now.getTime()) / MS_PER_DAY);
    out.push({ item, expiresAt, daysUntil });
  }
  out.sort((a, b) => {
    if (a.expiresAt.getTime() !== b.expiresAt.getTime()) {
      return a.expiresAt.getTime() - b.expiresAt.getTime();
    }
    const an = a.item.institutionName ?? "";
    const bn = b.item.institutionName ?? "";
    if (an !== bn) return an.localeCompare(bn);
    return a.item.id.localeCompare(b.item.id);
  });
  return out;
}

/**
 * Friendly "expires in N days" / "expires today" / "expires tomorrow"
 * fragment for the per-row subline. Past-due rows (within the 1-day
 * grace window) read "expired".
 */
export function formatExpiringSoonRelative(daysUntil: number): string {
  if (daysUntil < 0) return "expired";
  if (daysUntil === 0) return "expires today";
  if (daysUntil === 1) return "expires tomorrow";
  return `expires in ${daysUntil} days`;
}

/**
 * Pure presentation — separated from <PlaidExpiringSoonList> so tests
 * can drive it with a fixed `items` list and a fixed `now` without
 * having to mock `useListPlaidItems` or freeze the system clock.
 */
export function PlaidExpiringSoonListView({
  items,
  now,
  onDismiss,
  isDismissing,
}: {
  items: PlaidItemDetail[] | null | undefined;
  now?: Date;
  /**
   * (#274) Called with the set of currently-shown item ids when the
   * user clicks dismiss. The container wires this to the persistent
   * `dismissPlaidExpirationWarning` mutation so the alert stays hidden
   * across reloads. Optional so the pure presentation component can
   * still be exercised in tests without an API client.
   */
  onDismiss?: (itemIds: string[]) => void;
  /** When true, the dismiss button shows a disabled / busy state. */
  isDismissing?: boolean;
}) {
  const entries = useMemo(
    () => findPlaidItemsExpiringSoon(items, now),
    [items, now],
  );

  if (entries.length === 0) return null;

  return (
    <div
      className="relative rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-foreground"
      data-testid="alerts-plaid-expiring-soon"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <CalendarClock className="h-5 w-5 shrink-0 text-warning mt-0.5" />
        <div className="flex-1 min-w-0">
          <div
            className="font-medium"
            data-testid="text-plaid-expiring-soon-headline"
          >
            {entries.length === 1
              ? "1 bank connection is about to expire"
              : `${entries.length} bank connections are about to expire`}
          </div>
          <div className="text-sm opacity-90">
            Reconnect now to keep transactions and balances syncing without
            interruption.
          </div>
          <ul className="mt-3 space-y-2">
            {entries.map((entry) => {
              const name = entry.item.institutionName ?? "Your bank";
              const dateLabel =
                formatPlaidConsentExpirationDate(
                  entry.item.consentExpirationAt,
                  now,
                ) ?? "soon";
              const relative = formatExpiringSoonRelative(entry.daysUntil);
              return (
                <li
                  key={entry.item.id}
                  className="flex items-center gap-3 flex-wrap"
                  data-testid={`row-plaid-expiring-${entry.item.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{name}</div>
                    <div
                      className="text-xs opacity-80"
                      data-testid={`text-plaid-expiring-subline-${entry.item.id}`}
                    >
                      {dateLabel} · {relative}
                    </div>
                  </div>
                  <PlaidReconnectButton
                    itemId={entry.item.id}
                    institutionName={entry.item.institutionName}
                    size="sm"
                  />
                </li>
              );
            })}
          </ul>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 -mr-1"
          onClick={() => onDismiss?.(entries.map((e) => e.item.id))}
          disabled={isDismissing}
          aria-label="Dismiss"
          data-testid="button-plaid-expiring-soon-dismiss"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Self-fetching variant — drop-in for pages that don't already query
 * `/plaid/items`. Renders nothing while loading or when no item is
 * inside the alert window.
 */
export function PlaidExpiringSoonList() {
  const { data: items } = useListPlaidItems();
  const qc = useQueryClient();
  const dismiss = useDismissPlaidExpirationWarning();

  const onDismiss = (itemIds: string[]) => {
    if (itemIds.length === 0) return;
    // (#274) Optimistically stamp `consentWarningDismissedForCutoff`
    // for each affected item in the cached list so the alert
    // disappears immediately, then fire-and-forget the per-item
    // mutations and reconcile with a refetch when they all settle.
    const queryKey = getListPlaidItemsQueryKey();
    const previous = qc.getQueryData<PlaidItemDetail[]>(queryKey);
    if (previous) {
      const affected = new Set(itemIds);
      qc.setQueryData<PlaidItemDetail[]>(
        queryKey,
        previous.map((it) =>
          affected.has(it.id) && it.consentExpirationAt
            ? {
                ...it,
                consentWarningDismissedForCutoff: it.consentExpirationAt,
              }
            : it,
        ),
      );
    }
    Promise.allSettled(
      itemIds.map((id) => dismiss.mutateAsync({ id })),
    ).finally(() => {
      qc.invalidateQueries({ queryKey });
    });
  };

  return (
    <PlaidExpiringSoonListView
      items={items}
      onDismiss={onDismiss}
      isDismissing={dismiss.isPending}
    />
  );
}
