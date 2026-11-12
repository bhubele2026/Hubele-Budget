import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
import { whenForegroundIdle } from "@/lib/speculative";
import { HOME_MARKS, WARMUP_GIVE_UP_MS, WARMUP_QUIET_MS } from "@/hooks/useLandingWarmup";
import { useWhatsNewOpenPending } from "@/lib/whatsNewSignal";

/**
 * ⭐ (WN) THE WHAT'S NEW MOUNT — on the open path, so it stays tiny: it loads
 * the host (the notes, the sheet, the greeting) at idle once someone is signed
 * in, or at once when "What's new" is pressed first. Mounted in `App.tsx` next
 * to the version prompt, outside the routes, so a route change never unmounts
 * the sheet.
 *
 * Off in the test suite (`MODE === "test"`) unless `enabled`: App-level tests
 * never fetch `/whats-new/me` or meet a sheet.
 */

const importHost = () => import("./WhatsNewHost");
const WhatsNewHost = lazyWithPreload(importHost);

/** The latest the host waits for a quiet page. */
export const WHATS_NEW_DEADLINE_MS = 30_000;

/** Where no one is greeted: the front door and the sign-in pages. */
function offRoute(path: string): boolean {
  return path === "/" || path.startsWith("/sign-in") || path.startsWith("/sign-up");
}

export function WhatsNewMount({ enabled = false }: { enabled?: boolean }) {
  if (!enabled && import.meta.env.MODE === "test") return null;
  return <MountGate />;
}

function MountGate() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [location] = useLocation();
  const pending = useWhatsNewOpenPending();
  const qc = useQueryClient();
  const onHome = location === "/home";
  const [ready, setReady] = useState(false);
  const active = Boolean(isLoaded && isSignedIn && userId) && !offRoute(location);

  useEffect(() => {
    if (!active || ready) return;
    let off = false;
    const load = () => {
      void WhatsNewHost.preload().then(
        () => {
          if (!off) setReady(true);
        },
        () => {
          /* the chunk failed: no sheet this time; a later press asks again */
        },
      );
    };
    if (pending) {
      load();
      return () => {
        off = true;
      };
    }
    // (perf phase 2) Not at the first idle: once the page is quiet (no query or chunk in flight), and on Home once
    // its real numbers are in, so the host's chunk and /whats-new/me never share the link with them. Not a guess:
    // it loads on any connection, only later, and by WHATS_NEW_DEADLINE_MS whatever is still in flight.
    const cancel = whenForegroundIdle(
      qc,
      { marks: onHome ? HOME_MARKS : undefined, quietMs: WARMUP_QUIET_MS, giveUpMs: WARMUP_GIVE_UP_MS, speculative: false, deadlineMs: WHATS_NEW_DEADLINE_MS },
      load,
    );
    return () => {
      off = true;
      cancel();
    };
  }, [active, ready, pending, onHome, qc]);

  if (!active || !ready || !userId) return null;
  // Rendered only once the chunk is in, so it never suspends; the boundary is a guard.
  return (
    <Suspense fallback={null}>
      <WhatsNewHost key={userId} userId={userId} />
    </Suspense>
  );
}
