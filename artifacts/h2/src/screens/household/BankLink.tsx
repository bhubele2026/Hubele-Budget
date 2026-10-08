import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDebtPlanQueryKey,
  getListDebtsQueryKey,
  getListPlaidItemsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  getListTransactionsQueryKey,
  listPlaidItems,
  listPlaidLiabilityAccounts,
  useBulkCreateDebtsFromPlaidAccounts,
  useCreatePlaidLinkToken,
  useCreatePlaidUpdateLinkToken,
  useExchangePlaidPublicToken,
  useSyncPlaidTransactions,
  type PlaidItemDetail,
  type PlaidLiabilityAccount,
} from "@workspace/api-client-react";
import { invalidateBankLedger } from "@/data/mutationInvalidation";
import { Button } from "@/kit/Button";
import { Sheet } from "@/kit/Sheet";
import { PLAID_LINK_TOKEN_STORAGE_KEY, PLAID_RETURN_TO_STORAGE_KEY } from "../plaid-oauth/PlaidOAuth";
import {
  POST_LINK_POLL_DELAYS_MS,
  apiMessage,
  isReauthCode,
  itemsNeedingReconnect,
  summarizeSync,
  type PostLinkStatus,
  type SyncSummary,
} from "./words";

/**
 * ⭐ THE BANK LINK FLOW — ported from the classic `plaid-link-button`,
 * `plaid-reconnect-button`, `plaid-reconnect-listener`, `post-link-debt-dialog`
 * and `post-link-progress`, the logic unchanged:
 *
 *   link token → Plaid Link → exchange → liability accounts → "make these
 *   debts?" sheet → a backoff poll that tells the owner the first pull is
 *   healthy. Reconnect is Plaid's update mode; a 409 `relink` answer falls
 *   back to a fresh link.
 *
 * ⚠️ BILLING. Sync is the free cursor pull. The one billable pull the flow
 * makes on its own is the first sync after a link or a reconnect (`force`),
 * as in classic, so the first list is not empty. Everything else billable is
 * behind an explicit confirm in `Household.tsx`.
 */

export const RECONNECT_EVENT = "plaid:reconnect";

type Mode = "new" | "update" | "fresh";
interface Job {
  token: string;
  mode: Mode;
  itemId: string | null;
  bank: string | null;
}

/** The one place a sync is sent: free unless `force` is passed. */
export function usePlaidSync() {
  const qc = useQueryClient();
  const sync = useSyncPlaidTransactions();
  const runSync = useCallback(
    async (opts: { itemId?: string | null; force?: boolean } = {}): Promise<SyncSummary> => {
      try {
        const res = await sync.mutateAsync({
          data: { ...(opts.itemId ? { itemId: opts.itemId } : {}), ...(opts.force ? { force: true } : {}) },
        });
        return summarizeSync(res);
      } catch (e) {
        const s = summarizeSync(undefined);
        s.errors.push(apiMessage(e, "The sync did not work. Try again."));
        return s;
      } finally {
        void qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
        void qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        void invalidateBankLedger(qc);
      }
    },
    [qc, sync],
  );
  return { runSync, isPending: sync.isPending };
}

/** Mounted only while a link token exists; opens Plaid Link once and goes away on exit. */
function PlaidOpener({
  job,
  onSuccess,
  onExit,
}: {
  job: Job;
  onSuccess: (job: Job, publicToken: string, institution: { id: string | null; name: string | null }) => void;
  onExit: () => void;
}) {
  const opened = useRef(false);
  const { open, ready } = usePlaidLink({
    token: job.token,
    onSuccess: (publicToken, metadata) =>
      onSuccess(job, publicToken, {
        id: metadata?.institution?.institution_id ?? null,
        name: metadata?.institution?.name ?? null,
      }),
    onExit,
  });
  useEffect(() => {
    if (!ready || opened.current) return;
    opened.current = true;
    // Plaid's redirect page (/plaid-oauth) finishes a link from these two keys.
    try {
      localStorage.setItem(PLAID_LINK_TOKEN_STORAGE_KEY, job.token);
      localStorage.setItem(PLAID_RETURN_TO_STORAGE_KEY, window.location.pathname + window.location.search);
    } catch {
      // storage can be off; non-OAuth banks still work
    }
    open();
  }, [ready, open, job.token]);
  return null;
}

function clearStored() {
  try {
    localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY);
    localStorage.removeItem(PLAID_RETURN_TO_STORAGE_KEY);
  } catch {
    // ignore
  }
}

const accountName = (a: PlaidLiabilityAccount) => a.suggestedDebt?.name?.trim() || a.name || a.officialName || "Account";

