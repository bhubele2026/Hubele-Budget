import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useListPlaidItems } from "@workspace/api-client-react";
import { AlertTriangle, X } from "lucide-react";
import { isPlaidReauthCode } from "@/components/plaid-reconnect-button";

// We persist a "dismissed" snapshot keyed by the *set* of broken item ids so
// that dismissing the banner today doesn't suppress it tomorrow if a new bank
// breaks. The Sync chip in the header already covers single-item recovery; this
// banner exists for the multi-bank case where users miss things in Settings.
const DISMISS_KEY = "h2budget.dashboardReconnectBanner.dismissedSig";

function buildSignature(ids: string[]): string {
  return [...ids].sort().join(",");
}

function readDismissedSig(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissedSig(sig: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DISMISS_KEY, sig);
  } catch {
    // sessionStorage can throw in private modes / quota — silently no-op so
    // dismissal just becomes per-render. The banner will still work.
  }
}

export function DashboardReconnectBanner() {
  const { data: plaidItems } = useListPlaidItems();

  const broken = useMemo(() => {
    const items = plaidItems ?? [];
    return items
      .filter((it) => isPlaidReauthCode(it.lastSyncErrorCode))
      .map((it) => ({
        id: it.id,
        name: (it.institutionName ?? "").trim() || "Linked institution",
      }));
  }, [plaidItems]);

  const signature = useMemo(
    () => buildSignature(broken.map((b) => b.id)),
    [broken],
  );

  // Track the dismissed signature in state so toggling re-renders the banner.
  // Initialise from sessionStorage on mount, then keep in sync if the user
  // dismisses (or if a new bank breaks and the signature changes).
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);
  useEffect(() => {
    setDismissedSig(readDismissedSig());
  }, []);

  if (broken.length === 0) return null;
  if (dismissedSig && dismissedSig === signature) return null;

  const names = broken.map((b) => b.name);
  const count = broken.length;
  const namesLabel = names.join(", ");
  const heading =
    count === 1
      ? `1 bank needs reconnecting: ${namesLabel}`
      : `${count} banks need reconnecting: ${namesLabel}`;

  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/50 bg-destructive/10 text-destructive px-4 py-3 flex items-start gap-3"
      data-testid="banner-reconnect-needed"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium" data-testid="text-reconnect-heading">
          {heading}
        </div>
        <div className="text-xs text-destructive/80 mt-0.5">
          Plaid stopped syncing — re-enter credentials to resume imports.{" "}
          <Link
            href="/settings"
            className="underline font-medium"
            data-testid="link-reconnect-settings"
          >
            Fix in Settings
          </Link>
        </div>
      </div>
      <button
        type="button"
        className="text-destructive/70 hover:text-destructive shrink-0"
        onClick={() => {
          writeDismissedSig(signature);
          setDismissedSig(signature);
        }}
        aria-label="Dismiss"
        data-testid="button-dismiss-reconnect-banner"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
