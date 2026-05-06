import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreatePlaidUpdateLinkToken,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  getListDebtsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetForecastQueryKey,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { usePlaidSync } from "@/hooks/use-plaid-sync";

export const PLAID_RECONNECT_EVENT = "plaid:reconnect";

export type PlaidReconnectEventDetail = {
  itemId: string;
  institutionName?: string | null;
};

/**
 * (#357) Global Plaid Link update-mode launcher.
 *
 * The sync-error toast (artifacts/h2budget/src/hooks/use-plaid-sync.tsx)
 * and the Settings → Recent activity reauth row both dispatch a
 * `window` CustomEvent("plaid:reconnect") instead of navigating the
 * user to /settings, because the actual remediation is to open Plaid
 * Link in update mode for the *failing* item — exactly what
 * PlaidReconnectButton does on Settings. Mirroring that flow at the app
 * root means a Reconnect click anywhere in the app fixes the bank
 * inline (Plaid Link popup → onSuccess → silent re-sync), without a
 * page change.
 *
 * Mounted once near the Toaster in App.tsx so it's available on every
 * authenticated route. No-op until an event arrives.
 */
export function PlaidReconnectListener() {
  const [pending, setPending] = useState<PlaidReconnectEventDetail | null>(
    null,
  );
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const createUpdateLinkToken = useCreatePlaidUpdateLinkToken();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { runSync } = usePlaidSync();
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    function onEvent(e: Event) {
      const detail = (e as CustomEvent<PlaidReconnectEventDetail>).detail;
      if (!detail || !detail.itemId) return;
      setPending(detail);
      createUpdateLinkToken.mutate(
        { data: { itemId: detail.itemId } },
        {
          onSuccess: (data) => setLinkToken(data.linkToken),
          onError: (err) => {
            setPending(null);
            toast({
              title: "Could not start reconnect",
              description: err instanceof Error ? err.message : String(err),
              variant: "destructive",
            });
          },
        },
      );
    }
    window.addEventListener(PLAID_RECONNECT_EVENT, onEvent);
    return () => window.removeEventListener(PLAID_RECONNECT_EVENT, onEvent);
  }, [createUpdateLinkToken, toast]);

  const onSuccess = useCallback(async () => {
    const detail = pending;
    setLinkToken(null);
    setPending(null);
    if (!detail || cancelledRef.current) return;
    toast({
      title: "Bank reconnected",
      description: detail.institutionName
        ? `Re-authenticated ${detail.institutionName}. Refreshing transactions…`
        : "Re-authenticated your bank. Refreshing transactions…",
    });
    const totals = await runSync({ itemId: detail.itemId, silent: true });
    if (cancelledRef.current) return;
    qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
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
  }, [pending, qc, runSync, toast]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setLinkToken(null);
      setPending(null);
    },
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  return null;
}

/**
 * (#357) Helper used by the sync-error toast and the sync-history
 * Reconnect row to dispatch the global `plaid:reconnect` event the
 * PlaidReconnectListener listens for. Centralizing the event name +
 * payload here keeps callers from re-typing the string and makes the
 * detail shape grep-able.
 */
export function dispatchPlaidReconnect(detail: PlaidReconnectEventDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PlaidReconnectEventDetail>(PLAID_RECONNECT_EVENT, {
      detail,
    }),
  );
}