/** "Make these debts?" — names and masks only; no balance is shown. */
function DebtsSheet({
  accounts,
  onClose,
  say,
}: {
  accounts: PlaidLiabilityAccount[];
  onClose: () => void;
  say: (text: string, kind?: "ok" | "error") => void;
}) {
  const qc = useQueryClient();
  const bulk = useBulkCreateDebtsFromPlaidAccounts();
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(accounts.map((a) => [a.accountId, true])));
  const chosen = accounts.filter((a) => picked[a.accountId]);
  const add = async () => {
    if (chosen.length === 0) return onClose();
    try {
      const res = await bulk.mutateAsync({ data: { accounts: chosen.map((a) => ({ plaidAccountId: a.accountId })) } });
      void qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetDebtPlanQueryKey() });
      void qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
      const made = res.results.filter((r) => r.status === "created").length;
      const linked = res.results.filter((r) => r.status === "linked-existing").length;
      const failed = res.results.filter((r) => r.status === "error" || r.status === "not-found").length;
      const parts = [made > 0 ? `Added ${made}` : null, linked > 0 ? `linked ${linked} you already had` : null].filter(Boolean);
      say(`${parts.length > 0 ? parts.join(", ") : "No new debts were added"}${failed > 0 ? `. ${failed} could not be added.` : "."}`, failed > 0 ? "error" : "ok");
      onClose();
    } catch (e) {
      say(apiMessage(e, "Couldn't add those debts. Try again."), "error");
    }
  };
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Make these debts?" description="Cards and loans from the bank you just linked. Add the ones you want in your payoff plan.">
      <div className="flex flex-col gap-4" data-testid="debts-sheet">
        <ul className="flex flex-col">
          {accounts.map((a) => (
            <li key={a.accountId} className="border-t border-rule first:border-t-0">
              <label className="flex cursor-pointer items-start gap-3 py-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--color-moss)]"
                  checked={!!picked[a.accountId]}
                  onChange={(e) => setPicked((p) => ({ ...p, [a.accountId]: e.target.checked }))}
                  data-testid={`debt-pick-${a.accountId}`}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="type-body text-ink">{accountName(a)}</span>
                  <span className="type-caption text-ink-3">{[a.mask ? `ending ${a.mask}` : null, a.subtype ?? a.type].filter(Boolean).join(" · ")}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={add} disabled={bulk.isPending} data-testid="debts-add">
            {chosen.length === 0 ? "Skip" : `Add ${chosen.length} ${chosen.length === 1 ? "debt" : "debts"}`}
          </Button>
          <Button variant="quiet" onClick={onClose} data-testid="debts-skip">
            Not now
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** "A bank needs reconnecting" before a second link is started. */
function GuardSheet({
  items,
  onReconnect,
  onLinkAnyway,
  onClose,
}: {
  items: PlaidItemDetail[];
  onReconnect: (item: PlaidItemDetail) => void;
  onLinkAnyway: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="A bank here needs reconnecting"
      description="Linking a second copy of the same bank can leave transactions stuck on the broken one. Reconnect it to bring its history back."
    >
      <div className="flex flex-col gap-4" data-testid="reauth-guard">
        <ul className="flex flex-col">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 border-t border-rule py-3 first:border-t-0">
              <span className="type-body text-ink">{it.institutionName ?? "Your bank"}</span>
              <Button size="sm" variant="primary" onClick={() => onReconnect(it)} data-testid={`guard-reconnect-${it.id}`}>
                Reconnect
              </Button>
            </li>
          ))}
        </ul>
        <Button variant="quiet" onClick={onLinkAnyway} data-testid="guard-link-anyway">
          Link a different bank anyway
        </Button>
      </div>
    </Sheet>
  );
}

export interface BankLink {
  /** Start a fresh link ("Connect a bank"); asks first when a bank needs reconnecting. */
  start: () => void;
  reconnect: (item: { id: string; institutionName?: string | null }) => void;
  busy: boolean;
  progress: PostLinkStatus | null;
  dismissProgress: () => void;
  overlays: ReactNode;
}

