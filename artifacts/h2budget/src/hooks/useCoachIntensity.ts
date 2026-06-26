import { useEffect, useState } from "react";

// Client-only coach-intensity preference. The server advisor voice is fixed
// (and already on-brand); this gates the FRONTEND sassy copy + profanity so
// Hannah has an escape hatch. Persisted to localStorage, default "savage".
// No backend/schema change — honors the Juggernaut "no logic changes" rule.

export type CoachIntensity = "cheeky" | "savage";
const KEY = "h2:coach-intensity";
const EVENT = "h2:coach-intensity-change";

export function getCoachIntensity(): CoachIntensity {
  if (typeof window === "undefined") return "savage";
  return window.localStorage.getItem(KEY) === "cheeky" ? "cheeky" : "savage";
}

export function setCoachIntensity(v: CoachIntensity): void {
  try {
    window.localStorage.setItem(KEY, v);
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore */
  }
}

/** Reactive coach intensity + setter. Cross-component via a window event. */
export function useCoachIntensity(): [CoachIntensity, (v: CoachIntensity) => void] {
  const [intensity, setIntensity] = useState<CoachIntensity>(getCoachIntensity);

  useEffect(() => {
    const sync = () => setIntensity(getCoachIntensity());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return [intensity, setCoachIntensity];
}

/** Pick the right variant for the current intensity. */
export function bySpice<T>(intensity: CoachIntensity, opts: { cheeky: T; savage: T }): T {
  return intensity === "savage" ? opts.savage : opts.cheeky;
}
