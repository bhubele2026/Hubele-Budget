import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { QueryObserver, useQueryClient } from "@tanstack/react-query";
import { onBeforeThemeRemount, scrollBeforeThemeChange, useRepaintEpoch, useTheme, writePageScroll } from "@/lib/theme";
import { markReady } from "@/lib/perfMarks";

/**
 * ⭐ (Light and dark) THE OPEN PAGE RE-MOUNTS WHEN THE THEME CHANGES — BUT ONLY IF IT HAS TO.
 * Charts take their colours from JS at draw time (`lib/chartTokens.ts`), so a
 * page that stayed mounted would keep the old inks. Everything else is a CSS
 * token and repaints by itself. So (perf phase 2) the page is keyed on
 * `useRepaintEpoch()`, which moves only when a JS colour has been read since the
 * last re-mount (`lib/theme.ts`): the saved pick settling at the open, before any
 * chart has drawn, repaints in place (`h2:theme-settle`) — no re-mount, nothing
 * asked again. When a re-mount IS needed (`h2:theme-repaint`), every request in
 * flight is held by a stand-in observer across it, so the unmount does not cancel
 * it and the re-mounted page joins it instead of asking again. The shell around
 * it (the top bar and its Appearance menu) stays mounted, and so does the
 * `.page-in` wrapper, so no page entrance replays. The page is put back where it
 * was scrolled.
 */
export function ThemeRepaint({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const epoch = useRepaintEpoch();
  const qc = useQueryClient();
  const held = useRef<Array<() => void>>([]);
  const release = () => {
    for (const off of held.current.splice(0)) off();
  };
  // Hold what is in flight, synchronously, before React unmounts the old page.
  useLayoutEffect(() => {
    const off = onBeforeThemeRemount(() => {
      for (const q of qc.getQueryCache().getAll()) {
        if (q.state.fetchStatus !== "fetching") continue;
        const observer = new QueryObserver(qc, { queryKey: q.queryKey, enabled: false });
        held.current.push(observer.subscribe(() => {}));
      }
    });
    return () => {
      off();
      release();
    };
  }, [qc]);
  // The re-mounted page has subscribed (its effects run before this one): let go.
  useEffect(() => {
    if (held.current.length === 0) return;
    const t = window.setTimeout(release, 0);
    return () => window.clearTimeout(t);
  }, [epoch]);

  const first = useRef(true);
  const lastEpoch = useRef(epoch);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (lastEpoch.current === epoch) {
      // (PERF-0) The theme changed and the page repainted in place.
      markReady("h2:theme-settle");
      return;
    }
    lastEpoch.current = epoch;
    // (PERF-0) The page re-mounted for a theme change: a mark, so a trace shows when.
    markReady("h2:theme-repaint");
    const y = scrollBeforeThemeChange();
    if (y <= 0) return;
    // ⚠️ One write is not enough: the re-mounted page is briefly shorter than
    // it was (lazy panels, lists that fill in a frame later), which drags the
    // scroller back to the top AFTER a first write has stuck. So the position
    // is held until it has stayed put for a quarter of a second (or 1.5 s have
    // gone), and let go the moment the person scrolls or types.
    let frames = 0;
    let heldFrames = 0;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const ev of ["wheel", "touchstart", "keydown"] as const) window.removeEventListener(ev, stop);
    };
    for (const ev of ["wheel", "touchstart", "keydown"] as const) window.addEventListener(ev, stop, { passive: true });
    const put = () => {
      heldFrames = writePageScroll(y) > 1 ? 0 : heldFrames + 1;
      if (heldFrames >= 15 || ++frames >= 90) return stop();
      raf = requestAnimationFrame(put);
    };
    put();
    return stop;
  }, [theme, epoch]);
  return <Fragment key={epoch}>{children}</Fragment>;
}
