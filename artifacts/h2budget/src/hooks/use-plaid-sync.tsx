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
import { formatRelativeTimeFromNow } from "@/lib/plaidPreparing";

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
  // (#403) Aggregated min/max occurredOn across every item's
  // `importedDateRange`. Powers the "Imported N transactions from
  // Mar 5 – Apr 28" caption on the post-link panel and lets the panel
  // tell the user when only historical rows came back. Null when no
  // item inserted anything.
  importedDateRange: { min: string; max: string } | null;
  // (#723) Plain-English reason the `/transactions/refresh` path was a
  // no-op on at least one item in this sync (currently only set when
  // the Plaid client lacks the `transactions_refresh` add-on). When
  // present the toast swaps the misleading "your bank is still
  // preparing the initial batch" copy for honest copy that tells the
  // user real-time refresh isn't enabled and that Plaid's ~6 h poll is
  // the only source of new pending data. Null when every item refreshed
  // cleanly or the refresh path wasn't attempted.
  refreshDisabledReason: string | null;
  // (#723) ISO-8601 timestamp of the most recent prior sync among
  // items in this response that surfaced `refreshDisabledReason` —
  // i.e. "when was the data the user is staring at last refreshed
  // by Plaid?" The honest refresh-disabled toast turns this into a
  // relative anchor ("Data is current as of 4h ago") so the user
  // can see at a glance why clicking Sync again right now won't
  // surface anything new. Null when no refresh-disabled item carried
  // a prior sync timestamp (e.g. very first sync after link).
  refreshDisabledAsOf: string | null;
  // (#402) Most recent occurredOn (YYYY-MM-DD) across rows touched by this
  // sync, taken as the max of each item's `lastOccurredOn`. The post-link
  // progress panel uses this — when the caller scoped the sync to a
  // freshly-linked item — to deep-link "View imported transactions" to
  // the exact month containing the new rows for that item, instead of
  // falling back to a global most-recent-transaction lookup that can
  // point at an unrelated charge from another bank.
  lastOccurredOn: string | null;
};

const ZERO: SyncTotals = {
  added: 0,
  modified: 0,
  removed: 0,
  errors: [],
  errorDetails: [],
  stillPreparing: false,
  ruleAttribution: { totalAttributed: 0, top: [], extraRules: 0, ruleIds: [] },
  importedDateRange: null,
  refreshDisabledReason: null,
  refreshDisabledAsOf: null,
  lastOccurredOn: null,
};

