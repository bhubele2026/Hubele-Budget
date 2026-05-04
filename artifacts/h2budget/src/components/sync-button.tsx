import { useMemo } from "react";
import { useListPlaidItems } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { usePlaidSync } from "@/hooks/use-plaid-sync";

export function SyncButton({
  size = "sm",
  variant = "outline",
}: {
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "secondary" | "destructive" | "link";
}) {
  const { data: plaidItems } = useListPlaidItems();
  const { runSync, isPending } = usePlaidSync();

  const { mostRecent, hasItems, latestError } = useMemo(() => {
    const items = plaidItems ?? [];
    if (items.length === 0) {
      return { mostRecent: null as Date | null, hasItems: false, latestError: null as string | null };
    }
    let recent: Date | null = null;
    let recentForError: Date | null = null;
    let latest: string | null = null;
    for (const it of items) {
      if (it.lastSyncedAt) {
        const d = new Date(it.lastSyncedAt);
        if (!Number.isNaN(d.getTime()) && (!recent || d > recent)) recent = d;
      }
      if (it.lastSyncError) {
        // Prefer the freshest error; fall back to first one we see.
        const stamp = it.lastSyncedAt ? new Date(it.lastSyncedAt) : null;
        if (!latest || (stamp && (!recentForError || stamp > recentForError))) {
          latest = it.lastSyncError;
          if (stamp) recentForError = stamp;
        }
      }
    }
    return { mostRecent: recent, hasItems: true, latestError: latest };
  }, [plaidItems]);

  if (!hasItems) return null;

  const relative = mostRecent
    ? `Last synced ${formatDistanceToNowStrict(mostRecent, { addSuffix: true })}`
    : "Not yet synced";

  return (
    <div className="flex flex-col items-end leading-tight">
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => {
          void runSync();
        }}
        disabled={isPending}
        title={latestError ?? relative}
        data-testid="button-sync-plaid"
      >
        <RefreshCw className={`w-4 h-4 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
        {isPending ? "Syncing…" : "Sync"}
      </Button>
      <span className="text-[10px] text-muted-foreground mt-1">{relative}</span>
      {latestError ? (
        <span
          className="text-[10px] text-destructive mt-0.5 flex items-center gap-1 max-w-[220px] truncate"
          title={latestError}
          data-testid="text-sync-error"
        >
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="truncate">{latestError}</span>
        </span>
      ) : null}
    </div>
  );
}
