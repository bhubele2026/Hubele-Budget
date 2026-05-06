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
import { dispatchPlaidReconnect } from "@/components/plaid-reconnect-listener";

/**
 * (#357) Per-item Plaid failure detail surfaced through the sync response.
 * Mirrors the structured fields the server attaches to each item so the
 * toast / inline error can render "<Institution>: <plain English reason>"
 * with a Reconnect CTA for re-auth codes — and never the raw axios
 * "Request failed with status code 400" string.
 */
export type SyncErrorDetail = {
  itemId: string | null;
  // (#357) Row id (`plaid_items.id`) — what /plaid/link-token/update
  // expects when the Reconnect CTA opens Plaid Link in update mode.
  plaidItemRowId: string | null;
  institutionName: string | null;
  message: string;
  code: string | null;
  displayMessage: string | null;
  requestId: string | null;
  httpStatus: number | null;
  kind:
    | "reauth"
    | "rate_limit"
    | "institution_down"
    | "transient"
    | "unknown"
    | null;
};

export type SyncTotals = {
  added: number;
  modified: number;
  removed: number;
  errors: string[];
  // (#357) Structured per-item failures parallel to `errors`. Populated for
  // every item that came back with `error` set — drives the new institution-
  // named toast and Reconnect CTA on re-auth failures.
  errorDetails: SyncErrorDetail[];
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
  errorDetails: [],
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

/**
 * (#357) Compose the user-facing line for a Plaid error: prefer the
 * institution name + Plaid's `display_message` (Plaid's officially
 * recommended user-facing string) and fall back to the raw error_message.
 * Never returns the bare axios "Request failed with status code 400".
 */
export function formatSyncErrorDetail(d: SyncErrorDetail): string {
  const reason =
    (d.displayMessage && d.displayMessage.trim()) ||
    (d.message && d.message.trim()) ||
    "Sync failed";
  const bank = d.institutionName?.trim();
  if (bank) return `${bank}: ${reason}`;
  return formatPlaidErrorForDisplay(reason);
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
                  if (r.error) {
                    acc.errors.push(r.error);
                    acc.errorDetails.push({
                      itemId: r.itemId ?? null,
                      plaidItemRowId: r.plaidItemRowId ?? null,
                      institutionName: r.institutionName ?? null,
                      message: r.plaidErrorMessage ?? r.error,
                      code: r.plaidErrorCode ?? null,
                      displayMessage: r.plaidDisplayMessage ?? null,
                      requestId: r.requestId ?? null,
                      httpStatus: r.httpStatus ?? null,
                      kind:
                        (r.kind as SyncErrorDetail["kind"]) ?? null,
                    });
                  }
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
                  errorDetails: [],
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
                if (totals.errorDetails.length > 0) {
                  // (#357) Compose "<Institution>: <reason>" lines so the
                  // toast names exactly which bank is broken — never the
                  // raw axios message. When at least one error is a
                  // re-auth, attach a Reconnect ToastAction that takes the
                  // user to Settings → Linked banks (the page that lists
                  // the per-item Reconnect buttons).
                  const description = totals.errorDetails
                    .map(formatSyncErrorDetail)
                    .join("; ");
                  const reauthDetail = totals.errorDetails.find(
                    (d) => d.kind === "reauth" && d.plaidItemRowId,
                  );
                  toast({
                    title: "Sync had errors",
                    description,
                    variant: "destructive",
                    // (#357) Reconnect CTA opens Plaid Link in update
                    // mode for the *failing* item — never navigates to
                    // /settings. The PlaidReconnectListener mounted in
                    // App.tsx hears the event and runs the same
                    // PlaidReconnectButton flow inline.
                    action: reauthDetail && reauthDetail.plaidItemRowId ? (
                      <ToastAction
                        altText="Reconnect bank"
                        onClick={() =>
                          dispatchPlaidReconnect({
                            itemId: reauthDetail.plaidItemRowId!,
                            institutionName: reauthDetail.institutionName,
                          })
                        }
                        data-testid="button-toast-plaid-reconnect"
                      >
                        Reconnect
                      </ToastAction>
                    ) : undefined,
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
              // (#357) The mutate-level onError fires when the request
              // never reached the server (network drop, 5xx from our own
              // API, etc). Show a generic, non-scary message rather than
              // axios internals — the user can't act on "Network Error"
              // beyond retrying, which the Sync button already lets them
              // do. Real Plaid errors flow through onSuccess as per-item
              // entries on the response.
              const rawMsg = err instanceof Error ? err.message : String(err);
              const friendlyMsg = "Sync couldn't reach the server. Try again in a moment.";
              if (!silent) {
                toast({
                  title: "Sync failed",
                  description: friendlyMsg,
                  variant: "destructive",
                });
              }
              resolve({ ...ZERO, errors: [rawMsg] });
            },
          },
        );
      });
    },
    [sync, qc, toast, navigate],
  );

  return { runSync, isPending: sync.isPending };
}
