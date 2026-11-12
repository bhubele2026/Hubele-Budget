import { useEffect } from "react";

/**
 * (PERF-0) READY MARKS — when the real numbers are on screen, measured, never sent.
 *
 * A page calls `useReadyMark(name, ready)` with `ready` true only once its main
 * figure shows real data (not a skeleton). The first time per page view it
 * leaves a `performance.mark(name)` whose `detail.nav` is the view's number, so
 * a trace or the perf harness (`scripts/perf/`) can read "how long until the
 * numbers". A route change (`startPerfNavigation`) opens a new view and marks
 * `h2:nav`. LCP, CLS and INP are kept in `window.__h2perf` by
 * `observeWebVitals()`. Nothing is drawn and nothing leaves the browser.
 *
 * Names: `h2:home-numbers-ready`, `h2:weekly-pay-ready`,
 * `h2:page-ready:<path>`, `h2:warmup-start`, `h2:theme-repaint`.
 */

export interface H2Perf {
  /** Largest contentful paint (ms from navigation start), the latest candidate. */
  lcp?: number;
  /** Cumulative layout shift (sum of shifts without recent input). */
  cls: number;
  /** Interaction to next paint: the longest interaction seen (ms). */
  inp?: number;
  /** Page views so far (0 = the document load). */
  nav: number;
}

let nav = 0;
let marked = new Set<string>();

function perf(): Performance | null {
  return typeof performance !== "undefined" && typeof performance.mark === "function" ? performance : null;
}

function state(): H2Perf | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __h2perf?: H2Perf };
  w.__h2perf ??= { cls: 0, nav };
  return w.__h2perf;
}

/** Leave `name` once for this page view. Later calls in the same view do nothing. */
export function markReady(name: string): void {
  if (marked.has(name)) return;
  marked.add(name);
  try {
    perf()?.mark(name, { detail: { nav } });
  } catch {
    /* a browser without mark details: the mark is a nicety */
  }
}

/** A new page view (a route change): marks may be left again. */
export function startPerfNavigation(path: string): void {
  nav += 1;
  marked = new Set();
  const s = state();
  if (s) s.nav = nav;
  try {
    perf()?.mark("h2:nav", { detail: { nav, path } });
  } catch {
    /* as above */
  }
}

/** Mark `name` once, after the commit in which `ready` first holds. */
export function useReadyMark(name: string, ready: boolean): void {
  useEffect(() => {
    if (ready) markReady(name);
  }, [name, ready]);
}

/**
 * `h2:page-ready:<the page's path>` once `ready` holds, for a component more than one route draws. The path is
 * read when the mark is left (no router hook, so it works anywhere).
 */
export function usePageReadyMark(ready: boolean): void {
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const base = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");
    let path = window.location.pathname;
    if (base && path.startsWith(base)) path = path.slice(base.length) || "/";
    markReady(`h2:page-ready:${path}`);
  }, [ready]);
}

/** Tests only. */
export function _resetPerfMarksForTests(): void {
  nav = 0;
  marked = new Set();
}

type Entry = PerformanceEntry & { value?: number; hadRecentInput?: boolean; interactionId?: number; duration: number };

/**
 * Keep LCP, CLS and INP in `window.__h2perf` (buffered, so entries before the
 * call count). Safe where PerformanceObserver or an entry type is missing.
 */
export function observeWebVitals(): void {
  const s = state();
  if (!s || typeof PerformanceObserver === "undefined") return;
  const watch = (type: string, onEntry: (e: Entry) => void, extra?: Record<string, unknown>) => {
    try {
      const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes;
      if (supported && !supported.includes(type)) return;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) onEntry(e as Entry);
      }).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    } catch {
      /* this entry type is not observable here */
    }
  };
  watch("largest-contentful-paint", (e) => {
    s.lcp = e.startTime;
  });
  watch("layout-shift", (e) => {
    if (!e.hadRecentInput) s.cls += e.value ?? 0;
  });
  watch(
    "event",
    (e) => {
      if (e.interactionId) s.inp = Math.max(s.inp ?? 0, e.duration);
    },
    { durationThreshold: 16 },
  );
}
