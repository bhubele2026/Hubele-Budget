import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
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

/** Where no one is greeted: the front door and the sign-in pages. */
function offRoute(path: string): boolean {
  return path === "/" || path.startsWith("/sign-in") || path.startsWith("/sign-up");
}

export function WhatsNewMount({ enabled = false }: { enabled?: boolean }) {
  if (!enabled && import.meta.env.MODE === "test") return null;
  return <MountGate />;
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

function MountGate() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [location] = useLocation();
  const pending = useWhatsNewOpenPending();
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
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(load, { timeout: 3000 });
      return () => {
        off = true;
        w.cancelIdleCallback?.(id);
      };
    }
    const t = window.setTimeout(load, 1500);
    return () => {
      off = true;
      window.clearTimeout(t);
    };
  }, [active, ready, pending]);

  if (!active || !ready || !userId) return null;
  // Rendered only once the chunk is in, so it never suspends; the boundary is a guard.
  return (
    <Suspense fallback={null}>
      <WhatsNewHost key={userId} userId={userId} />
    </Suspense>
  );
}
