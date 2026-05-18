import { useCallback, useEffect, useRef, useState } from "react";
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

// Plaid error codes that mean "the user must re-authenticate this item via
// Plaid Link in update mode". Mirrors PLAID_REAUTH_ERROR_CODES on the server
// (artifacts/api-server/src/routes/plaid.ts) — keep in sync.
export const PLAID_REAUTH_ERROR_CODES = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  // (#654) Plaid hard-rejects the stored access_token itself — most
  // commonly because it was issued for a different Plaid environment
  // than the server is now talking to (e.g. a sandbox-prefixed token
  // on a production server). The only fix is for the user to re-link
  // the bank in the active environment, so this code surfaces the
  // same Reconnect CTA as the other reauth codes. Mirrors the server
  // set in artifacts/api-server/src/lib/plaidReauthCodes.ts.
  "INVALID_ACCESS_TOKEN",
]);

export function isPlaidReauthCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return PLAID_REAUTH_ERROR_CODES.has(code);
}

// (#710) Mirrors the server-side `isSyntheticPlaidItem` helper in
// artifacts/api-server/src/lib/plaid.ts. Synthetic seed rows (e.g. the
// April-2026 Chase placeholder inserted by aprilChaseSeed.ts) are not
// real Plaid connections — they exist only to anchor the bank-snapshot
// tile before the user has completed OAuth. Their itemId always starts
// with `seed-`. We never want the reauth banner / Connect-a-bank guard
// / sync popover to surface them as "needs reconnect", because there's
// no Plaid Link update-mode flow that can heal a row Plaid has never
// heard of (clicking Reconnect would silently no-op). Keep the prefix
// in sync with SYNTHETIC_ITEM_ID in aprilChaseSeed.ts.
export function isSyntheticPlaidItem(
  item: { itemId?: string | null } | null | undefined,
): boolean {
  const id = item?.itemId ?? "";
  return id.startsWith("seed-");
}

// (#228) Friendly per-code copy that the page-top reconnect banner, the
// DebtReauthBanner, and the Settings "Needs reconnect" badge all share so
// the user knows *why* the Plaid Link popup is about to ask for credentials
// again before they click Reconnect. Keep keys aligned with
// PLAID_REAUTH_ERROR_CODES above.
//
// Codes (per Plaid):
//   ITEM_LOGIN_REQUIRED — saved password / MFA is no longer valid (most
//     common case; happens after a password change at the bank or an idle
//     session timeout).
//   PENDING_EXPIRATION — OAuth consent for this institution will expire
//     soon and the user should re-authorize before that happens.
//   PENDING_DISCONNECT — Plaid has flagged this connection for shutdown
//     (data partner change, deprecated integration); user must reconnect
//     before the cutoff or the link goes dead.
export const PLAID_REAUTH_ERROR_REASONS: Record<string, string> = {
  ITEM_LOGIN_REQUIRED:
    "Your saved login expired — sign in again to keep transactions in sync.",
  PENDING_EXPIRATION:
    "This bank's connection is about to expire — re-authorize to keep it linked.",
  PENDING_DISCONNECT:
    "Plaid will disconnect this bank soon — reconnect now to keep it linked.",
  // (#654) Worded so a non-technical user knows what to do without
  // exposing the underlying "wrong Plaid environment" detail.
  INVALID_ACCESS_TOKEN:
    "This bank's saved login is no longer valid — reconnect to bring in new transactions.",
};

const PLAID_REAUTH_FALLBACK_REASON =
  "Plaid needs you to re-authorize this bank.";

/**
 * (#238) Format a Plaid `consent_expiration_time` ISO string into the
 * short, locale-aware date the dated PENDING_EXPIRATION /
 * PENDING_DISCONNECT subline copy uses ("May 21" when same calendar
 * year as today, "May 21, 2027" otherwise so an out-of-year cutoff
 * isn't ambiguous). Returns null for any unparseable / missing input
 * so callers can safely fall back to the date-less copy.
 */
export function formatPlaidConsentExpirationDate(
  iso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

/**
 * Returns a one-line, user-facing reason explaining why an item needs to be
 * reconnected. Falls back to a generic "needs re-authorization" message for
 * any code we don't have specific copy for (including null / unknown codes
 * that still landed in a re-auth state via some other signal).
 *
 * (#238) When `consentExpirationAt` is provided AND the code is one of the
 * dated re-auth states (PENDING_EXPIRATION / PENDING_DISCONNECT) the copy
 * inlines the actual cutoff date so the user knows how urgent the
 * reconnect is ("Chase will disconnect on May 21 — reconnect now to keep
 * it linked.") instead of the vague "soon". For any other code, or when
 * Plaid did not report a cutoff for this item, falls back to the original
 * date-less per-code copy.
 *
 * `institutionName` makes the dated copy name the actual bank ("Chase
 * will disconnect on May 21") instead of a generic pronoun. Falls back
 * to "This bank" when the caller has no institution name to thread
 * through (e.g. an unnamed item).
 */
export function plaidReauthReason(
  code: string | null | undefined,
  opts: {
    consentExpirationAt?: string | null;
    institutionName?: string | null;
  } = {},
): string {
  if (!code) return PLAID_REAUTH_FALLBACK_REASON;
  const dated =
    code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT";
  if (dated) {
    const dateLabel = formatPlaidConsentExpirationDate(
      opts.consentExpirationAt,
    );
    if (dateLabel) {
      const subject = opts.institutionName?.trim() || "This bank";
      const verb =
        code === "PENDING_DISCONNECT" ? "disconnect" : "expire";
      return `${subject} will ${verb} on ${dateLabel} — reconnect now to keep it linked.`;
    }
  }
  return PLAID_REAUTH_ERROR_REASONS[code] ?? PLAID_REAUTH_FALLBACK_REASON;
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
    const totals = await runSync({ itemId, silent: true });
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
  }, [institutionName, itemId, qc, runSync, toast, freshMode, exchange]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setLinkToken(null);
      setFreshMode(false);
    },
  });

  useEffect(() => {
    if (linkToken && ready) open();
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
