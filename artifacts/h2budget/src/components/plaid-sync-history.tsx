import { useMemo, useState } from "react";
import {
  useListPlaidSyncAttempts,
  getListPlaidSyncAttemptsQueryKey,
  type PlaidSyncAttempt,
} from "@workspace/api-client-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown, Link2, Copy, Check } from "lucide-react";
import { dispatchPlaidReconnect } from "@/components/plaid-reconnect-listener";
import { useToast } from "@/hooks/use-toast";

function CopyRequestIdButton({
  attemptId,
  requestId,
}: {
  attemptId: string;
  requestId: string;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(requestId);
      setCopied(true);
      toast({ title: "Request id copied" });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy request id", variant: "destructive" });
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-0.5 ml-1 px-1 py-0.5 rounded hover:bg-muted text-muted-foreground/80 hover:text-foreground"
      data-testid={`sync-attempt-copy-request-id-${attemptId}`}
      aria-label="Copy request id"
      title="Copy request id"
    >
      {copied ? (
        <>
          <Check className="w-3 h-3" />
          <span className="text-[10px]">Copied</span>
        </>
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  );
}

type SortKey = "attemptedAt" | "kind" | "success";
type SortDir = "asc" | "desc";

function kindLabel(k: string): string {
  if (k === "transactions") return "Transactions";
  if (k === "balance") return "Balance";
  if (k === "liabilities") return "Liabilities";
  if (k === "pending_cleanup") return "Pending cleanup";
  return k;
}

// (#733) Inline expander for the per-deletion detail view on a
// kind="pending_cleanup" Recent activity row. Quiet by default — the
// row only shows the one-line summary; clicking "View details" opens
// the table of dropped pre-auths (description, amount, date, plaid
// transaction id) for power users who want to audit exactly what was
// swept.
function PendingCleanupDetail({
  attemptId,
  summary,
  details,
}: {
  attemptId: string;
  summary: string | null;
  details: NonNullable<PlaidSyncAttempt["cleanupDetails"]>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="flex flex-col gap-1"
      data-testid={`sync-attempt-cleanup-${attemptId}`}
    >
      <span
        className="line-clamp-2"
        data-testid={`sync-attempt-cleanup-summary-${attemptId}`}
      >
        {summary ?? `Cleared ${details.count} dropped pending charges.`}
      </span>
      <button
        type="button"
        className="inline-flex items-center gap-0.5 self-start text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => setOpen((v) => !v)}
        data-testid={`sync-attempt-cleanup-toggle-${attemptId}`}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        {open ? "Hide details" : "View details"}
      </button>
      {open && (
        <div
          className="mt-1 rounded border border-border/60 bg-muted/30 overflow-hidden"
          data-testid={`sync-attempt-cleanup-details-${attemptId}`}
        >
          <table className="w-full text-[11px]">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-2 py-1">Date</th>
                <th className="text-left font-medium px-2 py-1">Description</th>
                <th className="text-right font-medium px-2 py-1">Amount</th>
                <th className="text-left font-medium px-2 py-1">Plaid id</th>
              </tr>
            </thead>
            <tbody>
              {details.items.map((it, i) => (
                <tr
                  key={`${it.plaidTransactionId}-${i}`}
                  className="border-t border-border/60"
                  data-testid={`sync-attempt-cleanup-item-${attemptId}-${i}`}
                >
                  <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                    {it.occurredOn}
                  </td>
                  <td className="px-2 py-1">{it.description ?? "—"}</td>
                  <td className="px-2 py-1 text-right whitespace-nowrap font-mono">
                    {it.amount}
                  </td>
                  <td className="px-2 py-1 font-mono text-muted-foreground/80 break-all">
                    {it.plaidTransactionId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function compareAttempts(
  a: PlaidSyncAttempt,
  b: PlaidSyncAttempt,
  key: SortKey,
  dir: SortDir,
): number {
  let cmp = 0;
  if (key === "attemptedAt") {
    cmp =
      new Date(a.attemptedAt).getTime() - new Date(b.attemptedAt).getTime();
  } else if (key === "kind") {
    cmp = a.kind.localeCompare(b.kind);
  } else if (key === "success") {
    // Failures first when ascending so the user sees the actionable rows.
    cmp = Number(a.success) - Number(b.success);
  }
  return dir === "asc" ? cmp : -cmp;
}

export function PlaidSyncHistory({
  itemId,
  institutionName,
}: {
  itemId: string;
  institutionName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("attemptedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Only hit the endpoint once the user opens the expander — keeps the
  // Settings page snappy when many banks are linked.
  const { data, isLoading, isError } = useListPlaidSyncAttempts(itemId, {
    query: {
      queryKey: getListPlaidSyncAttemptsQueryKey(itemId),
      enabled: open,
    },
  });

  const attempts = data?.attempts ?? [];
  const sorted = useMemo(
    () => [...attempts].sort((a, b) => compareAttempts(a, b, sortKey, sortDir)),
    [attempts, sortKey, sortDir],
  );

  const failureSummary = useMemo(() => {
    if (attempts.length === 0) return null;
    const failed = attempts.filter((a) => !a.success).length;
    return `Failed ${failed} of the last ${attempts.length}`;
  }, [attempts]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible default direction: time→newest first, others→ascending.
      setSortDir(key === "attemptedAt" ? "desc" : "asc");
    }
  };

  const sortIcon = (key: SortKey) => {
    if (key !== sortKey) return null;
    return sortDir === "asc" ? (
      <ArrowUp className="inline w-3 h-3 ml-0.5" />
    ) : (
      <ArrowDown className="inline w-3 h-3 ml-0.5" />
    );
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto py-1 px-2 -ml-2 text-xs text-muted-foreground"
          data-testid={`button-toggle-sync-history-${itemId}`}
        >
          {open ? (
            <ChevronDown className="w-3.5 h-3.5 mr-1" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 mr-1" />
          )}
          Recent activity
          {failureSummary && open && (
            <span className="ml-2 text-muted-foreground/80">
              · {failureSummary}
            </span>
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className="mt-2 ml-4 rounded-md border border-border bg-background/60 overflow-hidden"
          data-testid={`sync-history-${itemId}`}
        >
          {isLoading && (
            <div className="text-xs text-muted-foreground p-3">Loading…</div>
          )}
          {isError && (
            <div
              className="text-xs text-destructive p-3"
              data-testid={`sync-history-error-${itemId}`}
            >
              Couldn't load recent activity.
            </div>
          )}
          {!isLoading && !isError && sorted.length === 0 && (
            <div
              className="text-xs text-muted-foreground p-3"
              data-testid={`sync-history-empty-${itemId}`}
            >
              No sync attempts recorded yet.
            </div>
          )}
          {!isLoading && !isError && sorted.length > 0 && (
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => toggleSort("attemptedAt")}
                      className="hover:underline"
                      data-testid={`sort-time-${itemId}`}
                    >
                      When{sortIcon("attemptedAt")}
                    </button>
                  </th>
                  <th className="text-left font-medium px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => toggleSort("kind")}
                      className="hover:underline"
                      data-testid={`sort-kind-${itemId}`}
                    >
                      Kind{sortIcon("kind")}
                    </button>
                  </th>
                  <th className="text-left font-medium px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => toggleSort("success")}
                      className="hover:underline"
                      data-testid={`sort-status-${itemId}`}
                    >
                      Status{sortIcon("success")}
                    </button>
                  </th>
                  <th className="text-left font-medium px-2 py-1.5">Detail</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t border-border/60"
                    data-testid={`sync-attempt-row-${a.id}`}
                  >
                    <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                      {new Date(a.attemptedAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5">{kindLabel(a.kind)}</td>
                    <td className="px-2 py-1.5">
                      {a.kind === "pending_cleanup" ? (
                        <span
                          className="text-muted-foreground"
                          data-testid={`sync-attempt-cleanup-status-${a.id}`}
                        >
                          Tidied up
                        </span>
                      ) : a.success ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          OK
                        </span>
                      ) : (
                        <span
                          className="text-destructive"
                          data-testid={`sync-attempt-failed-${a.id}`}
                        >
                          Failed
                          {a.errorCode ? ` · ${a.errorCode}` : ""}
                        </span>
                      )}
                    </td>
                    <td
                      className="px-2 py-1.5 text-muted-foreground"
                      title={
                        a.plaidDisplayMessage ?? a.errorMessage ?? undefined
                      }
                    >
                      {/* (#733) Vanished-pending sweep audit row gets
                          its own renderer: a one-line summary plus an
                          inline "View details" expander listing each
                          dropped pre-auth. */}
                      {a.kind === "pending_cleanup" && a.cleanupDetails ? (
                        <PendingCleanupDetail
                          attemptId={a.id}
                          summary={a.errorMessage ?? null}
                          details={a.cleanupDetails}
                        />
                      ) : /* (#357) Prefer Plaid's `display_message` (the
                          plain-English string Plaid recommends showing
                          end-users), then fall back to error_message. */
                      a.plaidDisplayMessage || a.errorMessage ? (
                        <div className="flex flex-col gap-1">
                          <span
                            className="line-clamp-2"
                            data-testid={`sync-attempt-detail-${a.id}`}
                          >
                            {a.plaidDisplayMessage || a.errorMessage}
                          </span>
                          {(a.requestId || a.httpStatus !== null) && (
                            <span
                              className="text-[10px] text-muted-foreground/70 font-mono"
                              data-testid={`sync-attempt-meta-${a.id}`}
                            >
                              {a.httpStatus !== null && a.httpStatus !== undefined
                                ? `HTTP ${a.httpStatus}`
                                : ""}
                              {a.httpStatus !== null &&
                              a.httpStatus !== undefined &&
                              a.requestId
                                ? " · "
                                : ""}
                              {a.requestId ? (
                                <>
                                  {`Request id: ${a.requestId}`}
                                  <CopyRequestIdButton
                                    attemptId={a.id}
                                    requestId={a.requestId}
                                  />
                                </>
                              ) : (
                                ""
                              )}
                            </span>
                          )}
                          {a.errorKind === "reauth" && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px] self-start"
                              onClick={() =>
                                dispatchPlaidReconnect({
                                  itemId,
                                  institutionName,
                                })
                              }
                              data-testid={`sync-attempt-reconnect-${a.id}`}
                            >
                              <Link2 className="w-3 h-3 mr-1" />
                              Reconnect
                            </Button>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
