import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { usePlaidLink } from "react-plaid-link";
import {
  useCreatePlaidUpdateLinkToken,
  useCreatePlaidLinkToken,
  useExchangePlaidPublicToken,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  getListDebtsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetForecastQueryKey,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Link2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { invalidateForecastFamily } from "@/lib/invalidateForecast";

// (WP4, bundle) The pure re-auth helpers live in `lib/plaidReauth.ts` (the
// landing imports them from there); re-exported so every caller keeps its import.
export {
  PLAID_REAUTH_ERROR_CODES,
  PLAID_REAUTH_ERROR_REASONS,
  formatPlaidConsentExpirationDate,
  isPlaidReauthCode,
  isSyntheticPlaidItem,
  plaidReauthReason,
} from "@/lib/plaidReauth";
import { isPlaidReauthCode } from "@/lib/plaidReauth";

/**
 * Reconnect button shown next to the Sync chip when Plaid says an item
 * needs re-authentication (ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION, etc.).
 *
 * Flow:
 *  1. Click → POST /plaid/link-token/update with the item's row id, getting
 *     back a short-lived link_token tied to the item's existing access_token.
 *  2. Open Plaid Link in update mode using that token. The user re-enters
 *     credentials (or completes OAuth) at their bank.
 *  3. On success Plaid Link returns no public_token (update mode does NOT
 *     mint a new access_token). We just trigger a sync — when /transactions/
 *     sync now succeeds, the server clears lastSyncError + lastSyncErrorCode
 *     so the red chip disappears.
 */
export function PlaidReconnectButton({
  itemId,
  institutionName,
  size = "sm",
  onOpen,
  onExit,
}: {
  itemId: string;
  institutionName?: string | null;
  size?: "default" | "sm" | "lg" | "icon";
  /**
   * (#804-followup) Fires the moment the Plaid SDK is about to open its
   * iframe modal. Parent components that render this button inside a
   * Radix Dialog/AlertDialog use this hook to flip their modal into
   * non-modal mode, releasing the FocusScope so the Plaid iframe can
   * receive pointer/focus events. Standalone callers (debt row,
   * settings) can omit it.
   */
  onOpen?: () => void;
  /**
   * (#804-followup) Pairs with `onOpen` — fires when the Plaid SDK
   * closes so the parent can restore its focus trap.
   */
  onExit?: () => void;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  // (#367) When /plaid/link-token/update returns 409 + action:"relink"
  // (the over-strict guard or a server-side malformed-token detection),
  // fall back to the fresh-link flow that mints a brand-new
  // access_token via /plaid/exchange. `freshMode` flips the onSuccess
  // handler so it routes the public_token through exchange instead of
  // assuming the existing access_token is still good.
  const [freshMode, setFreshMode] = useState(false);
  const createUpdateLinkToken = useCreatePlaidUpdateLinkToken();
  const createLinkToken = useCreatePlaidLinkToken();
  const exchange = useExchangePlaidPublicToken();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { runSync } = usePlaidSync();

  // Tracks unmount so a long-running post-link sync can't fire toasts after
  // the user navigates away.
  const cancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // (#367) Fall back to a brand-new link token when the server tells
  // us the existing item can't be repaired with update mode (409 +
  // action:"relink"). This is what breaks the reconnect loop: the user
  // clicks Reconnect, the server says "this item's stored token is
  // unusable, mint a new one", and we transparently launch Plaid Link
  // in normal mode instead of bouncing the toast and stranding them.
  const fetchFreshLinkToken = useCallback(() => {
    setFreshMode(true);
    createLinkToken.mutate(undefined, {
      onSuccess: (data) => setLinkToken(data.linkToken),
      onError: (err) => {
        setFreshMode(false);
        toast({
          title: "Could not start reconnect",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    });
  }, [createLinkToken, toast]);

  const fetchToken = useCallback(() => {
    setFreshMode(false);
    createUpdateLinkToken.mutate(
      { data: { itemId } },
      {
        onSuccess: (data) => setLinkToken(data.linkToken),
        onError: (err) => {
          // (#367) Server signals "this item is past update-mode
          // repair — re-link from scratch" with status 409 and
          // body.action === "relink". Don't ask the user to retry
          // manually; fall straight through to the fresh-link path.
          const apiErr = err as { status?: number; data?: { action?: string } };
          if (apiErr?.status === 409 && apiErr?.data?.action === "relink") {
            fetchFreshLinkToken();
            return;
          }
          toast({
            title: "Could not start reconnect",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          });
        },
      },
    );
  }, [createUpdateLinkToken, itemId, toast, fetchFreshLinkToken]);

  const onSuccess = useCallback(async (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } | null }) => {
    setLinkToken(null);
    const wasFresh = freshMode;
    setFreshMode(false);
    // (#804-followup, architect round 2) Plaid SDK does NOT fire its
    // onExit handler after a successful link, so without this the
    // parent yield state (e.g. PlaidLinkButton's `yieldingToPlaid`)
    // would stay stuck `true` after a successful nested reconnect,
    // leaving the parent modal in a non-restored state. Reset the
    // dedup ref too so a future reconnect attempt can fire open().
    openedTokenRef.current = null;
    onExitRef.current?.();
    if (cancelledRef.current) return;
    // (#367) When this is the fresh-link fallback path (409 → relink),
    // the public_token has to be exchanged for a new access_token via
    // /plaid/exchange before we can sync. The server-side self-heal in
    // exchange() also clears the stale lastSyncError chip, so the user
    // gets back to a healthy item in one click.
    if (wasFresh) {
      try {
        await new Promise<void>((resolve, reject) => {
          exchange.mutate(
            {
              data: {
                publicToken,
                institutionId: metadata.institution?.institution_id ?? null,
                institutionName: metadata.institution?.name ?? institutionName ?? null,
              },
            },
            {
              onSuccess: () => resolve(),
              onError: (err) => reject(err),
            },
          );
        });
      } catch (err) {
        toast({
          title: "Reconnect failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
        return;
      }
    }
    toast({
      title: "Bank reconnected",
      description: institutionName
        ? `Re-authenticated ${institutionName}. Refreshing transactions…`
        : "Re-authenticated your bank. Refreshing transactions…",
    });
    // Re-running sync against the now-healthy item is what actually clears
    // lastSyncError + lastSyncErrorCode on the server (the success branch of
    // syncPlaidItem). Use silent:true so we don't double up on toasts —
    // the success toast above is enough.
    // Just reconnected a broken bank — force one billable refresh so the
    // freshly re-authorized item pulls current pending charges immediately.
    const totals = await runSync({ itemId, silent: true, force: true });
    if (cancelledRef.current) return;
    qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
    // (#400) Belt-and-braces refetch so the SyncButton chip + page-top
    // reauth banner clear immediately on success. invalidateQueries
    // alone usually triggers a refetch on active observers, but on
    // pages where the list has been silently re-rendered the prior
    // run-sync invalidate inside usePlaidSync can have already kicked
    // a refetch that races this one and returns *before* the server
    // commits the cleared lastSyncError, leaving the chip stale until
    // the next manual refresh. Forcing a fresh refetch here closes
    // that window.
    void qc.refetchQueries({ queryKey: getListPlaidItemsQueryKey() });
    // (#211) The page-top "reconnect your bank" banner reads
    // plaidLastSyncErrorCode off /debts. Once sync succeeds the server has
    // cleared that code, but the cached debts list still carries the old
    // value — so we have to invalidate the debt-consuming queries here or
    // the banner stays visible until the user navigates away. Same set as
    // the inline DebtPlaidActions refresh path uses.
    qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
    invalidateForecastFamily(qc);
    qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    if (totals.added + totals.modified + totals.removed > 0) {
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    }
    if (totals.errors.length > 0) {
      // (#794) The post-reconnect sync can still come back with a
      // reauth error even though Plaid Link update mode "succeeded":
      // adding a second account at the same bank (e.g. a Chase credit
      // card alongside an already-linked Chase checking) can invalidate
      // the prior OAuth session, so update mode heals nothing and the
      // very next /transactions/sync returns ITEM_LOGIN_REQUIRED. The
      // server-side cleanup hardened in #790 can't fix this from its
      // end — the stored access_token is simply dead — so the only
      // recovery is to mint a brand-new one via the fresh-link path.
      // Rather than strand the user behind a dead-looking "Reconnected,
      // but sync still failing" toast (which just repeats update mode on
      // the next click and fails the same way), transparently fall
      // through to fetchFreshLinkToken() — the same self-heal the
      // 409→relink branch uses. Guard on !wasFresh so a fresh-link
      // attempt that ALSO comes back needing reauth can't loop forever;
      // in that genuinely-stuck case we surface the toast instead.
      const stillNeedsReauth = totals.errorDetails.some(
        (d) => d.kind === "reauth" || isPlaidReauthCode(d.code),
      );
      if (stillNeedsReauth && !wasFresh) {
        fetchFreshLinkToken();
        return;
      }
      toast({
        title: "Reconnected, but sync still failing",
        description: totals.errors.join("; "),
        variant: "destructive",
      });
    }
  }, [
    institutionName,
    itemId,
    qc,
    runSync,
    toast,
    freshMode,
    exchange,
    fetchFreshLinkToken,
  ]);

  // (#804-followup) Stable refs for parent yield-callbacks — same
  // pattern as PlaidLinkButton. Keeps the open() effect off the
  // callbacks' identity so a parent re-render can't double-fire open().
  const onOpenRef = useRef(onOpen);
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onOpenRef.current = onOpen;
    onExitRef.current = onExit;
  });

  // (#804-followup) Dedup so a single linkToken triggers at most one
  // open() — guards against architect-flagged double-fire when parent
  // state churn re-runs this effect.
  const openedTokenRef = useRef<string | null>(null);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setLinkToken(null);
      setFreshMode(false);
      openedTokenRef.current = null;
      // (#804-followup) Restore any parent modal's focus trap.
      onExitRef.current?.();
    },
  });

  useEffect(() => {
    if (!linkToken || !ready) return;
    if (openedTokenRef.current === linkToken) return;
    openedTokenRef.current = linkToken;
    // (#804-followup) flushSync the parent yield-flip so Radix tears
    // down its FocusScope BEFORE Plaid opens; RAF defers open() one
    // frame so any useEffect-based cleanup also has a tick.
    flushSync(() => {
      onOpenRef.current?.();
    });
    requestAnimationFrame(() => open());
  }, [linkToken, ready, open]);

  const busy =
    createUpdateLinkToken.isPending ||
    createLinkToken.isPending ||
    exchange.isPending;

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={fetchToken}
      disabled={busy}
      data-testid={`button-plaid-reconnect-${itemId}`}
      title={
        institutionName
          ? `Re-authenticate ${institutionName} via Plaid`
          : "Re-authenticate this bank via Plaid"
      }
    >
      {busy ? (
        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
      ) : (
        <Link2 className="w-3.5 h-3.5 mr-1" />
      )}
      Reconnect
    </Button>
  );
}
