import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import {
  useCreatePlaidLinkToken,
  useExchangePlaidPublicToken,
  useGetPlaidEnvironment,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  listPlaidLiabilityAccounts,
  type PlaidLiabilityAccount,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Plus, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { PostLinkDebtDialog } from "@/components/post-link-debt-dialog";

export const PLAID_LINK_TOKEN_STORAGE_KEY = "h2:plaid:link_token";
export const PLAID_RETURN_TO_STORAGE_KEY = "h2:plaid:return_to";

const POST_LINK_POLL_DELAY_MS = 5_000;
const POST_LINK_POLL_MAX_ATTEMPTS = 6;

export function PlaidLinkButton({
  onLinked,
  label,
}: {
  onLinked?: () => void;
  label?: string;
} = {}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [postLinkAccounts, setPostLinkAccounts] = useState<
    PlaidLiabilityAccount[]
  >([]);
  const [postLinkOpen, setPostLinkOpen] = useState(false);
  const createLinkToken = useCreatePlaidLinkToken();
  const exchange = useExchangePlaidPublicToken();
  const { data: plaidEnv } = useGetPlaidEnvironment();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { runSync } = usePlaidSync();
  // Tracks unmount so a long-running post-link poll can't fire toasts
  // (or keep scheduling timers) after the user navigates away.
  const cancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const fetchToken = useCallback(() => {
    createLinkToken.mutate(undefined, {
      onSuccess: (data) => setLinkToken(data.linkToken),
      onError: (err) => {
        toast({
          title: "Could not start Plaid Link",
          description: String(err),
          variant: "destructive",
        });
      },
    });
  }, [createLinkToken, toast]);

  const clearStoredLinkToken = useCallback(() => {
    try {
      localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY);
      localStorage.removeItem(PLAID_RETURN_TO_STORAGE_KEY);
    } catch {
      // ignore — storage may be unavailable
    }
  }, []);

  // Plaid /transactions/sync usually returns empty on the very first call
  // for a freshly-linked item — the historical batch is staged on Plaid's
  // backend and only becomes available a few seconds later (normally
  // signaled by an INITIAL_UPDATE webhook). Poll silently a few times so
  // the user sees their data without manually clicking Sync.
  const pollAfterLink = useCallback(async () => {
    let totalAdded = 0;
    let totalModified = 0;
    let lastErrors: string[] = [];
    for (let attempt = 0; attempt < POST_LINK_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POST_LINK_POLL_DELAY_MS));
      if (cancelledRef.current) return;
      const totals = await runSync({ silent: true });
      if (cancelledRef.current) return;
      totalAdded += totals.added;
      totalModified += totals.modified;
      lastErrors = totals.errors;
      if (totals.added > 0 || totals.modified > 0) break;
    }
    if (cancelledRef.current) return;
    if (totalAdded + totalModified > 0) {
      const parts: string[] = [];
      if (totalAdded > 0) parts.push(`Added ${totalAdded}`);
      if (totalModified > 0) parts.push(`updated ${totalModified}`);
      toast({
        title: "Transactions imported",
        description: `${parts.join(", ")} from your newly linked account.`,
      });
    } else if (lastErrors.length > 0) {
      toast({
        title: "Sync had errors",
        description: lastErrors
          .map((m) => (m.startsWith("Plaid:") ? m : `Plaid: ${m}`))
          .join("; "),
        variant: "destructive",
      });
    } else {
      toast({
        title: "Still preparing transactions",
        description:
          "Your bank hasn't finished its initial export yet. Click Sync again in a minute, or new charges will appear automatically on the next refresh.",
      });
    }
  }, [runSync, toast]);

  const onSuccess = useCallback(
    (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } | null }) => {
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
            // Trigger a server-side liabilities fetch so debt-like accounts
            // appear immediately in pickers, then refresh the cached query.
            // (#44) Also use the result to surface a one-click "create
            // debts" dialog for any newly-linked credit/loan accounts that
            // aren't already wired to a debt row.
            let liabilityAccounts: PlaidLiabilityAccount[] = [];
            try {
              liabilityAccounts = await listPlaidLiabilityAccounts({
                refresh: true,
              });
            } catch {
              // ignore — query invalidation below will retry without refresh
            }
            qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
            toast({
              title: "Account linked",
              description: "Pulling your transactions — this can take a few seconds.",
            });
            setLinkToken(null);
            clearStoredLinkToken();
            onLinked?.();

            // (#44) Show the post-Link dialog when there are unmatched
            // debt-like accounts. We rely on suggestedDebt (set by the API
            // for credit/loan/student/mortgage accounts) and skip anything
            // already linked to a debt row.
            const candidates = liabilityAccounts.filter(
              (a) => !a.linkedDebt && a.suggestedDebt,
            );
            if (candidates.length > 0) {
              setPostLinkAccounts(candidates);
              setPostLinkOpen(true);
            }

            // Fire-and-forget background poll so the freshly-linked item
            // populates as soon as Plaid finishes the initial export.
            void pollAfterLink();
          },
          onError: (err) => {
            toast({
              title: "Link failed",
              description: String(err),
              variant: "destructive",
            });
            clearStoredLinkToken();
          },
        },
      );
    },
    [exchange, qc, toast, clearStoredLinkToken, onLinked, pollAfterLink],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setLinkToken(null);
      clearStoredLinkToken();
    },
  });

  useEffect(() => {
    if (linkToken && ready) {
      // Stash the active link_token (and where to return to) before
      // opening Link, so OAuth bounce-back can resume the handshake.
      try {
        localStorage.setItem(PLAID_LINK_TOKEN_STORAGE_KEY, linkToken);
        localStorage.setItem(
          PLAID_RETURN_TO_STORAGE_KEY,
          window.location.pathname + window.location.search,
        );
      } catch {
        // ignore — non-OAuth banks still work without storage
      }
      open();
    }
  }, [linkToken, ready, open]);

  const busy = createLinkToken.isPending || exchange.isPending;
  // Disable Link Bank when the API reports Plaid isn't configured (or the
  // server reported a config error like a missing/invalid PLAID_ENV) so
  // the user gets a clear, immediate signal instead of a runtime failure
  // after Plaid Link tries to load.
  const notConfigured = plaidEnv ? !plaidEnv.configured : false;
  const hasConfigError = Boolean(plaidEnv?.configError);
  const disabledReason = plaidEnv?.configError
    ? plaidEnv.configError
    : notConfigured
      ? "Plaid is not configured. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV in Secrets."
      : null;

  return (
    <>
      <Button
        onClick={fetchToken}
        disabled={busy || notConfigured || hasConfigError}
        title={disabledReason ?? undefined}
        data-testid="button-link-bank"
      >
        {busy ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <Plus className="w-4 h-4 mr-2" />
        )}
        {label ?? "Link a Bank or Card"}
      </Button>
      {postLinkOpen && postLinkAccounts.length > 0 && (
        <PostLinkDebtDialog
          open={postLinkOpen}
          onOpenChange={(v) => {
            setPostLinkOpen(v);
            if (!v) setPostLinkAccounts([]);
          }}
          accounts={postLinkAccounts}
        />
      )}
    </>
  );
}