// (#723) Honest toast copy when no rows came back AND the server
// surfaced `refreshDisabledReason` on at least one item — i.e. the
// reason "Added 0" is not "your bank is still preparing", it's that
// the live `/transactions/refresh` call was rejected because the
// Plaid client lacks the `transactions_refresh` add-on. Without this,
// the old "Try Sync again in a minute" copy lied to the user every
// click on items like Chase (which only update from Plaid's scheduled
// ~6 h poll) and trained them to keep mashing Sync expecting fresh
// pending data that will never arrive on the next click.
const REFRESH_DISABLED_TITLE = "No new transactions yet";
const REFRESH_DISABLED_MESSAGE =
  "Real-time refresh isn't enabled on this Plaid plan, so new pending charges only appear after Plaid's scheduled poll (every ~6 hours). Clicking Sync again right away won't surface anything new.";

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
              // (#403) Aggregate the per-item importedDateRange so the
              // post-link panel can show the inserted-rows window
              // across every item this sync touched. Skipped when an
              // item didn't insert anything (importedDateRange null).
              let aggMin: string | null = null;
              let aggMax: string | null = null;
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
                  // (#723) First non-empty refreshDisabledReason wins —
                  // the toast only needs a single reason string to swap
                  // to the honest copy; multiple items with the same
                  // disabled add-on all share the same explanation.
                  const itemRefreshDisabled = (
                    r as { refreshDisabledReason?: string | null }
                  ).refreshDisabledReason;
                  if (itemRefreshDisabled && !acc.refreshDisabledReason) {
                    acc.refreshDisabledReason = itemRefreshDisabled;
                  }
                  // (#723) Track the freshest prior sync timestamp
                  // across refresh-disabled items so the toast can
                  // anchor staleness ("Data is current as of 4h
                  // ago"). Only consider items whose refresh path
                  // was actually disabled — items that refreshed
                  // cleanly aren't the ones the user is being
                  // misled about.
                  if (itemRefreshDisabled) {
                    const itemLastSyncedAt = (
                      r as { lastSyncedAt?: string | null }
                    ).lastSyncedAt;
                    if (
                      itemLastSyncedAt &&
                      (!acc.refreshDisabledAsOf ||
                        itemLastSyncedAt > acc.refreshDisabledAsOf)
                    ) {
                      acc.refreshDisabledAsOf = itemLastSyncedAt;
                    }
                  }
                  if (r.importedDateRange) {
                    const { min, max } = r.importedDateRange;
                    if (aggMin === null || min < aggMin) aggMin = min;
                    if (aggMax === null || max > aggMax) aggMax = max;
                  }
                  if (
                    r.lastOccurredOn &&
                    (!acc.lastOccurredOn || r.lastOccurredOn > acc.lastOccurredOn)
                  ) {
                    acc.lastOccurredOn = r.lastOccurredOn;
                  }
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
                  importedDateRange: null,
                  refreshDisabledReason: null,
                  refreshDisabledAsOf: null,
                  lastOccurredOn: null,
                },
              );
              totals.importedDateRange =
                aggMin && aggMax ? { min: aggMin, max: aggMax } : null;
              totals.ruleAttribution = buildRuleAttributionSummary(
                Array.from(aggregatedAttr.values()).sort(
                  (a, b) => b.count - a.count,
                ),
              );
              qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
              if (totals.added + totals.modified + totals.removed > 0) {
                qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
              }
              // (#483) Refresh the Amex ending-balance tile after every
              // Plaid sync so the "Refresh from Plaid" button on the Amex
              // page picks up the freshly-fetched per-account balances
              // without forcing a manual reload. Cheap (single GET) and
              // a no-op for users without an Amex item linked.
              qc.invalidateQueries({ queryKey: ["/api/amex/anchor"] });
              if (!silent) {
                if (items.length === 0) {
                  // (#671 follow-up) Truth-in-toast: when the user's
                  // household has zero linked Plaid items, Sync is a
                  // structural no-op — there is literally nothing to
                  // refresh. The old "still preparing the initial
                  // batch" copy was a lie that made it look like the
                  // app was waiting on Plaid when in fact no item was
                  // ever queried. Tell the user the actual state and
                  // give them a one-click path to fix it.
                  toast({
                    title: "No banks connected",
                    description:
                      "Connect a bank in Settings to start syncing transactions.",
                    action: (
                      <ToastAction
                        altText="Open Settings"
                        onClick={() => navigate("/settings")}
                        data-testid="button-toast-open-settings"
                      >
                        Open Settings
                      </ToastAction>
                    ),
                  });
                } else if (totals.errorDetails.length > 0) {
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
                  // (#723) Truth-in-toast. Before this branch, every
                  // empty sync claimed "your bank is still preparing
                  // the initial batch" — which was a lie on items
                  // whose `/transactions/refresh` came back
                  // INVALID_PRODUCT (transactions_refresh add-on not
                  // enabled). On Chase the user clicked Sync ~40
                  // times in a row chasing pending data Plaid was
                  // never going to surface on the next click. When
                  // the server flagged the refresh path as disabled,
                  // tell the user the real reason instead of
                  // suggesting they retry in a minute.
                  if (totals.refreshDisabledReason) {
                    // (#723) Anchor staleness so the user knows when
                    // the data they're looking at was last refreshed
                    // by Plaid. Without this, the toast tells them
                    // "Plaid polls every ~6h" but never tells them
                    // *how recent* the current numbers are — leaving
                    // them to guess whether to wait 10 minutes or 5
                    // hours before re-trying.
                    const asOfHint = totals.refreshDisabledAsOf
                      ? ` Data is current as of ${formatRelativeTimeFromNow(
                          totals.refreshDisabledAsOf,
                        )}.`
                      : "";
                    toast({
                      title: REFRESH_DISABLED_TITLE,
                      description: `${REFRESH_DISABLED_MESSAGE}${asOfHint}`,
                    });
                  } else {
                    // No PRODUCT_NOT_READY signal but also nothing new —
                    // Plaid is silently in the still-preparing window or
                    // the user is genuinely caught up. Same neutral
                    // message.
                    toast({
                      title: "No new transactions yet",
                      description:
                        "Your bank is still preparing the initial batch. Try Sync again in a minute.",
                    });
                  }
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
                  // (#717) Append the freshest occurredOn of the rows
                  // that actually landed (e.g. "through May 18") so the
                  // user can confirm at a glance whether the sync
                  // caught up to the current week or stopped short on
                  // a historical batch — the exact symptom that left a
                  // healthy Chase item stuck in April for three days
                  // without anyone realizing the toast was telling
                  // half the truth.
                  const throughHint = (() => {
                    const maxDate = totals.importedDateRange?.max;
                    if (!maxDate) return "";
                    const parsed = new Date(`${maxDate}T00:00:00`);
                    if (Number.isNaN(parsed.getTime())) return "";
                    const label = parsed.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    });
                    return ` through ${label}`;
                  })();
                  // (#720) Surface when a previously-stuck bank caught up
                  // via the /transactions/get gap-backfill fallback rather
                  // than the normal cursor sync — the user has been
                  // staring at "Added 0" for days on this exact item, so
                  // the toast should explicitly tell them something
                  // different happened this time.
                  const viaGapBackfill = items.some(
                    (r) =>
                      (r as { deliveryMode?: string }).deliveryMode ===
                      "gap-backfill",
                  );
                  const recoveryHint = viaGapBackfill
                    ? " (via direct fetch)"
                    : "";
                  const description = summary.totalAttributed
                    ? `${parts.join(", ")}${throughHint}${recoveryHint}. Auto-categorized ${summary.totalAttributed} new ${
                        summary.totalAttributed === 1 ? "transaction" : "transactions"
                      }: ${summary.top
                        .map((r) => `${r.count} via '${r.pattern}'`)
                        .join(", ")}${summary.extraRules > 0 ? `, +${summary.extraRules} more` : ""}.`
                    : `${parts.join(", ")}${throughHint}${recoveryHint}.`;
                  toast({
                    title: viaGapBackfill ? "Caught up via direct fetch" : "Sync complete",
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
