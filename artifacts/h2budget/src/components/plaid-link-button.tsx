import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { usePlaidLink } from "react-plaid-link";
import {
  useCreatePlaidLinkToken,
  useExchangePlaidPublicToken,
  useGetPlaidEnvironment,
  useListPlaidItems,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  listPlaidLiabilityAccounts,
  listPlaidItems,
  type PlaidLiabilityAccount,
  type PlaidItemDetail,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Loader2, CheckCircle2, AlertTriangle, X, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { PostLinkDebtDialog } from "@/components/post-link-debt-dialog";
import {
  setPostLinkProgress,
  clearPostLinkProgress,
  usePostLinkProgress,
} from "@/components/post-link-progress";
import {
  PlaidReconnectButton,
  isPlaidReauthCode,
  isSyntheticPlaidItem,
} from "@/components/plaid-reconnect-button";

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
  // (#402) First-of-month string ("YYYY-MM-01") used by the "View
  // imported transactions" deep-link in the Ready panel. Server-
  // provided per-item `lastOccurredOn` (max date across rows touched
  // by this sync) is bucketed into a month key. Null on non-ready
  // phases.
  mostRecentMonth: string | null;
  // (#408) When set, the linked item still carries an actionable
  // re-auth / malformed-token state on the server. The Ready panel
  // suppresses the green "Ready — N added" pill in this case so a
  // stale poll result can't override the yellow reconnect banner the
  // user is actively reading.
  itemErrorCode?: string | null;
  itemErrorKind?: string | null;
  // (#408) Newest occurredOn for any Plaid-sourced row on the linked
  // item before the just-finished sync. When the post-heal sync
  // returns zero added rows, the panel uses this date to render
  // "No new transactions since <date>" instead of the misleading
  // "Ready — 0 added".
  lastBankTxOn?: string | null;
};

