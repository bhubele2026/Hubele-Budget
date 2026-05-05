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
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown } from "lucide-react";

type SortKey = "attemptedAt" | "kind" | "success";
type SortDir = "asc" | "desc";

function kindLabel(k: string): string {
  if (k === "transactions") return "Transactions";
  if (k === "balance") return "Balance";
  if (k === "liabilities") return "Liabilities";
  return k;
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

export function PlaidSyncHistory({ itemId }: { itemId: string }) {
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
                      {a.success ? (
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
                      title={a.errorMessage ?? undefined}
                    >
                      {a.errorMessage ? (
                        <span className="line-clamp-1">{a.errorMessage}</span>
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
