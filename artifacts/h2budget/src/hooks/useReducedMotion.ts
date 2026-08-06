import { useEffect, useState } from "react";

/**
 * True when the user prefers reduced motion (or when there's no real
 * browser, e.g. jsdom under test — where the test-setup matchMedia polyfill
 * answers `matches: true`, deliberately snapping all motion). Local
 * replacement for framer-motion's useReducedMotion — the one hook we used
 * from that library.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return true;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}
