import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { usePlaidLink } from "react-plaid-link";
import { useQueryClient } from "@tanstack/react-query";
import {
  useExchangePlaidPublicToken,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  listPlaidLiabilityAccounts,
} from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  PLAID_LINK_TOKEN_STORAGE_KEY,
  PLAID_RETURN_TO_STORAGE_KEY,
} from "@/components/plaid-link-button";

export default function PlaidOAuthPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const exchange = useExchangePlaidPublicToken();

  const [storedToken, setStoredToken] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string>("/dashboard");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let token: string | null = null;
    let to = "/dashboard";
    try {
      token = localStorage.getItem(PLAID_LINK_TOKEN_STORAGE_KEY);
      const stored = localStorage.getItem(PLAID_RETURN_TO_STORAGE_KEY);
      // Only honor app-relative paths to prevent open-redirect via a
      // tampered localStorage value. Anything starting with "//", a
      // scheme, or not a leading "/" falls back to /dashboard.
      if (stored && /^\/(?!\/)/.test(stored)) {
        to = stored;
      }
    } catch {
      // ignore — handled below
    }
    if (!token) {
      setError(
        "We lost track of your bank link session. Please start over from the page where you began linking.",
      );
      return;
    }
    setStoredToken(token);
    setReturnTo(to);
  }, []);

  const cleanup = useCallback(() => {
    try {
      localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY);
      localStorage.removeItem(PLAID_RETURN_TO_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const goBack = useCallback(
    (delayMs = 0) => {
      const target = returnTo || "/dashboard";
      window.setTimeout(() => setLocation(target), delayMs);
    },
    [returnTo, setLocation],
  );

  const onSuccess = useCallback(
    (
      publicToken: string,
      metadata: { institution?: { institution_id?: string; name?: string } | null },
    ) => {
      exchange.mutate(
        {
          data: {
            publicToken,
            institutionId: metadata.institution?.institution_id ?? null,
            institutionName: metadata.institution?.name ?? null,
          },
        },
        {
          onSuccess: async () => {
            qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
            qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
            try {
              await listPlaidLiabilityAccounts({ refresh: true });
            } catch {
              // ignore
            }
            qc.invalidateQueries({
              queryKey: getListPlaidLiabilityAccountsQueryKey(),
            });
            toast({
              title: "Account linked",
              description: "Transactions are syncing.",
            });
            cleanup();
            goBack(300);
          },
          onError: (err) => {
            toast({
              title: "Link failed",
              description: String(err),
              variant: "destructive",
            });
            cleanup();
            goBack(800);
          },
        },
      );
    },
    [exchange, qc, toast, cleanup, goBack],
  );

  const { open, ready } = usePlaidLink({
    token: storedToken,
    receivedRedirectUri: typeof window !== "undefined" ? window.location.href : undefined,
    onSuccess,
    onExit: () => {
      cleanup();
      goBack(0);
    },
  });

  useEffect(() => {
    if (storedToken && ready) {
      open();
    }
  }, [storedToken, ready, open]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="text-center space-y-3 max-w-md">
        {error ? (
          <>
            <h1 className="text-xl font-semibold">Couldn't finish linking</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
            <button
              className="text-sm text-primary underline"
              onClick={() => setLocation("/settings")}
            >
              Go to Settings
            </button>
          </>
        ) : (
          <>
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
            <h1 className="text-xl font-semibold">Finishing bank link…</h1>
            <p className="text-sm text-muted-foreground">
              We're completing the connection with your bank. This usually
              takes a few seconds.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
