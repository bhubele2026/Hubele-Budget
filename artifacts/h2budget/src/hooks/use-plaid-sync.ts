import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSyncPlaidTransactions,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export type SyncTotals = {
  added: number;
  modified: number;
  removed: number;
  errors: string[];
  // True when at least one item came back with the transient
  // PRODUCT_NOT_READY signal — Plaid is still staging the historical batch
  // for a freshly linked item. The UI treats this as a neutral, encouraging
  // state rather than a destructive error.
  stillPreparing: boolean;
};

const ZERO: SyncTotals = {
  added: 0,
  modified: 0,
  removed: 0,
  errors: [],
  stillPreparing: false,
};

const STILL_PREPARING_MESSAGE =
  "Your bank is still preparing the initial batch — try Sync again in a minute.";

// Plaid errors stored on the server are the raw `error_message` returned
// by Plaid. Prefix with "Plaid: " in the UI so the user can see at a glance
// where the message came from. (Avoid double-prefixing if the server has
// already done it for some reason.)
export function formatPlaidErrorForDisplay(msg: string): string {
  if (!msg) return msg;
  return msg.startsWith("Plaid:") ? msg : `Plaid: ${msg}`;
}

export type RunSyncOptions = {
  itemId?: string;
  silent?: boolean;
};

export function usePlaidSync() {
  const sync = useSyncPlaidTransactions();
  const qc = useQueryClient();
  const { toast } = useToast();

  const runSync = useCallback(
    (opts: RunSyncOptions = {}): Promise<SyncTotals> => {
      const { itemId, silent } = opts;
      return new Promise<SyncTotals>((resolve) => {
        sync.mutate(
          { data: itemId ? { itemId } : {} },
          {
            onSuccess: (res) => {
              const items = res.items ?? [];
              const totals = items.reduce<SyncTotals>(
                (acc, r) => {
                  acc.added += r.added ?? 0;
                  acc.modified += r.modified ?? 0;
                  acc.removed += r.removed ?? 0;
                  if (r.error) acc.errors.push(r.error);
                  if (r.stillPreparing) acc.stillPreparing = true;
                  return acc;
                },
                {
                  added: 0,
                  modified: 0,
                  removed: 0,
                  errors: [],
                  stillPreparing: false,
                },
              );
              qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
              if (totals.added + totals.modified + totals.removed > 0) {
                qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
              }
              if (!silent) {
                if (totals.errors.length > 0) {
                  toast({
                    title: "Sync had errors",
                    description: totals.errors
                      .map(formatPlaidErrorForDisplay)
                      .join("; "),
                    variant: "destructive",
                  });
                } else if (totals.stillPreparing) {
                  // Plaid told us PRODUCT_NOT_READY — the bank hasn't
                  // finished staging the historical batch yet. Show a
                  // neutral, encouraging toast (NOT destructive) so the
                  // user knows what's happening.
                  toast({
                    title: "Still preparing",
                    description: STILL_PREPARING_MESSAGE,
                  });
                } else if (totals.added + totals.modified === 0) {
                  // No PRODUCT_NOT_READY signal but also nothing new —
                  // Plaid is silently in the still-preparing window or the
                  // user is genuinely caught up. Same neutral message.
                  toast({
                    title: "No new transactions yet",
                    description:
                      "Your bank is still preparing the initial batch. Try Sync again in a minute.",
                  });
                } else {
                  const parts: string[] = [];
                  if (totals.added > 0) parts.push(`Added ${totals.added}`);
                  if (totals.modified > 0) parts.push(`updated ${totals.modified}`);
                  if (totals.removed > 0) parts.push(`removed ${totals.removed}`);
                  toast({
                    title: "Sync complete",
                    description: `${parts.join(", ")}.`,
                  });
                }
              }
              resolve(totals);
            },
            onError: (err) => {
              const msg = err instanceof Error ? err.message : String(err);
              if (!silent) {
                toast({
                  title: "Sync failed",
                  description: msg,
                  variant: "destructive",
                });
              }
              resolve({ ...ZERO, errors: [msg] });
            },
          },
        );
      });
    },
    [sync, qc, toast],
  );

  return { runSync, isPending: sync.isPending };
}
