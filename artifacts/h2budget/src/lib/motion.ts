/**
 * ⭐⭐ EVERY CLICK GLIDES (owner, 2026-11-12: "every click should be a slower load, animated, professional … no click
 * should ever be abrupt"; pace = KFI-Housing v220). One calm system, small on purpose — the dials in index.css do the
 * timing, this file only puts the right class on the right thing at the right moment. No animation library.
 *
 * - A CLICK INTO ANOTHER PAGE is one View Transition (`glideNav`, wired as wouter's `aroundNav` in App.tsx): the page you
 *   leave drifts up 12px and fades on `--dur-out`; the next fades in on `--dur-fade` and rises `--page-dist` on
 *   `--dur-page`, starting 30% into the exit, so the two overlap and no frame is ever blank. The top bar and the section
 *   tabs are their own groups and stay put (index.css). Only a person's click or Enter arms it (GESTURE_MS); Back/Forward,
 *   a deep link, a redirect or the app moving itself start at once with a plain `.page-in`.
 * - NO VIEW TRANSITIONS (or a hidden tab): the page leaves on `.page-out`, then arrives whole (`.page-in.page-whole`).
 * - INSIDE A PAGE the sections that arrive with it rise once on a capped stagger (`useRise`: Panel, PageHeader,
 *   SummaryGroup), and a skeleton hands over to its content by fading over it (`useGhostExit`) instead of cutting.
 * - Reduced motion: none of it. A computer that can't keep up (motion-probe.ts) keeps the page glide and drops cascades.
 *
 * ⚠️ The perf marks are untouched: the glide overlaps the data, it never waits on it. A navigation's chunk is awaited
 * (at most CHUNK_WAIT_MS) only so the cross-fade lands on the page, not on a skeleton — the warm-up already asked for
 * the data on hover/press.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { flushSync } from "react-dom";

export const reducedMotion = (): boolean =>
  typeof window === "undefined" ||
  typeof window.matchMedia !== "function" ||
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Set on <html> by motion-probe.ts from MEASURED frames. */
export const motionLite = (): boolean =>
  typeof document !== "undefined" && document.documentElement.dataset["motion"] === "lite";

/** A list's items arrive `--stagger` apart and stop adding delay at the eighth. */
export const STAGGER_CAP = 8;
export const staggerAt = (i: number): CSSProperties | undefined =>
  i > 0 ? { animationDelay: `calc(${Math.min(i, STAGGER_CAP)} * var(--stagger))` } : undefined;

type Dial = "--dur-press" | "--dur-in" | "--dur-rise" | "--dur-page" | "--dur-fade" | "--dur-pop" | "--dur-overlay" | "--dur-out" | "--dur-travel" | "--stagger";
/**
 * A motion dial from index.css in ms, so script timing reads the SAME value the stylesheet animates with.
 * ⚠️ Read once per motion state, never per render: `getComputedStyle(html)` forces a restyle (Housing v217, measured).
 */
const dials = new Map<string, number | null>();
let dialState = "";
export function cssMs(dial: Dial, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const state = `${document.documentElement.dataset["motion"] ?? ""}|${reducedMotion() ? "r" : ""}`;
  if (state !== dialState) {
    dials.clear();
    dialState = state;
  }
  let ms = dials.get(dial);
  if (ms === undefined) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(dial).trim();
    const n = Number.parseFloat(raw);
    ms = !Number.isFinite(n) ? null : raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
    dials.set(dial, ms);
  }
  return ms ?? fallback;
}

// ── The page glide ───────────────────────────────────────────────────────────

/** A navigation within this long of a click or Enter is the person's own, and glides. */
export const GESTURE_MS = 600;
/** The longest a click waits for its page's chunk before it cross-fades anyway. */
export const CHUNK_WAIT_MS = 700;
let lastGesture = -Infinity;
if (typeof window !== "undefined") {
  const mark = () => {
    lastGesture = performance.now();
  };
  window.addEventListener("pointerup", mark, { capture: true, passive: true });
  window.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " " || e.key.startsWith("Arrow")) && mark(), { capture: true });
}
export const gestureNow = (): boolean => typeof performance !== "undefined" && performance.now() - lastGesture < GESTURE_MS;

