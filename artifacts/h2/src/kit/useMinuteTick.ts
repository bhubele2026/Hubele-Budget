import { useEffect, useState } from "react";

/**
 * Re-renders once a minute so "12 minutes ago" keeps moving while a screen is
 * open. Skipped when `now` is pinned (tests) or when nothing shows a relative
 * time. Ported from the classic app's data-state.tsx.
 */
export function useMinuteTick(now?: Date, active = true): Date {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (now || !active) return;
    const id = setInterval(() => setTick((n) => n + 1), 60 * 1000);
    return () => clearInterval(id);
  }, [now, active]);
  return now ?? new Date();
}
