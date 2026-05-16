import { useEffect } from "react";
import { usePlaidSync } from "@/hooks/use-plaid-sync";

// (#671 / #673) Layer 4 — Opportunistic refresh on key page mounts and
// on tab-focus return.
//
// Dashboard / Forecast / Transactions / Amex are the data-heavy pages
// where the user expects "what they see is what their bank knows right
// now". Mounting one of them — OR returning to the tab after the
// browser backgrounded it — fires a silent, fire-and-forget Plaid sync
// with forceRefresh=true so any pending charges the bank already has
// land without the user having to press Sync. (#673) The focus-return
// path is what closes the gap for a user who hasn't touched the tab
// for a while: they swipe a card, switch back to the budget tab, and
// the pending charge is already on screen by the time they look.
//
// Two important rate-limits keep this from hammering Plaid:
//   1. **Module-level cooldown across all mounts AND focus events**:
//      navigating between Dashboard → Forecast → Transactions in quick
//      succession (or flipping tabs five times in a row) fires ONE
//      refresh, not five. The clock is shared across every page using
//      this hook within a single tab session.
//   2. **Silent failure**: errors and "still preparing" outcomes
//      never raise a toast — the user only learns about them by
//      clicking Sync manually. The point of Layer 4 is invisible
//      freshness; explicit feedback belongs on the manual path.
//
// The cooldown lives in module scope (not state) so it survives
// component unmount/remount. It does NOT survive a full page reload —
// that's intentional: a hard refresh is itself a strong "give me
// fresh data" signal from the user.
//
// (#673) The default cooldown is 60s — short enough that the
// pending-charge-after-swipe-and-return UX feels live, long enough
// that the per-item lock + Plaid quota never see a burst.
const DEFAULT_COOLDOWN_MS = 60 * 1000;

let lastAttemptAt = 0;
let inflight = false;

// Test helper — resets the module-level cooldown between tests so each
// case starts from a clean slate. Not exported from any public surface.
export function _resetOpportunisticSyncForTests(): void {
  lastAttemptAt = 0;
  inflight = false;
}

export type UseOpportunisticPlaidSyncOptions = {
  // Override the cooldown (ms). Defaults to 60 seconds (#673). Tests
  // set this very low; product code should leave it at the default.
  cooldownMs?: number;
  // When false, the hook is a no-op. Lets a page disable opportunistic
  // refresh while still being able to call the hook unconditionally
  // (Rules of Hooks).
  enabled?: boolean;
};

/**
 * Fire-and-forget Plaid refresh on page mount AND on tab-focus
 * return, gated by a module-wide cooldown. Safe to call from any
 * page; multiple pages mounting (or several focus toggles within the
 * cooldown window) share a single refresh.
 */
export function useOpportunisticPlaidSync(
  opts: UseOpportunisticPlaidSyncOptions = {},
): void {
  const { cooldownMs = DEFAULT_COOLDOWN_MS, enabled = true } = opts;
  const { runSync } = usePlaidSync();

  useEffect(() => {
    if (!enabled) return;

    function attempt() {
      if (inflight) return;
      const now = Date.now();
      if (now - lastAttemptAt < cooldownMs) return;
      lastAttemptAt = now;
      inflight = true;
      // silent:true — never toast. invalidations inside runSync will
      // refresh the open page once data lands.
      runSync({ silent: true })
        .catch(() => {
          // Swallow — Layer 4 is best-effort. Manual Sync surfaces
          // real errors with the actionable toast/CTA.
        })
        .finally(() => {
          inflight = false;
        });
    }

    // Mount fire — navigating between pages remounts and the
    // cooldown guards the actual call.
    attempt();

    // (#673) Tab-focus return fire — a user who hasn't touched the
    // tab for a while and comes back from background gets fresh
    // pending charges within seconds, no Sync click required. The
    // module-level cooldown prevents tab-flip thrashing.
    if (typeof document === "undefined") return;
    function onVisibility() {
      if (document.visibilityState === "visible") attempt();
    }
    function onFocus() {
      attempt();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
    // Intentionally only re-bind when enabled / cooldown change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cooldownMs]);
}
