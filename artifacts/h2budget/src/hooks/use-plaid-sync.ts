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
};

const ZERO: SyncTotals = { added: 0, modified: 0, removed: 0, errors: [] };

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
                  return acc;
                },
                { added: 0, modified: 0, removed: 0, errors: [] },
              );
              qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
              if (totals.added + totals.modified + totals.removed > 0) {
                qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
              }
              if (!silent) {
                if (totals.errors.length > 0) {
                  toast({
                    title: "Sync had errors",
                    description: totals.errors.join("; "),
                    variant: "destructive",
                  });
                } else if (totals.added + totals.modified === 0) {
                  // Plaid frequently returns only "removed" entries (or
                  // nothing at all) for a freshly linked item while the
                  // historical batch is still being staged on its end.
                  // Treat zero-new as the still-preparing case so the
                  // toast stays honest about what the user will see.
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