export type Arrival = "crossed" | "whole" | "plain";
/** How the page at `path` is arriving: set by `glideNav` just before the swap, read once by the page frame. */
let arriving: { path: string; kind: Arrival } | null = null;
/** Read ONCE, by the page frame that mounts for `path`; anything else (Back, a deep link) arrives plain. */
export function takeArrival(path: string): Arrival {
  const kind = arriving && arriving.path === path ? arriving.kind : "plain";
  arriving = null;
  return kind;
}


const pathOnly = (to: string): string => to.replace(/[?#].*$/, "") || "/";

/**
 * ⭐⭐ THE BROWSER'S VIEW TRANSITION: one picture of the page you are on, cross-faded into the LIVE next one on the
 * graphics chip. `html[data-vt="page"]` scopes the CSS for its lifetime (theme.ts uses `data-vt="theme"`). False when the
 * browser has none, the tab is hidden or reduced motion is asked for.
 */
export function pageTransition(update: () => void | Promise<void>, kind = "page"): boolean {
  if (typeof document === "undefined" || document.hidden || reducedMotion()) return false;
  const doc = document as Document & { startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<unknown> } };
  if (typeof doc.startViewTransition !== "function") return false;
  const html = document.documentElement;
  html.dataset["vt"] = kind;
  try {
    const vt = doc.startViewTransition(update);
    void vt.finished.catch(() => {}).finally(() => {
      if (html.dataset["vt"] === kind) delete html.dataset["vt"];
    });
    return true;
  } catch {
    delete html.dataset["vt"];
    return false;
  }
}

let crossing = false;
let seq = 0;
/** The page on screen (its path), so Back can tell a new page from a filter or a hash. */
let shownPath = typeof window === "undefined" ? "/" : pathOnly(window.location.pathname);

/**
 * ⭐ BACK AND FORWARD CROSS-FADE TOO (rig, 2026-11-12: a plain `.page-in` after Back left ~4 frames with nothing on
 * them while the new page faded up from zero). Registered at module load, so it hears `popstate` before wouter does:
 * the browser has moved the address but nothing has re-rendered, so the View Transition's picture is still the page you
 * are leaving; the event is then handed on, inside the transition, to wouter and everyone else. A filter or a hash
 * (same path) is not a page and goes straight through.
 */
let replaying = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (e) => {
    if (replaying) return;
    const path = pathOnly(window.location.pathname);
    const was = shownPath;
    shownPath = path;
    arriving = null;
    if (path === was || crossing) return;
    const state = e.state;
    const hand = () => {
      replaying = true;
      try {
        arriving = { path, kind: "crossed" };
        flushSync(() => window.dispatchEvent(new PopStateEvent("popstate", { state })));
      } finally {
        replaying = false;
      }
    };
    if (document.hidden || reducedMotion() || typeof (document as { startViewTransition?: unknown }).startViewTransition !== "function") return;
    e.stopImmediatePropagation();
    if (!pageTransition(hand)) hand();
  });
}
type Nav = (to: string, opts?: { replace?: boolean; state?: unknown }) => void;

/**
 * wouter's `aroundNav` (App.tsx): every `<Link>` and `navigate()` passes through here. A click into ANOTHER page glides;
 * a filter, a hash or anything the app does by itself goes at once. `chunkOf` answers the route chunk still loading.
 */
export function makeGlideNav(chunkOf: (path: string) => Promise<void> | null, stripBase: (p: string) => string) {
  return (navigate: Nav, to: string, opts?: { replace?: boolean; state?: unknown }) => {
    const path = pathOnly(stripBase(to));
    const here = typeof window === "undefined" ? path : pathOnly(stripBase(window.location.pathname));
    shownPath = pathOnly(to);
    if (crossing || path === here || !gestureNow() || reducedMotion()) {
      arriving = null;
      navigate(to, opts);
      return;
    }
    const mine = ++seq;
    const go = () => {
      if (mine !== seq) return;
      const swap = () => {
        crossing = true;
        try {
          flushSync(() => navigate(to, opts));
        } finally {
          crossing = false;
        }
      };
      arriving = { path, kind: "crossed" };
      if (pageTransition(swap)) return;
      // No View Transitions: the page leaves, then the next arrives whole.
      arriving = { path, kind: "whole" };
      const leaving = document.querySelector<HTMLElement>("[data-page]");
      if (!leaving) return navigate(to, opts);
      leaving.classList.add("page-out");
      window.setTimeout(() => (mine === seq ? navigate(to, opts) : leaving.classList.remove("page-out")), cssMs("--dur-out", 500));
    };
    const chunk = chunkOf(path);
    if (!chunk) return go();
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      go();
    };
    void chunk.then(once, once);
    window.setTimeout(once, CHUNK_WAIT_MS);
  };
}