export function PlaidLinkButton({
  onLinked,
  onImportReady,
  onOpen: onOpenProp,
  onExit: onExitProp,
  label,
  viewTransactionsPath = "/transactions",
  inlineProgress = true,
  addAccountItemId,
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
  /**
   * (#804-followup) Fires the moment the Plaid SDK is about to open its
   * iframe modal. Callers that render this button INSIDE another modal
   * (e.g. the debt-link PlaidAccountPicker shadcn Dialog) use this hook
   * to flip their own Dialog into non-modal mode, releasing Radix's
   * FocusScope so the Plaid iframe at the document root can receive
   * pointer and focus events. Without that, the user sees a CAPTCHA
   * checkbox they can't click and a text input they can't focus.
   */
  onOpen?: () => void;
  /**
   * (#804-followup) Fires after the Plaid SDK closes its modal without
   * a successful exchange (user dismissed, errored out, etc). Pairs
   * with `onOpen` so a parent Dialog that yielded modality while Plaid
   * was on screen can restore its own focus trap.
   */
  onExit?: () => void;
  label?: string;
  /**
   * (#402) Base path for the "View imported transactions" deep-link in
   * the Ready panel. Defaults to /transactions (Chase). The Amex page
   * passes "/amex" so credit-card imports land on the page that actually
   * shows the new rows instead of the bank-only Transactions list.
   */
  viewTransactionsPath?: string;
  /**
   * (#379) Controls the inline progress panel rendered just below the
   * button. Defaults to `true` (panel renders, preserving the original
   * behavior). Pages that already render a shared
   * `<PostLinkProgressBanner />` above their header should pass `false`
   * so users see a single, prominent progress indicator instead of two
   * stacked panels. Chase and Amex pass `false`; Settings keeps the
   * default `true` for backward compatibility.
   */
  inlineProgress?: boolean;
  /**
   * (#795) When set, this button skips the fresh-OAuth flow entirely and
   * opens Plaid Link in update-mode "add new account" against this
   * existing healthy item row id. Used by the debt-link picker to
   * PROACTIVELY steer a user who is adding a card at a bank they already
   * have linked (e.g. Chase checking → Chase Prime Visa) into the
   * existing item, instead of minting a fresh OAuth grant that — at
   * OAuth banks like Chase — silently invalidates the prior item's
   * session. The reactive exchange→409→add-account fallback only fires
   * AFTER that fresh grant has already broken the first item; steering
   * up front avoids the damage entirely.
   */
  addAccountItemId?: string | null;
} = {}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [postLinkAccounts, setPostLinkAccounts] = useState<
    PlaidLiabilityAccount[]
  >([]);
  const [postLinkOpen, setPostLinkOpen] = useState(false);
  // (#706) Fresh-link guard. When the user clicks "Link a Bank or Card"
  // while one of their already-linked items is in a reauth-pending state
  // (most commonly INVALID_ACCESS_TOKEN after a token expired), we open
  // a confirm dialog steering them into update mode for the dead item
  // first. Spawning a second fresh link for the same institution is
  // exactly what stranded the user's Chase transactions: the new item
  // returned the balance but Plaid's transaction cursor lived on the
  // dead one, so /transactions/sync returned zero added forever.
  const [reauthGuardOpen, setReauthGuardOpen] = useState(false);
  // (#706) `isFetched` gates the guard against the loading race: until
  // /plaid/items has resolved at least once, `data` is undefined and
  // `itemsNeedingReauth.length === 0`, so a fast click would otherwise
  // sneak past the check and spawn the duplicate this guard exists to
  // prevent. The Link button is disabled below until isFetched.
  const { data: existingItems, isFetched: itemsFetched } = useListPlaidItems();
  const itemsNeedingReauth: PlaidItemDetail[] = useMemo(
    () =>
      // (#710) Skip synthetic seed rows (itemId `seed-…`) — they're a
      // server-side placeholder for the bank-snapshot tile, not a real
      // Plaid link. They can carry INVALID_ACCESS_TOKEN when the
      // env-mismatch remediation has stamped them, but there's no Plaid
      // update-mode flow that can heal them, so they shouldn't trip the
      // fresh-link guard dialog and steer the user toward a Reconnect
      // popup that would no-op.
      (existingItems ?? []).filter(
        (it) =>
          isPlaidReauthCode(it.lastSyncErrorCode) && !isSyntheticPlaidItem(it),
      ),
    [existingItems],
  );
  // (#706) Once the user successfully reconnects from inside the dialog,
  // the next /plaid/items refetch clears the reauth code and the row
  // drops out of `itemsNeedingReauth`. Close the dialog at that point
  // so the user isn't left staring at an empty list.
  useEffect(() => {
    if (reauthGuardOpen && itemsFetched && itemsNeedingReauth.length === 0) {
      setReauthGuardOpen(false);
    }
  }, [reauthGuardOpen, itemsFetched, itemsNeedingReauth.length]);
  // (#368/#379) Live status for the post-link progress panel. State
  // lives in the shared store (see post-link-progress.tsx) so the Chase
  // and Amex pages can render an above-the-header banner that subscribes
  // to the same channel as this button's inline panel.
  const { status: postLinkStatus } = usePostLinkProgress();
  const setPostLinkStatus = setPostLinkProgress;
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

  const requestFreshLinkToken = useCallback(() => {
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

  // (#795) Open Plaid Link directly in update-mode add-account against an
  // existing healthy item. Mirrors the reactive add-account fallback in
  // onSuccess.onError, but is initiated UP FRONT by the debt-link picker
  // so the fresh OAuth grant that would invalidate the prior item never
  // happens in the first place.
  const requestAddAccountLinkToken = useCallback(
    (itemRowId: string) => {
      createAddAccountLinkToken.mutate(
        { data: { itemId: itemRowId } },
        {
          onSuccess: (data) => setLinkToken(data.linkToken),
          onError: (err) => {
            toast({
              title: "Could not start Plaid Link",
              description: String(err),
              variant: "destructive",
            });
          },
        },
      );
    },
    [createAddAccountLinkToken, toast],
  );

  // (#706) Intercept the fresh-link click when an existing item needs
  // reauth — show the guard dialog so the user is steered into update
  // mode for the dead item before spawning a duplicate.
  const fetchToken = useCallback(() => {
    // (#795) Explicit add-account mode wins — the caller already knows
    // exactly which existing item this account belongs to, so there's no
    // fresh OAuth grant to guard against.
    if (addAccountItemId) {
      requestAddAccountLinkToken(addAccountItemId);
      return;
    }
    if (itemsNeedingReauth.length > 0) {
      setReauthGuardOpen(true);
      return;
    }
    requestFreshLinkToken();
  }, [
    addAccountItemId,
    requestAddAccountLinkToken,
    itemsNeedingReauth.length,
    requestFreshLinkToken,
  ]);

  const proceedWithFreshLink = useCallback(() => {
    setReauthGuardOpen(false);
    requestFreshLinkToken();
  }, [requestFreshLinkToken]);

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
  // (#408) Look up the just-linked item from /plaid/items so the
  // post-link panel can suppress a stale green "Ready" pill when the
  // item still carries an actionable reauth state on the server, and
  // can render "No new transactions since <date>" when a heal-driven
  // backfill landed zero rows. Best-effort — any failure leaves the
  // fields null and the panel falls back to its existing copy.
  const fetchJustLinkedItemMeta = useCallback(
    async (
      justLinkedItemId: string | undefined,
    ): Promise<{
      itemErrorCode: string | null;
      itemErrorKind: string | null;
      lastBankTxOn: string | null;
    }> => {
      if (!justLinkedItemId) {
        return { itemErrorCode: null, itemErrorKind: null, lastBankTxOn: null };
      }
      try {
        const items = await listPlaidItems();
        const found = items.find((it) => it.id === justLinkedItemId);
        if (!found) {
          return {
            itemErrorCode: null,
            itemErrorKind: null,
            lastBankTxOn: null,
          };
        }
        return {
          itemErrorCode: found.lastSyncErrorCode ?? null,
          itemErrorKind: found.errorKind ?? null,
          lastBankTxOn: found.lastBankTxOn ?? null,
        };
      } catch {
        return { itemErrorCode: null, itemErrorKind: null, lastBankTxOn: null };
      }
    },
    [],
  );

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
            mostRecentMonth: null,
          });
          return;
        }
        if (totals.added > 0 || totals.modified > 0) {
          // (#402) Resolve the month that contains the freshly-imported
          // rows so the Ready panel can deep-link "View imported
          // transactions" straight to it. The server now reports
          // `lastOccurredOn` per item (max date across rows touched by
          // this sync), and runSync aggregates that into totals — and
          // because we scope the post-link poll to the just-linked
          // itemId, that aggregate IS this item's most recent imported
          // row. As a defensive fallback for an unexpected null, use
          // today's month so the link is always present in Ready.
          const occurredOn = totals.lastOccurredOn;
          const mostRecentMonth =
            occurredOn && occurredOn.length >= 7
              ? `${occurredOn.slice(0, 7)}-01`
              : `${new Date().toISOString().slice(0, 7)}-01`;
          // (#408) Fetch live item state so the panel can suppress a
          // stale Ready pill when the item still needs reconnecting,
          // and so a zero-row heal can render "No new transactions
          // since <date>" instead of an empty "Ready — 0 added".
          const meta = await fetchJustLinkedItemMeta(justLinkedItemId);
          if (cancelledRef.current) return;
          setPostLinkStatus({
            phase: "ready",
            attempt: attemptNumber,
            totalAttempts: POST_LINK_TOTAL_ATTEMPTS,
            institutionName,
            added: totalAdded,
            modified: totalModified,
            errorMessage: null,
            importedDateRange,
            mostRecentMonth,
            itemErrorCode: meta.itemErrorCode,
            itemErrorKind: meta.itemErrorKind,
            lastBankTxOn: meta.lastBankTxOn,
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
          mostRecentMonth: null,
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
        mostRecentMonth: null,
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
            // (#379) Also seed the shared store's retry context so the
            // banner's Retry button knows which item to resync.
            const justLinkedItemIdForRetry =
              (exchangeRes as { id?: string }).id ?? null;
            setPostLinkProgress(
              {
                phase: "preparing",
                attempt: 0,
                totalAttempts: POST_LINK_TOTAL_ATTEMPTS,
                institutionName,
                added: 0,
                modified: 0,
                errorMessage: null,
                importedDateRange: null,
                mostRecentMonth: null,
              },
              {
                itemId: justLinkedItemIdForRetry,
                institutionName,
              },
            );
            setLinkToken(null);
            clearStoredLinkToken();
            // (#804-followup) Restore our own AlertDialog's focus trap
            // (and let the parent picker restore its own via onExitProp,
            // which is wired into handleSdkExit too). The success path
            // doesn't run through usePlaidLink.onExit, so we have to
            // flip both flags here as well.
            setYieldingToPlaid(false);
            onExitPropRef.current?.();
            openedTokenRef.current = null;
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

  // (#804-followup) Stable refs for the parent yield-callbacks. Putting
  // these in the open() effect's dep array would re-run the effect every
  // time the parent re-renders (handlers are recreated each render),
  // which can double-fire open() for a single linkToken — architect
  // review #1 flagged this. Refs let the effect call the latest handler
  // without depending on its identity.
  const onOpenPropRef = useRef(onOpenProp);
  const onExitPropRef = useRef(onExitProp);
  useEffect(() => {
    onOpenPropRef.current = onOpenProp;
    onExitPropRef.current = onExitProp;
  });

  // (#804-followup) Locally tracks whether the Plaid SDK iframe is on
  // screen so our own reauth-guard AlertDialog (rendered below) can
  // flip to non-modal alongside the parent picker. Without this the
  // guard's Radix FocusScope re-introduces the same iframe-uninteractable
  // bug for reconnect flows launched from the guard.
  const [yieldingToPlaid, setYieldingToPlaid] = useState(false);

  // (#804-followup) Dedup ref so a single linkToken never triggers two
  // open() calls — architect review #2.
  const openedTokenRef = useRef<string | null>(null);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setLinkToken(null);
      clearStoredLinkToken();
      openedTokenRef.current = null;
      // (#804-followup) Restore our AlertDialog's focus trap and tell
      // any parent Dialog (e.g. the debt-link picker) to restore its
      // own. Fires for every user-driven dismissal (close, back, error).
      setYieldingToPlaid(false);
      onExitPropRef.current?.();
    },
  });

  useEffect(() => {
    if (!linkToken || !ready) return;
    if (openedTokenRef.current === linkToken) return;
    openedTokenRef.current = linkToken;

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

    // (#804-followup) Architect review #1: make the modality release
    // deterministic. flushSync commits the parent state update (and our
    // local one) synchronously, so Radix's Dialog/AlertDialog re-renders
    // with modal=false and tears down its FocusScope BEFORE we call
    // open(). The RAF then defers open() to the next frame so any
    // useEffect-based Radix cleanup also has a tick to run.
    flushSync(() => {
      setYieldingToPlaid(true);
      onOpenPropRef.current?.();
    });
    requestAnimationFrame(() => open());
  }, [linkToken, ready, open]);

  // (#804-followup) Reconnect button handlers used inside our own
  // reauth-guard AlertDialog. Mirror the same yield-before-open pattern
  // so the guard's nested modal doesn't re-trap focus when the
  // reconnect flow opens Plaid in update mode.
  const handleNestedReconnectOpen = useCallback(() => {
    // (#804-followup) Radix AlertDialog is hard-wired modal=true (no
    // `modal` prop), so we can't just release its FocusScope the way
    // the picker Dialog does. Instead we close the guard entirely the
    // moment the reconnect flow opens Plaid — the user already made
    // their pick by clicking Reconnect, and re-showing the guard
    // afterwards adds no value. flushSync + RAF (in the child's open
    // effect) still ensures Radix tears down before Plaid opens.
    flushSync(() => {
      setYieldingToPlaid(true);
      setReauthGuardOpen(false);
      onOpenPropRef.current?.();
    });
  }, []);
  const handleNestedReconnectExit = useCallback(() => {
    setYieldingToPlaid(false);
    onExitPropRef.current?.();
  }, []);

  const busy =
    createLinkToken.isPending ||
    createAddAccountLinkToken.isPending ||
    exchange.isPending;
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
        disabled={busy || notConfigured || hasConfigError || !itemsFetched}
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
      {inlineProgress !== false && postLinkStatus && (
        <PostLinkProgressPanel
          status={postLinkStatus}
          viewTransactionsPath={viewTransactionsPath}
          onDismiss={clearPostLinkProgress}
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
      <AlertDialog
        open={reauthGuardOpen && !yieldingToPlaid}
        onOpenChange={(v) => setReauthGuardOpen(v)}
      >
        <AlertDialogContent data-testid="dialog-reauth-guard">
          <AlertDialogHeader>
            <AlertDialogTitle>
              You already have a bank that needs reconnecting
            </AlertDialogTitle>
            <AlertDialogDescription>
              Linking a fresh copy of the same bank can leave transactions
              stuck on the broken connection. Reconnect the existing one
              below to bring its history back instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-2 text-sm">
            {itemsNeedingReauth.map((it) => (
              <li
                key={it.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                data-testid={`row-reauth-guard-${it.id}`}
              >
                <span className="font-medium">
                  {it.institutionName ?? "Your bank"}
                </span>
                <PlaidReconnectButton
                  itemId={it.id}
                  institutionName={it.institutionName}
                  onOpen={handleNestedReconnectOpen}
                  onExit={handleNestedReconnectExit}
                />
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-reauth-guard-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={proceedWithFreshLink}
              data-testid="button-reauth-guard-proceed"
            >
              Link a different bank anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  viewTransactionsPath,
  onDismiss,
}: {
  status: PostLinkStatus;
  viewTransactionsPath: string;
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
    mostRecentMonth,
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
    title =
      added === 0 && modified === 0
        ? status.lastBankTxOn
          ? `No new transactions since ${formatYmdShort(status.lastBankTxOn)}`
          : `No new transactions yet`
        : `Ready — ${parts.join(", ")}`;
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

  // (#408) When the linked item still carries an actionable
  // re-auth / malformed-token error on the server, the green "Ready"
  // pill is misleading — the user is reading a yellow reconnect
  // banner that says the opposite. Suppress the green styling and
  // override the title/detail to a neutral warning so the panel
  // can't override the active reconnect CTA.
  const itemNeedsReconnect =
    phase === "ready" &&
    (!!status.itemErrorCode || status.itemErrorKind === "reauth");
  if (itemNeedsReconnect) {
    title = `${bank} still needs reconnecting`;
    detail = `Sign in again to finish syncing ${bank}.`;
  }
  const variant =
    phase === "error" || itemNeedsReconnect
      ? "border-amber-500/40 bg-amber-500/5"
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
          ) : phase === "ready" && !itemNeedsReconnect ? (
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
          {phase === "ready" && !itemNeedsReconnect && mostRecentMonth && (
            <div className="mt-2">
              <Link
                href={`${viewTransactionsPath}?month=${mostRecentMonth}`}
                onClick={onDismiss}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-background px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/10"
                data-testid="link-post-link-view-transactions"
              >
                View imported transactions
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
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