export function useBankLink({
  items,
  itemsFetched,
  runSync,
  say,
  pollDelays = POST_LINK_POLL_DELAYS_MS,
}: {
  items: readonly PlaidItemDetail[] | undefined;
  itemsFetched: boolean;
  runSync: (opts?: { itemId?: string | null; force?: boolean }) => Promise<SyncSummary>;
  say: (text: string, kind?: "ok" | "error") => void;
  pollDelays?: readonly number[];
}): BankLink {
  const qc = useQueryClient();
  const createToken = useCreatePlaidLinkToken();
  const createUpdateToken = useCreatePlaidUpdateLinkToken();
  const exchange = useExchangePlaidPublicToken();
  const [job, setJob] = useState<Job | null>(null);
  const [guard, setGuard] = useState(false);
  const [candidates, setCandidates] = useState<PlaidLiabilityAccount[]>([]);
  const [progress, setProgress] = useState<PostLinkStatus | null>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const needing = itemsNeedingReconnect(items);

  const freshToken = useCallback(
    async (mode: Mode, itemId: string | null, bank: string | null) => {
      try {
        const t = await createToken.mutateAsync(undefined);
        setJob({ token: t.linkToken, mode, itemId, bank });
      } catch (e) {
        say(apiMessage(e, "Couldn't start the bank link. Try again."), "error");
      }
    },
    [createToken, say],
  );

  const start = useCallback(() => {
    if (needing.length > 0) {
      setGuard(true);
      return;
    }
    void freshToken("new", null, null);
  }, [needing.length, freshToken]);

  const reconnect = useCallback(
    async (item: { id: string; institutionName?: string | null }) => {
      setGuard(false);
      const bank = item.institutionName ?? null;
      try {
        const t = await createUpdateToken.mutateAsync({ data: { itemId: item.id } });
        setJob({ token: t.linkToken, mode: "update", itemId: item.id, bank });
      } catch (e) {
        const err = e as { status?: number; data?: { action?: string } };
        if (err?.status === 409 && err?.data?.action === "relink") {
          void freshToken("fresh", item.id, bank);
          return;
        }
        say(apiMessage(e, "Couldn't start the reconnect. Try again."), "error");
      }
    },
    [createUpdateToken, freshToken, say],
  );

  // The classic app's "plaid:reconnect" event, kept so any caller can ask for a reconnect.
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ itemId?: string; institutionName?: string | null }>).detail;
      if (d?.itemId) void reconnectRef.current({ id: d.itemId, institutionName: d.institutionName ?? null });
    };
    window.addEventListener(RECONNECT_EVENT, on);
    return () => window.removeEventListener(RECONNECT_EVENT, on);
  }, []);

  const pollAfterLink = useCallback(
    async (itemId: string | null, bank: string) => {
      const total = pollDelays.length;
      let added = 0;
      let modified = 0;
      let lastErrors: string[] = [];
      for (let i = 0; i < total; i++) {
        await new Promise((r) => setTimeout(r, pollDelays[i]));
        if (cancelled.current) return;
        const s = await runSync({ itemId, force: true });
        if (cancelled.current) return;
        added += s.added;
        modified += s.modified;
        lastErrors = s.errors;
        const base = { attempt: i + 1, total, bank, added, modified, needsReconnect: false };
        if (s.errors.length > 0) {
          setProgress({ ...base, phase: "error", error: s.errors.join(" ") });
          return;
        }
        if (s.added > 0 || s.modified > 0) {
          let reauth = false;
          try {
            const live = await listPlaidItems();
            const me = live.find((it) => it.id === itemId);
            reauth = !!me && (isReauthCode(me.lastSyncErrorCode) || me.errorKind === "reauth");
          } catch {
            // best effort: the panel falls back to its plain words
          }
          if (cancelled.current) return;
          setProgress({ ...base, phase: "ready", error: null, needsReconnect: reauth });
          void qc.refetchQueries({ queryKey: getListPlaidItemsQueryKey() });
          return;
        }
        setProgress({ ...base, phase: "polling", error: null });
      }
      if (cancelled.current) return;
      setProgress({ phase: "still-preparing", attempt: total, total, bank, added, modified, error: lastErrors.length ? lastErrors.join(" ") : null, needsReconnect: false });
    },
    [pollDelays, runSync, qc],
  );

  const onSuccess = useCallback(
    async (j: Job, publicToken: string, institution: { id: string | null; name: string | null }) => {
      setJob(null);
      clearStored();
      const bank = institution.name ?? j.bank ?? "your bank";
      if (j.mode === "update") {
        say(`${bank} reconnected. Refreshing its transactions.`);
        const s = await runSync({ itemId: j.itemId, force: true });
        void qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
        if (s.errors.length > 0) {
          if (s.reauth) return void freshToken("fresh", j.itemId, bank);
          say(`Reconnected, but the sync is still failing. ${s.errors.join(" ")}`, "error");
        }
        return;
      }
      try {
        const item = await exchange.mutateAsync({ data: { publicToken, institutionId: institution.id, institutionName: institution.name } });
        void qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
        void qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        let liabilities: PlaidLiabilityAccount[] = [];
        try {
          liabilities = await listPlaidLiabilityAccounts({ refresh: true });
        } catch {
          // the invalidation below retries without a refresh
        }
        void qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
        if (cancelled.current) return;
        setProgress({ phase: "preparing", attempt: 0, total: pollDelays.length, bank, added: 0, modified: 0, error: null, needsReconnect: false });
        const found = liabilities.filter((a) => !a.linkedDebt && a.suggestedDebt && (item.id ? a.itemId === item.id : true));
        if (found.length > 0) setCandidates(found);
        void pollAfterLink(item.id, bank);
      } catch (e) {
        say(apiMessage(e, "The link did not finish. Try again."), "error");
      }
    },
    [exchange, qc, say, runSync, freshToken, pollAfterLink, pollDelays.length],
  );

  const overlays = (
    <>
      {job && <PlaidOpener key={job.token} job={job} onSuccess={onSuccess} onExit={() => { setJob(null); clearStored(); }} />}
      {guard && (
        <GuardSheet
          items={needing}
          onClose={() => setGuard(false)}
          onReconnect={(it) => void reconnect(it)}
          onLinkAnyway={() => {
            setGuard(false);
            void freshToken("new", null, null);
          }}
        />
      )}
      {candidates.length > 0 && <DebtsSheet accounts={candidates} onClose={() => setCandidates([])} say={say} />}
    </>
  );

  return {
    start,
    reconnect: (item) => void reconnect(item),
    busy: createToken.isPending || createUpdateToken.isPending || exchange.isPending,
    progress,
    dismissProgress: () => setProgress(null),
    overlays,
  };
}

