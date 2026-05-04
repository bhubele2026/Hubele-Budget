import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import {
  useCreatePlaidUpdateLinkToken,
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

// Plaid error codes that mean "the user must re-authenticate this item via
// Plaid Link in update mode". Mirrors PLAID_REAUTH_ERROR_CODES on the server
// (artifacts/api-server/src/routes/plaid.ts) — keep in sync.
export const PLAID_REAUTH_ERROR_CODES = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
]);

export function isPlaidReauthCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return PLAID_REAUTH_ERROR_CODES.has(code);
}

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
}: {
  itemId: string;
  institutionName?: string | null;
  size?: "default" | "sm" | "lg" | "icon";
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const createUpdateLinkToken = useCreatePlaidUpdateLinkToken();
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

  const fetchToken = useCallback(() => {
    createUpdateLinkToken.mutate(
      { data: { itemId } },
      {
        onSuccess: (data) => setLinkToken(data.linkToken),
        onError: (err) => {
          toast({
            title: "Could not start reconnect",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          });
        },
      },
    );
  }, [createUpdateLinkToken, itemId, toast]);

  const onSuccess = useCallback(async () => {
    setLinkToken(null);
    if (cancelledRef.current) return;
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
    const totals = await runSync({ itemId, silent: true });
    if (cancelledRef.current) return;
    qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
    // (#211) The page-top "reconnect your bank" banner reads
    // plaidLastSyncErrorCode off /debts. Once sync succeeds the server has
    // cleared that code, but the cached debts list still carries the old
    // value — so we have to invalidate the debt-consuming queries here or
    // the banner stays visible until the user navigates away. Same set as
    // the inline DebtPlaidActions refresh path uses.
    qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
    qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    if (totals.added + totals.modified + totals.removed > 0) {
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    }
    if (totals.errors.length > 0) {
      toast({
        title: "Reconnected, but sync still failing",
        description: totals.errors.join("; "),
        variant: "destructive",
      });
    }
  }, [institutionName, itemId, qc, runSync, toast]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => setLinkToken(null),
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const busy = createUpdateLinkToken.isPending;

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
