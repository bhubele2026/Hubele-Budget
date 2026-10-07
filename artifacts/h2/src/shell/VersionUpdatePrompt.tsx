import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetVersion, getGetVersionQueryKey } from "@workspace/api-client-react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/kit/Button";
import { APP_VERSION } from "@/lib/version";

// Once-per-session latch, shared with the classic app on purpose (same
// origin): a persistent build-id mismatch self-heals with ONE reload, then
// falls back to the banner. It can never spin a reload loop.
const SELF_RELOAD_KEY = "h2:version-self-reloaded";

function isTyping(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  return !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable === true);
}

/**
 * A new version has been deployed — ported from the classic app.
 *
 * The bundle bakes its build id (`__APP_VERSION__`); `/api/version` serves the
 * id of the build now deployed. Checked on mount, once at idle after load, and
 * whenever the tab regains focus — no polling loop. On a mismatch it reloads
 * once (never while someone is typing), then shows a quiet banner. A dev build
 * ("dev") never checks.
 */
export function VersionUpdatePrompt() {
  const enabled = import.meta.env.PROD && APP_VERSION !== "dev";
  const [outdated, setOutdated] = useState(false);
  const [location] = useLocation();
  const queryClient = useQueryClient();

  const { data } = useGetVersion({
    query: {
      queryKey: getGetVersionQueryKey(),
      enabled,
      staleTime: 0,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
      retry: false,
    },
  });

  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      void queryClient.invalidateQueries({ queryKey: getGetVersionQueryKey() });
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(check);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(check, 3_000);
    return () => window.clearTimeout(id);
  }, [enabled, queryClient]);

  useEffect(() => {
    if (!enabled) return;
    const served = data?.version;
    if (served && served !== APP_VERSION) setOutdated(true);
  }, [data?.version, enabled]);

  useEffect(() => {
    if (!outdated) return;
    let already = false;
    try {
      already = sessionStorage.getItem(SELF_RELOAD_KEY) === "1";
    } catch {
      /* storage unavailable — fall through to the banner */
    }
    if (already || isTyping()) return;
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
      className="fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 md:bottom-4"
    >
      <div className="flex items-center gap-3 rounded-2 border border-rule-strong bg-paper-0 px-4 py-3">
        <RefreshCw size={16} strokeWidth={1.75} aria-hidden className="text-ink-2" />
        <span className="type-body text-ink">A new version of H2 is ready.</span>
        <Button variant="primary" size="sm" onClick={() => window.location.reload()} data-testid="version-update-reload">
          Reload
        </Button>
      </div>
    </div>
  );
}
