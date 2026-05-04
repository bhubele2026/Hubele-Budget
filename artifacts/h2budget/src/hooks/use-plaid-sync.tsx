import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useSyncPlaidTransactions,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  buildRuleAttributionSummary,
  type RuleAttributionSummary,
} from "@/lib/rule-attribution-summary";

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
  // Summary of which mapping_rules auto-categorized newly-added rows across
  // every item in this sync. Aggregated by ruleId so a sync that touches two
  // banks doesn't double-count "STARBUCKS" once per item.
  ruleAttribution: RuleAttributionSummary;
};

const ZERO: SyncTotals = {
  added: 0,
  modified: 0,
  removed: 0,
  errors: [],
  stillPreparing: false,
  ruleAttribution: { totalAttributed: 0, top: [], extraRules: 0, ruleIds: [] },
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
  const [, navigate] = useLocation();

  const runSync = useCallback(
    (opts: RunSyncOptions = {}): Promise<SyncTotals> => {
      const { itemId, silent } = opts;
      return new Promise<SyncTotals>((resolve) => {
        sync.mutate(
          { data: itemId ? { itemId } : {} },
          {
            onSuccess: (res) => {
              const items = res.items ?? [];
              // Aggregate per-rule attribution counts across every item.
              // Two items that both auto-categorized via the same ruleId
              // (e.g. shared "STARBUCKS" rule across two banks) collapse
              // into a single row whose count is the sum.
              const aggregatedAttr = new Map<
                string,
                { ruleId: string; pattern: string; count: number }
              >();
              const totals = items.reduce<SyncTotals>(
                (acc, r) => {
                  acc.added += r.added ?? 0;
                  acc.modified += r.modified ?? 0;
                  acc.removed += r.removed ?? 0;
                  if (r.error) acc.errors.push(r.error);
                  if (r.stillPreparing) acc.stillPreparing = true;
                  for (const a of r.ruleAttributions ?? []) {
                    const existing = aggregatedAttr.get(a.ruleId);
                    if (existing) {
                      existing.count += a.count;
                    } else {
                      aggregatedAttr.set(a.ruleId, {
                        ruleId: a.ruleId,
                        pattern: a.pattern,
                        count: a.count,
                      });
                    }
                  }
                  return acc;
                },
                {
                  added: 0,
                  modified: 0,
                  removed: 0,
                  errors: [],
                  stillPreparing: false,
                  ruleAttribution: ZERO.ruleAttribution,
                },
              );
              totals.ruleAttribution = buildRuleAttributionSummary(
                Array.from(aggregatedAttr.values()).sort(
                  (a, b) => b.count - a.count,
                ),
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
                  // Append the per-rule attribution line and a "View"
                  // ToastAction that deep-links to mapping-rules with the
                  // touched rule ids in `?focus=` so the user can audit
                  // which rules silently grabbed the chunk of new rows.
                  const summary = totals.ruleAttribution;
                  const description = summary.totalAttributed
                    ? `${parts.join(", ")}. Auto-categorized ${summary.totalAttributed} new ${
                        summary.totalAttributed === 1 ? "transaction" : "transactions"
                      }: ${summary.top
                        .map((r) => `${r.count} via '${r.pattern}'`)
                        .join(", ")}${summary.extraRules > 0 ? `, +${summary.extraRules} more` : ""}.`
                    : `${parts.join(", ")}.`;
                  toast({
                    title: "Sync complete",
                    description,
                    action:
                      summary.totalAttributed && summary.ruleIds.length > 0 ? (
                        <ToastAction
                          altText="View matched rules"
                          onClick={() =>
                            navigate(
                              `/mapping-rules?focus=${summary.ruleIds
                                .map((id) => encodeURIComponent(id))
                                .join(",")}`,
                            )
                          }
                          data-testid="button-toast-view-matched-rules"
                        >
                          View
                        </ToastAction>
                      ) : undefined,
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
    [sync, qc, toast, navigate],
  );

  return { runSync, isPending: sync.isPending };
}
