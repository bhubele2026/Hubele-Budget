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
import { Progress } from "@/components/ui/progress";
import { Plus, Loader2, CheckCircle2, AlertTriangle, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { PostLinkDebtDialog } from "@/components/post-link-debt-dialog";

export const PLAID_LINK_TOKEN_STORAGE_KEY = "h2:plaid:link_token";
export const PLAID_RETURN_TO_STORAGE_KEY = "h2:plaid:return_to";

// (#367) Plaid's first /transactions/sync after link returns empty for
// a few seconds while the historical batch stages on Plaid's backend.
// We previously polled 6× at fixed 5s = 30s total, which often gave
// up *just* before the INITIAL_UPDATE webhook fired and left the user
// thinking the link silently failed. Use a backoff schedule that sums
// to ~90s so the post-link banner still resolves automatically for the
// slow-staging institutions (Chase, Citi).
const POST_LINK_POLL_DELAYS_MS = [
  3_000, 4_000, 6_000, 8_000, 10_000, 12_000, 15_000, 15_000, 18_000,
];
const POST_LINK_TOTAL_ATTEMPTS = POST_LINK_POLL_DELAYS_MS.length;

// (#368) Live status surfaced by the inline post-link panel. Replaces
// the silent ~90s background poll + lone "Pulling your transactions"
// toast with an observable progress indicator so users at slow banks
// (Chase, Citi) can tell the import is healthy and not stuck.
type PostLinkPhase =
  | "preparing"
  | "polling"
  | "ready"
  | "still-preparing"
  | "error";

export type PostLinkStatus = {
  phase: PostLinkPhase;
  // Number of polls completed (0 before the first attempt fires, so
  // the progress bar advances after each /transactions/sync result).
  attempt: number;
  totalAttempts: number;
  institutionName: string | null;
  added: number;
  modified: number;
  errorMessage: string | null;
  // (#403) YYYY-MM-DD min/max occurredOn across the rows actually
  // inserted by every poll so far. Powers the "Imported N
  // transactions from Mar 5 – Apr 28" caption and the "still
  // importing recent activity" hint when no current-month rows have
  // landed yet.
  importedDateRange: { min: string; max: string } | null;
};

export function PlaidLinkButton({
  onLinked,
  onImportReady,
  label,
}: {
  onLinked?: () => void;
  /**
   * Fires once per link flow when the post-link poll detects that the
   * freshly-linked item has produced rows (the panel reaches `ready`).
   * Used by callers (e.g. the Chase transactions page) to jump the
   * month navigator to the most recent month that actually has imported
   * data, so the user sees their transactions immediately instead of an
   * empty-state pinned to the currently-selected month.
   */
  onImportReady?: (info: { added: number; modified: number }) => void;
  label?: string;
} = {}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [postLinkAccounts, setPostLinkAccounts] = useState<
    PlaidLiabilityAccount[]
  >([]);
  const [postLinkOpen, setPostLinkOpen] = useState(false);
  // (#368) Live status for the inline progress panel rendered below the
  // button while the post-link poll loop runs. `null` = panel hidden.
  const [postLinkStatus, setPostLinkStatus] = useState<PostLinkStatus | null>(
    null,
  );
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
  // signaled by an INITIAL_UPDATE webhook). Poll a few times with a live
  // progress indicator so the user can see the import is healthy.
  const pollAfterLink = useCallback(
    async (justLinkedItemId: string | undefined, institutionName: string | null) => {
      let totalAdded = 0;
      let totalModified = 0;
      let lastErrors: string[] = [];
      // (#403) Accumulate the inserted-rows window across every poll
      // so the panel caption shows the full span the import covers.
      let aggMin: string | null = null;
      let aggMax: string | null = null;
      for (let i = 0; i < POST_LINK_POLL_DELAYS_MS.length; i++) {
        const delay = POST_LINK_POLL_DELAYS_MS[i];
        await new Promise((r) => setTimeout(r, delay));
        if (cancelledRef.current) return;
        // Scope each poll to the just-linked item when we have its row id
        // so we don't drag every other linked bank along for the ride
        // every few seconds.
        const totals = await runSync({
          silent: true,
          ...(justLinkedItemId ? { itemId: justLinkedItemId } : {}),
        });
        if (cancelledRef.current) return;
        totalAdded += totals.added;
        totalModified += totals.modified;
        lastErrors = totals.errors;
        const attemptNumber = i + 1;
        if (totals.importedDateRange) {
          const { min, max } = totals.importedDateRange;
          if (aggMin === null || min < aggMin) aggMin = min;
          if (aggMax === null || max > aggMax) aggMax = max;
        }
        const importedDateRange =
          aggMin && aggMax ? { min: aggMin, max: aggMax } : null;
        if (totals.errors.length > 0) {
          // Stop polling early on hard errors — no point hammering a
          // failing item every few seconds. Surface the per-item error
          // (already prefixed with "Plaid:" / institution name where
          // available) inline so the panel itself tells the user what
          // broke and what to do next.
          setPostLinkStatus({
            phase: "error",
            attempt: attemptNumber,
            totalAttempts: POST_LINK_TOTAL_ATTEMPTS,
            institutionName,
            added: totalAdded,
            modified: totalModified,
            errorMessage: totals.errors
              .map((m) => (m.startsWith("Plaid:") ? m : `Plaid: ${m}`))
              .join("; "),
            importedDateRange,
          });
          return;
        }
        if (totals.added > 0 || totals.modified > 0) {
          setPostLinkStatus({
            phase: "ready",
            attempt: attemptNumber,
            totalAttempts: POST_LINK_TOTAL_ATTEMPTS,
            institutionName,
            added: totalAdded,
            modified: totalModified,
            errorMessage: null,
            importedDateRange,
          });
          // (#400) Tell the host page (e.g. Chase /transactions) that
          // the freshly-linked import has landed, so it can jump the
          // month navigator to whichever month actually has the new
          // rows instead of leaving the user staring at an empty list.
          // Also force a refetch of /plaid/items so the SyncButton chip
          // and reauth banner clear without a page reload — the prior
          // invalidate inside runSync() is enough in most cases, but
          // a defensive refetch here guarantees the post-import UI is
          // consistent in the same render pass as the new transactions.
          onImportReady?.({ added: totalAdded, modified: totalModified });
          void qc.refetchQueries({ queryKey: getListPlaidItemsQueryKey() });
          return;
        }
        // Still empty — keep polling but advance the progress so the
        // user can see we're actively working.
        setPostLinkStatus({
          phase: "polling",
          attempt: attemptNumber,
          totalAttempts: POST_LINK_TOTAL_ATTEMPTS,
          institutionName,
          added: totalAdded,
          modified: totalModified,
          errorMessage: null,
          importedDateRange,
        });
      }
      if (cancelledRef.current) return;
      const importedDateRange =
        aggMin && aggMax ? { min: aggMin, max: aggMax } : null;
      // Ran out of attempts with no rows — Plaid is slow but not broken.
      setPostLinkStatus({
        phase: "still-preparing",
        attempt: POST_LINK_TOTAL_ATTEMPTS,
        totalAttempts: POST_LINK_TOTAL_ATTEMPTS,
        institutionName,
        added: totalAdded,
        modified: totalModified,
        importedDateRange,
        errorMessage:
          lastErrors.length > 0
            ? lastErrors
                .map((m) => (m.startsWith("Plaid:") ? m : `Plaid: ${m}`))
                .join("; ")
            : null,
      });
    },
    [runSync, onImportReady, qc],
  );

  const onSuccess = useCallback(
    (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } | null }) => {
      const institutionName = metadata.institution?.name ?? null;
      exchange.mutate(
        {
          data: {
            publicToken,
            institutionId: metadata.institution?.institution_id ?? null,
            institutionName,
          },
        },
        {
          onSuccess: async (exchangeRes) => {
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
            // (#368) Show an inline status panel instead of a one-shot
            // toast so the user can watch the import progress instead of
            // staring at a stale "Pulling your transactions" message.
            setPostLinkStatus({
              phase: "preparing",
              attempt: 0,
              totalAttempts: POST_LINK_TOTAL_ATTEMPTS,
              institutionName,
              added: 0,
              modified: 0,
              errorMessage: null,
              importedDateRange: null,
            });
            setLinkToken(null);
            clearStoredLinkToken();
            onLinked?.();

            // (#44) Scope post-Link candidates to the just-linked item so
            // we don't surface unrelated historical accounts from other
            // institutions — and skip anything already linked to a debt.
            const justLinkedItemId = (exchangeRes as { id?: string }).id;
            const candidates = liabilityAccounts.filter(
              (a) =>
                !a.linkedDebt &&
                a.suggestedDebt &&
                (justLinkedItemId ? a.itemId === justLinkedItemId : true),
            );
            if (candidates.length > 0) {
              setPostLinkAccounts(candidates);
              setPostLinkOpen(true);
            }

            // Fire-and-forget background poll so the freshly-linked item
            // populates as soon as Plaid finishes the initial export.
            void pollAfterLink(justLinkedItemId, institutionName);
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
      {postLinkStatus && (
        <PostLinkProgressPanel
          status={postLinkStatus}
          onDismiss={() => setPostLinkStatus(null)}
        />
      )}
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

// (#403) "YYYY-MM-DD" → "May 5". Uses UTC parts to stay timezone-stable
// so the displayed range matches what landed in occurred_on.
function formatYmdShort(ymd: string): string {
  const [y, m, d] = ymd.split("-").map((s) => Number(s));
  if (!y || !m || !d) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatImportedDateRange(min: string, max: string): string {
  if (min === max) return formatYmdShort(min);
  return `${formatYmdShort(min)} – ${formatYmdShort(max)}`;
}

function firstOfCurrentMonthIso(today: Date = new Date()): string {
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

export function PostLinkProgressPanel({
  status,
  onDismiss,
}: {
  status: PostLinkStatus;
  onDismiss: () => void;
}) {
  const {
    phase,
    attempt,
    totalAttempts,
    institutionName,
    added,
    modified,
    errorMessage,
    importedDateRange,
  } = status;
  const bank = institutionName?.trim() || "your bank";
  const dateRangeLabel = importedDateRange
    ? formatImportedDateRange(importedDateRange.min, importedDateRange.max)
    : null;
  // (#403) When the import landed but the newest inserted row is
  // older than today's calendar month, surface a "still importing
  // recent activity" hint so the user understands why their dashboard
  // tiles for the current period are still showing $0 — instead of
  // taking a green "Ready" panel as confirmation that everything is
  // present.
  const recentActivityMissing =
    phase === "ready" &&
    importedDateRange != null &&
    importedDateRange.max < firstOfCurrentMonthIso();
  const percent = Math.min(
    100,
    Math.round(((phase === "ready" || phase === "still-preparing" || phase === "error" ? totalAttempts : attempt) / totalAttempts) * 100),
  );
  const dismissible = phase === "ready" || phase === "still-preparing" || phase === "error";

  let title: string;
  let detail: string;
  if (phase === "preparing") {
    title = `Linked ${bank}`;
    detail = "Preparing your transactions…";
  } else if (phase === "polling") {
    title = `Pulling transactions from ${bank}`;
    detail = `Checking for data — attempt ${attempt} of ${totalAttempts}.`;
  } else if (phase === "ready") {
    const parts: string[] = [];
    if (added > 0) parts.push(`${added} added`);
    if (modified > 0) parts.push(`${modified} updated`);
    title = `Ready — ${parts.join(", ")}`;
    // (#403) Replace the generic "Imported from <bank>" copy with the
    // actual date span the rows cover, so users can immediately tell
    // whether the window includes their current-month activity. When
    // none of the inserted rows are current-month, swap in the
    // "still importing recent activity" hint instead of a silent
    // success — the user just told us their dashboard tiles for the
    // visible period are at $0 and we don't want to confirm "Ready"
    // when in fact only historical data has landed.
    detail = recentActivityMissing
      ? dateRangeLabel
        ? `Imported ${dateRangeLabel} from ${bank}. Still importing recent activity — check back shortly.`
        : `Imported historical data from ${bank}. Still importing recent activity — check back shortly.`
      : dateRangeLabel
        ? `Imported ${dateRangeLabel} from ${bank}.`
        : `Imported from ${bank}.`;
  } else if (phase === "still-preparing") {
    title = "Still preparing";
    detail = `${bank} hasn't finished its initial export yet. Try Sync again in a minute, or new charges will appear automatically on the next refresh.`;
  } else {
    title = "Sync had errors";
    detail = errorMessage ?? `Couldn't pull from ${bank}.`;
  }

  const variant =
    phase === "error"
      ? "border-destructive/40 bg-destructive/5"
      : phase === "ready"
        ? "border-emerald-500/40 bg-emerald-500/5"
        : "border-border bg-muted/30";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="panel-post-link-progress"
      data-phase={phase}
      className={`mt-3 rounded-md border p-3 text-sm ${variant}`}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">
          {phase === "preparing" || phase === "polling" ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : phase === "ready" ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          ) : (
            <AlertTriangle
              className={`w-4 h-4 ${phase === "error" ? "text-destructive" : "text-amber-600"}`}
            />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="font-medium leading-tight"
            data-testid="text-post-link-title"
          >
            {title}
          </div>
          <div
            className="text-muted-foreground mt-0.5"
            data-testid="text-post-link-detail"
          >
            {detail}
          </div>
          {(phase === "preparing" || phase === "polling") && (
            <Progress
              value={percent}
              className="mt-2 h-1.5"
              data-testid="progress-post-link"
            />
          )}
        </div>
        {dismissible && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="button-post-link-dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