// ── Inside a page ────────────────────────────────────────────────────────────

/** Sections that mount this long after their page did are not part of its arrival, and never rise. */
export const RISE_WINDOW_MS = 2000;
let pageAt = -Infinity;
let wave = { at: -Infinity, i: 0 };
/** The page frame calls this when a page mounts: its sections rise from here, in reading order. */
export function notePageArrived(): void {
  pageAt = performance.now();
  wave = { at: -Infinity, i: 0 };
}

/**
 * ⭐ A SECTION RISES ONCE, WITH ITS PAGE (Panel, PageHeader, SummaryGroup). Decided at its first render and never
 * again: what mounts with the page (or within RISE_WINDOW_MS, as its data lands) rises on `--dur-rise`, `--stagger`
 * after the last, capped at STAGGER_CAP; a later re-mount (a theme repaint, a switch) simply is there. A section inside
 * a rising section stays still (index.css `.rise-in .rise-in`), so nothing fades twice.
 */
export function useRise(): { className?: string; style?: CSSProperties } {
  const [r] = useState<{ className?: string; style?: CSSProperties }>(() => {
    if (typeof performance === "undefined" || reducedMotion()) return {};
    const now = performance.now();
    if (now - pageAt > RISE_WINDOW_MS) return {};
    if (now - wave.at > 60) wave.i = 0;
    wave.at = now;
    return { className: "rise-in", style: staggerAt(wave.i++) };
  });
  return r;
}

// ── After the first page: the small moves a click sets off (lib/motion-extra.ts, its own chunk) ─────────────────────
type Extra = typeof import("./motion-extra");
let extra: Extra | null = null;
/** The page frame asks for it once the first page is up; until it lands, these moves simply do not play. */
export function loadMotionExtra(): void {
  if (!extra && typeof window !== "undefined") void import("./motion-extra").then((m) => (extra = m), () => {});
}

/** ⭐ A skeleton hands over to its content by fading over it as it arrives (motion-extra `ghostOut`), never a cut. */
export function useGhostExit(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el && extra) extra.ghostOut(el);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** ⭐ The selection pill of a segmented group (`ref`) travels to the segment picked (motion-extra `slidePill`). */
export function useSlidingPill(ref: RefObject<HTMLElement | null>): void {
  const last = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const g = ref.current;
    const on = g?.querySelector<HTMLElement>(':scope>:is([aria-pressed="true"],[aria-checked="true"],[aria-selected="true"])') ?? null;
    const was = last.current;
    last.current = on;
    if (g && on && was && was !== on) extra?.slidePill(g, was, on);
  });
}

/** ⭐ The lit tab's underline travels from the tab you left (motion-extra `travelLine`). */
export function useUnderlineTravel(navRef: RefObject<HTMLElement | null>, key: string | null): void {
  const last = useRef<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const u = nav?.querySelector<HTMLElement>(".tab-underline");
    const was = last.current;
    const r = u?.getBoundingClientRect();
    last.current = nav && u && r ? { left: r.left - nav.getBoundingClientRect().left + nav.scrollLeft, width: r.width } : null;
    if (u && was && last.current) extra?.travelLine(u, was, last.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** ⭐ THE DASHBOARD'S HOVER GLOW: a soft navy spotlight that follows the pointer across a clickable panel (`.tile-glow`). */
let glowFrame = 0;
export function glowAt(e: { currentTarget: EventTarget & HTMLElement; clientX: number; clientY: number }): void {
  const el = e.currentTarget;
  const { clientX, clientY } = e;
  cancelAnimationFrame(glowFrame);
  glowFrame = requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${Math.round(clientX - r.left)}px`);
    el.style.setProperty("--my", `${Math.round(clientY - r.top)}px`);
  });
}
