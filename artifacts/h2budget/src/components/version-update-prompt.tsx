import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVersion,
  getGetVersionQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { APP_VERSION } from "@/lib/version";
import { RefreshCw } from "lucide-react";

// (#823) New-version reload prompt. The loaded bundle bakes its build
// identifier (APP_VERSION) at build time; the API serves the identifier
// of the *currently deployed* build at /api/version. We check that
// endpoint on window focus plus once shortly after load (at browser
// idle) and, when the served version no longer matches the one we
// booted with, surface a small non-intrusive banner inviting the user
// to reload onto the new bundle. No background polling — a tab left
// open just checks again the next time it's focused.
//
// Deliberate constraints (see task #823):
//   * No automatic reload — the user may be mid-input.
//   * No re-nagging — once shown, the banner stays put until the user
//     reloads (or navigates fresh, which reloads anyway). We latch the
//     "outdated" state so a flaky check that briefly returns the old
//     value can't make it flicker away.
//   * Only meaningful in a real deploy. In dev the bundle runs unbuilt
//     (APP_VERSION === "dev"), so we never check or prompt there.

// Once-per-session latch so a persistent build-id mismatch can never spin in
// a reload loop — we self-heal a stale bundle exactly once, then fall back to
// the manual banner if it's somehow still stale after that reload.
const SELF_RELOAD_KEY = "h2:version-self-reloaded";

function isTyping(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  return (
    !!ae &&
    (ae.tagName === "INPUT" ||
      ae.tagName === "TEXTAREA" ||
      ae.isContentEditable === true)
  );
}

export function VersionUpdatePrompt() {
  const enabled = import.meta.env.PROD && APP_VERSION !== "dev";
  const [outdated, setOutdated] = useState(false);
  const [location] = useLocation();
  const queryClient = useQueryClient();

  const { data } = useGetVersion({
    query: {
      queryKey: getGetVersionQueryKey(),
      enabled,
      // Treat the version as always-stale so the focus/idle checks
      // actually hit the network. No refetchInterval — checks happen on
      // mount, once at idle after load, and whenever the user tabs back.
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
      // A transient version-check failure should never bubble up as a
      // user-facing error — silently retry on the next check.
      retry: false,
    },
  });

  // One extra check shortly after load, at browser idle — catches a deploy
  // that lands right as the tab boots, without any recurring poll.
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      void queryClient.invalidateQueries({
        queryKey: getGetVersionQueryKey(),
      });
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(check);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(check, 3_000); // Safari: no requestIdleCallback
    return () => window.clearTimeout(id);
  }, [enabled, queryClient]);

  useEffect(() => {
    if (!enabled) return;
    const served = data?.version;
    if (served && served !== APP_VERSION) {
      setOutdated(true);
    }
  }, [data?.version, enabled]);

  // Self-heal a stale bundle: when a newer version is live, silently reload
  // onto it — ONCE per session, and never while the user is typing. Re-runs on
  // navigation, so if we held off because an input was focused, the next route
  // change heals it. This is what stops the "old shell" + "new version" toast
  // from ever lingering (the served index.html can be browser-cached, so a tab
  // can boot a stale bundle; this reloads it the moment it's safe).
  useEffect(() => {
    if (!outdated) return;
    let already = false;
    try {
      already = sessionStorage.getItem(SELF_RELOAD_KEY) === "1";
    } catch {
      /* sessionStorage unavailable — fall through to the manual banner */
    }
    if (already || isTyping()) return; // healed once already, or don't interrupt typing
    try {
      sessionStorage.setItem(SELF_RELOAD_KEY, "1");
    } catch {
      /* ignore */
    }
    window.location.reload();
  }, [outdated, location]);

  if (!outdated) return null;

  return (
    <div
      role="status"
      data-testid="version-update-banner"
      className="fixed inset-x-0 bottom-0 z-[100] flex justify-center px-4 pb-4"
    >
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <RefreshCw className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm text-foreground">
          A new version is available.
        </span>
        <Button
          size="sm"
          onClick={() => window.location.reload()}
          data-testid="version-update-reload"
        >
          Reload
        </Button>
      </div>
    </div>
  );
}
