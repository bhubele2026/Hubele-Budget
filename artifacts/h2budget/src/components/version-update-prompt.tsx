import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetVersion,
  getGetVersionQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { APP_VERSION } from "@/lib/version";
import { RefreshCw } from "lucide-react";

// (#823) New-version reload prompt. The loaded bundle bakes its build
// identifier (APP_VERSION) at build time; the API serves the identifier
// of the *currently deployed* build at /api/version. We poll that
// endpoint on a sensible cadence (and on window focus) and, when the
// served version no longer matches the one we booted with, surface a
// small non-intrusive banner inviting the user to reload onto the new
// bundle.
//
// Deliberate constraints (see task #823):
//   * No automatic reload — the user may be mid-input.
//   * No re-nagging — once shown, the banner stays put until the user
//     reloads (or navigates fresh, which reloads anyway). We latch the
//     "outdated" state so a flaky poll that briefly returns the old
//     value can't make it flicker away.
//   * Only meaningful in a real deploy. In dev the bundle runs unbuilt
//     (APP_VERSION === "dev"), so we never poll or prompt there.
const POLL_INTERVAL_MS = 90_000;

export function VersionUpdatePrompt() {
  const enabled = import.meta.env.PROD && APP_VERSION !== "dev";
  const [outdated, setOutdated] = useState(false);
  const [location] = useLocation();
  // Latch the route the banner first appeared on. Once a new version is live,
  // the very next client-side navigation hard-reloads onto the fresh bundle —
  // so the user never lands on a stale-bundle "old shell" of another route.
  // This stays safe (never reloads mid-input on the current page).
  const latchLocRef = useRef<string | null>(null);

  const { data } = useGetVersion({
    query: {
      queryKey: getGetVersionQueryKey(),
      enabled,
      // Treat the version as always-stale and poll on a fixed cadence
      // plus whenever the user tabs back to the app.
      staleTime: 0,
      refetchInterval: POLL_INTERVAL_MS,
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
      // A transient version-check failure should never bubble up as a
      // user-facing error — silently retry on the next tick.
      retry: false,
    },
  });

  useEffect(() => {
    if (!enabled) return;
    const served = data?.version;
    if (served && served !== APP_VERSION) {
      setOutdated(true);
    }
  }, [data?.version, enabled]);

  // When outdated, latch the current route; the next navigation away from it
  // forces a full reload onto the new bundle.
  useEffect(() => {
    if (outdated && latchLocRef.current === null) {
      latchLocRef.current = location;
    } else if (
      outdated &&
      latchLocRef.current !== null &&
      location !== latchLocRef.current
    ) {
      window.location.reload();
    }
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
