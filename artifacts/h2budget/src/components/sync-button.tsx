import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListPlaidItems,
  type PlaidItemDetail,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RefreshCw, AlertTriangle, Link2 } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { usePlaidSync, formatPlaidErrorForDisplay } from "@/hooks/use-plaid-sync";
import { PlaidReconnectButton } from "@/components/plaid-reconnect-button";
import { findPlaidItemsNeedingReauth } from "@/components/plaid-reauth-banner";

export function SyncButton({
  size = "sm",
  variant = "outline",
}: {
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "secondary" | "destructive" | "link";
}) {
  const { data: plaidItems } = useListPlaidItems();
  const { runSync, isPending } = usePlaidSync();

  const { mostRecent, hasItems, latestError, reauthItems } = useMemo(() => {
    const items = plaidItems ?? [];
    // (#214) Compute the *full* set of items that need re-authentication so the
    // header chip's popover can list every broken bank, not just the first one
    // we happened to iterate to. Power users with two simultaneously-broken
    // banks now get a per-item Reconnect button for each, all from one place.
    const { items: reauth } = findPlaidItemsNeedingReauth(items);
    if (items.length === 0) {
      return {
        mostRecent: null as Date | null,
        hasItems: false,
        latestError: null as string | null,
        reauthItems: reauth,
      };
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
    return {
      mostRecent: recent,
      hasItems: true,
      latestError: latest,
      reauthItems: reauth,
    };
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
        {reauthItems.length > 0 ? (
          <ReauthPopover items={reauthItems} size={size} />
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

/**
 * (#214) Popover trigger + per-bank Reconnect list shown next to the Sync
 * chip when one or more Plaid items report a re-auth error code
 * (ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION, PENDING_DISCONNECT). The
 * trigger label always says "Reconnect" so the single-broken-bank case
 * looks identical to the old inline button; a small count badge is added
 * only when there are 2+ banks to reconnect, signalling that more than one
 * is hiding inside.
 *
 * We deliberately keep the popover narrow and list-only — clicking a row's
 * Reconnect button still invokes <PlaidReconnectButton> which fires the
 * existing update-link-token flow for that specific item id, so a user with
 * two broken banks can fix both back-to-back without having to wait for the
 * next sync to surface the second one.
 */
function ReauthPopover({
  items,
  size,
}: {
  items: PlaidItemDetail[];
  size: "default" | "sm" | "lg" | "icon";
}) {
  const count = items.length;
  const triggerTitle =
    count === 1
      ? `Reconnect ${items[0].institutionName ?? "your bank"} via Plaid`
      : `${count} banks need reconnecting`;
  // (#310) The popover is click/keyboard-driven by default (Radix Popover),
  // but on devices that actually support hover (i.e. desktop with a real
  // pointer) we *also* open it when the user hovers the trigger so power
  // users can glance at which banks are broken without an extra click. We
  // gate this on the `(hover: hover)` media query so touch devices keep the
  // existing tap-to-open behavior — opening on touch-hover would feel
  // flickery and trap-focus the popover unexpectedly.
  const [open, setOpen] = useState(false);
  const [hoverCapable, setHoverCapable] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(hover: hover)");
    setHoverCapable(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setHoverCapable(e.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    return () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    };
  }, []);

  const clearTimers = () => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const handleHoverOpen = () => {
    if (!hoverCapable) return;
    clearTimers();
    // Small open delay so the popover doesn't flicker when the cursor just
    // grazes the trigger on the way somewhere else.
    openTimer.current = window.setTimeout(() => {
      setOpen(true);
    }, 120);
  };

  const handleHoverClose = () => {
    if (!hoverCapable) return;
    clearTimers();
    // A slightly longer close delay gives the user time to move their cursor
    // from the trigger into the popover content without it snapping shut.
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
    }, 150);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={size}
          title={triggerTitle}
          data-testid="button-plaid-reconnect-trigger"
          onMouseEnter={handleHoverOpen}
          onMouseLeave={handleHoverClose}
          onFocus={clearTimers}
        >
          <Link2 className="w-3.5 h-3.5 mr-1" />
          Reconnect
          {count > 1 ? (
            <span
              className="ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
              data-testid="badge-plaid-reconnect-count"
            >
              {count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-2"
        data-testid="popover-plaid-reconnect"
        onMouseEnter={handleHoverOpen}
        onMouseLeave={handleHoverClose}
      >
        <div className="px-2 pb-2 text-xs text-muted-foreground">
          {count === 1
            ? "1 bank needs reconnecting"
            : `${count} banks need reconnecting`}
        </div>
        <ul className="flex flex-col gap-1">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
              data-testid={`row-plaid-reconnect-${it.id}`}
            >
              <span
                className="truncate text-sm"
                title={it.institutionName ?? "Unnamed bank"}
              >
                {it.institutionName ?? "Unnamed bank"}
              </span>
              <PlaidReconnectButton
                itemId={it.id}
                institutionName={it.institutionName}
                size="sm"
              />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
