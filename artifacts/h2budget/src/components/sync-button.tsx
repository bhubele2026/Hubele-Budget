import { useMemo } from "react";
import { useListPlaidItems } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { usePlaidSync, formatPlaidErrorForDisplay } from "@/hooks/use-plaid-sync";
import {
  PlaidReconnectButton,
  isPlaidReauthCode,
} from "@/components/plaid-reconnect-button";

export function SyncButton({
  size = "sm",
  variant = "outline",
}: {
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "secondary" | "destructive" | "link";
}) {
  const { data: plaidItems } = useListPlaidItems();
  const { runSync, isPending } = usePlaidSync();

  const { mostRecent, hasItems, latestError, reauthItem } = useMemo(() => {
    const items = plaidItems ?? [];
    if (items.length === 0) {
      return {
        mostRecent: null as Date | null,
        hasItems: false,
        latestError: null as string | null,
        reauthItem: null as
          | { id: string; institutionName: string | null }
          | null,
      };
    }
    let recent: Date | null = null;
    let recentForError: Date | null = null;
    let latest: string | null = null;
    // Pick the first item that needs re-authentication so we can render a
    // single Reconnect button next to the chip. (Multi-item users with two
    // simultaneously-broken banks are extremely rare; one button is fine
    // and the second will surface on the next sync after the first is fixed.)
    let reauth: { id: string; institutionName: string | null } | null = null;
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
      if (!reauth && isPlaidReauthCode(it.lastSyncErrorCode)) {
        reauth = { id: it.id, institutionName: it.institutionName ?? null };
      }
    }
    return { mostRecent: recent, hasItems: true, latestError: latest, reauthItem: reauth };
  }, [plaidItems]);

  if (!hasItems) return null;

  const relative = mostRecent
    ? `Last synced ${formatDistanceToNowStrict(mostRecent, { addSuffix: true })}`
    : "Not yet synced";

  // Plaid errors are persisted on the server as the raw `error_message`
  // returned by Plaid. Prefix with "Plaid: " here so the chip / tooltip make
  // it obvious where the message came from.
  const displayError = latestError ? formatPlaidErrorForDisplay(latestError) : null;

  return (
    <div className="flex flex-col items-end leading-tight">
      <div className="flex items-center gap-1.5">
        {reauthItem ? (
          <PlaidReconnectButton
            itemId={reauthItem.id}
            institutionName={reauthItem.institutionName}
            size={size}
          />
        ) : null}
        <Button
          type="button"
          variant={variant}
          size={size}
          onClick={() => {
            void runSync();
          }}
          disabled={isPending}
          title={displayError ?? relative}
          data-testid="button-sync-plaid"
        >
          <RefreshCw className={`w-4 h-4 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
          {isPending ? "Syncing…" : "Sync"}
        </Button>
      </div>
      <span className="text-[10px] text-muted-foreground mt-1">{relative}</span>
      {displayError ? (
        <span
          className="text-[10px] text-destructive mt-0.5 flex items-center gap-1 max-w-[220px] truncate"
          title={displayError}
          data-testid="text-sync-error"
        >
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="truncate">{displayError}</span>
        </span>
      ) : null}
    </div>
  );
}
