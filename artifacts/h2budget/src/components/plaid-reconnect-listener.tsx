import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useQueryClient } from "@tanstack/react-query";
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
  // (#367) Same 409→fresh-link fallback that PlaidReconnectButton uses,
  // so a Reconnect click triggered from a sync-error toast can also
  // recover items whose stored access_token can't be repaired in
  // update mode (the previous "reconnect loop" symptom).
  const [freshMode, setFreshMode] = useState(false);
  const createUpdateLinkToken = useCreatePlaidUpdateLinkToken();
  const createLinkToken = useCreatePlaidLinkToken();
  const exchange = useExchangePlaidPublicToken();
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
    function fetchFresh() {
      setFreshMode(true);
      createLinkToken.mutate(undefined, {
        onSuccess: (data) => setLinkToken(data.linkToken),
        onError: (err) => {
          setPending(null);
          setFreshMode(false);
          toast({
            title: "Could not start reconnect",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          });
        },
      });
    }
    function onEvent(e: Event) {
      const detail = (e as CustomEvent<PlaidReconnectEventDetail>).detail;
      if (!detail || !detail.itemId) return;
      setPending(detail);
      setFreshMode(false);
      createUpdateLinkToken.mutate(
        { data: { itemId: detail.itemId } },
        {
          onSuccess: (data) => setLinkToken(data.linkToken),
          onError: (err) => {
            // (#367) 409 + action:"relink" → mint a new token via
            // /plaid/link-token + /plaid/exchange instead of
            // dropping the user back at the toast. Server-side
            // self-heal in /plaid/exchange clears the chip.
            const apiErr = err as { status?: number; data?: { action?: string } };
            if (apiErr?.status === 409 && apiErr?.data?.action === "relink") {
              fetchFresh();
              return;
            }
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
  }, [createUpdateLinkToken, createLinkToken, toast]);

  const onSuccess = useCallback(async (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } | null }) => {
    const detail = pending;
    const wasFresh = freshMode;
    setLinkToken(null);
    setPending(null);
    setFreshMode(false);
    if (!detail || cancelledRef.current) return;
    if (wasFresh) {
      try {
        await new Promise<void>((resolve, reject) => {
          exchange.mutate(
            {
              data: {
                publicToken,
                institutionId: metadata.institution?.institution_id ?? null,
                institutionName:
                  metadata.institution?.name ?? detail.institutionName ?? null,
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
  }, [pending, qc, runSync, toast, freshMode, exchange]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setLinkToken(null);
      setPending(null);
      setFreshMode(false);
    },
  });

  useEffect(() => {
    if (linkToken && ready) {
      // (TEMP DIAG #804-followup) Identify which Plaid open() trigger
      // actually fires when the broken Capital One modal appears.
      // Remove once root cause is confirmed.
      // eslint-disable-next-line no-console
      console.log(
        "[plaid-diag] PlaidReconnectListener.open()",
        {
          pendingItemId: pending?.itemId ?? null,
          pendingInstitution: pending?.institutionName ?? null,
          freshMode,
          tokenPrefix: linkToken.slice(0, 24),
          ts: Date.now(),
        },
      );
      open();
    }
  }, [linkToken, ready, open, pending, freshMode]);

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
