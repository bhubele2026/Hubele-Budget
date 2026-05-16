import { useEffect } from "react";
import { usePlaidSync } from "@/hooks/use-plaid-sync";

// (#671) Layer 4 — Opportunistic refresh on key page mounts.
//
// Dashboard / Forecast / Transactions are the data-heavy pages where
// the user expects "what they see is what their bank knows right now".
// Mounting one of them fires a silent, fire-and-forget Plaid sync with
// forceRefresh=true so any pending charges the bank already has land
// without the user having to press Sync.
//
// Two important rate-limits keep this from hammering Plaid:
//   1. **Module-level cooldown across all mounts**: navigating between
//      Dashboard → Forecast → Transactions in quick succession fires
//      ONE refresh, not three. The clock is shared across every page
//      using this hook within a single tab session.
//   2. **Silent failure**: errors and "still preparing" outcomes
//      never raise a toast — the user only learns about them by
//      clicking Sync manually. The point of Layer 4 is invisible
//      freshness; explicit feedback belongs on the manual path.
//
// The cooldown lives in module scope (not state) so it survives
// component unmount/remount. It does NOT survive a full page reload —
// that's intentional: a hard refresh is itself a strong "give me
// fresh data" signal from the user.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

let lastAttemptAt = 0;
let inflight = false;

// Test helper — resets the module-level cooldown between tests so each
// case starts from a clean slate. Not exported from any public surface.
export function _resetOpportunisticSyncForTests(): void {
  lastAttemptAt = 0;
  inflight = false;
}

export type UseOpportunisticPlaidSyncOptions = {
  // Override the cooldown (ms). Defaults to 5 minutes. Tests set this
  // very low; product code should leave it at the default.
  cooldownMs?: number;
  // When false, the hook is a no-op. Lets a page disable opportunistic
  // refresh while still being able to call the hook unconditionally
  // (Rules of Hooks).
  enabled?: boolean;
};

/**
 * Fire-and-forget Plaid refresh on page mount, gated by a module-wide
 * cooldown. Safe to call from any page; multiple pages mounting within
 * the cooldown window share a single refresh.
 */
export function useOpportunisticPlaidSync(
  opts: UseOpportunisticPlaidSyncOptions = {},
): void {
  const { cooldownMs = DEFAULT_COOLDOWN_MS, enabled = true } = opts;
  const { runSync } = usePlaidSync();

  useEffect(() => {
    if (!enabled) return;
    if (inflight) return;
    const now = Date.now();
    if (now - lastAttemptAt < cooldownMs) return;
    lastAttemptAt = now;
    inflight = true;
    // silent:true — never toast. invalidations inside runSync will
    // refresh the open page once data lands.
    runSync({ silent: true })
      .catch(() => {
        // Swallow — Layer 4 is best-effort. Manual Sync surfaces real
        // errors with the actionable toast/CTA.
      })
      .finally(() => {
        inflight = false;
      });
    // Intentionally run only on mount; navigating between pages
    // remounts and the cooldown guards the actual call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
