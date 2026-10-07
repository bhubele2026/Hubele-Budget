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
import { Note } from "@/kit/Note";
import { buttonClass } from "@/kit/Button";

/**
 * The storage keys the classic app's Plaid Link button writes before it hands
 * the browser to the bank. Shared VERBATIM: Plaid's registered redirect URI is
 * `/plaid-oauth`, which H2 now serves, so a link started in the classic app
 * finishes here.
 */
export const PLAID_LINK_TOKEN_STORAGE_KEY = "h2:plaid:link_token";
export const PLAID_RETURN_TO_STORAGE_KEY = "h2:plaid:return_to";

/** Where a finished link goes back to when nothing was stored. */
export const DEFAULT_RETURN_TO = "/";

/**
 * Only app-relative paths are honoured: a tampered value that starts with
 * "//" or a scheme falls back to the default (no open redirect).
 */
export function safeReturnPath(stored: string | null): string {
  return stored && /^\/(?!\/)/.test(stored) ? stored : DEFAULT_RETURN_TO;
}

/** A path that belongs to the classic app needs a full page load, not a route change. */
export function isClassicPath(path: string): boolean {
  return path === "/classic" || path.startsWith("/classic/") || path.startsWith("/classic?");
}

type Outcome = { kind: "linking" } | { kind: "linked" } | { kind: "failed"; detail: string };

/**
 * ⭐ PLAID OAUTH RETURN — ported from the classic `pages/plaid-oauth.tsx`, the
 * logic unchanged: read the stored link token and return path, reopen Link
 * with the redirect URI, exchange the public token, refresh the linked items,
 * transactions and liability accounts, clear the stored keys, and go back.
 *
 * Differences, all forced by the move: the default return path is `/`; a
 * return path inside `/classic` (where the link usually starts today) is a
 * full page load, because it is another app; and the outcome is said on this
 * screen rather than in a toast, because H2 has no toast.
 */
export default function PlaidOAuthPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const exchange = useExchangePlaidPublicToken();

  const [storedToken, setStoredToken] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string>(DEFAULT_RETURN_TO);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "linking" });

  useEffect(() => {
    let token: string | null = null;
    let to = DEFAULT_RETURN_TO;
    try {
      token = localStorage.getItem(PLAID_LINK_TOKEN_STORAGE_KEY);
      to = safeReturnPath(localStorage.getItem(PLAID_RETURN_TO_STORAGE_KEY));
    } catch {
      // handled below
    }
    if (!token) {
      setError("The bank link session was lost. Start again where you began.");
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
      const target = returnTo || DEFAULT_RETURN_TO;
      window.setTimeout(() => {
        if (isClassicPath(target)) window.location.assign(target);
        else setLocation(target);
      }, delayMs);
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
            qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
            setOutcome({ kind: "linked" });
            cleanup();
            goBack(300);
          },
          onError: (err) => {
            setOutcome({ kind: "failed", detail: String(err) });
            cleanup();
            goBack(800);
          },
        },
      );
    },
    [exchange, qc, cleanup, goBack],
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
    if (storedToken && ready) open();
  }, [storedToken, ready, open]);

  if (error) {
    return (
      <div className="flex flex-col gap-4" data-testid="plaid-oauth">
        <h1 className="type-headline text-ink">The bank link did not finish.</h1>
        <Note kind="error">{error}</Note>
        <a href="/classic/settings" className={buttonClass({ variant: "quiet", size: "sm" }) + " self-start"}>
          Open settings in the classic app
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="plaid-oauth">
      <h1 className="type-headline text-ink">
        {outcome.kind === "linked" ? "Account linked." : "Finishing the bank link…"}
      </h1>
      {outcome.kind === "failed" ? (
        <Note kind="error">The link failed. {outcome.detail}</Note>
      ) : outcome.kind === "linked" ? (
        <Note kind="empty">Transactions are syncing.</Note>
      ) : (
        <p className="type-body text-ink-2">This usually takes a few seconds.</p>
      )}
    </div>
  );
}
