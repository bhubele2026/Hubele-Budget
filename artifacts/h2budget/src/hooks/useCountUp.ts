import { useEffect, useRef, useState } from "react";

/**
 * Animate a number from its previous value up to `target` (from 0 on first
 * mount) with an ease-out, for the "numbers count up when the app opens"
 * effect. Honors prefers-reduced-motion. Returns the current animated value;
 * format it at the call site.
 */
export function useCountUp(
  target: number | null | undefined,
  durationMs = 850,
): number {
  const [val, setVal] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) return;

    // Jump straight to the target (no animation) when the user prefers
    // reduced motion, OR when we're not in a real browser (no matchMedia /
    // no requestAnimationFrame — e.g. SSR or jsdom under test). Animating
    // from 0 in those environments would leave the value stuck at 0 because
    // the rAF tick never runs synchronously.
    const noBrowserAnimation =
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      typeof window.requestAnimationFrame !== "function";
    const reduce =
      !noBrowserAnimation &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (noBrowserAnimation || reduce) {
      setVal(target);
      fromRef.current = target;
      return;
    }

    const from = fromRef.current;
    let start: number | null = null;
    let raf = 0;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic

    const step = (ts: number) => {
      if (start == null) start = ts;
      const t = Math.min(1, (ts - start) / durationMs);
      setVal(from + (target - from) * ease(t));
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
      }
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return val;
}
