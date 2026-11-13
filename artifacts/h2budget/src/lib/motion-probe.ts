/**
 * (Ported from KFI-Housing v220 `src/web/motion-probe.ts`, values unchanged, 2026-11-12.)
 * ⭐⭐ DOES THIS COMPUTER KEEP UP WITH THE MOTION? (Brad, 2026-09-30: *"on other peoples crappy
 * computer all animations are laggy and slow, any way to fix that?"* — offered the choice, he
 * picked: the app notices when a computer can't keep up and switches that browser to plain,
 * quick fades; his Mac stays exactly as it is.)
 *
 * MEASURED, NEVER GUESSED FROM THE HARDWARE. For a moment after each of the first boards to
 * arrive (`PageFrame`, components/layout.tsx), the browser's own frames are timed. A board arriving is the
 * app's busiest motion, and a frame the browser can't draw in time shows up here whether the
 * processor or the graphics chip is the one struggling. ONE CLEARLY slow arrival, or two slow
 * ones, and that browser gets `<html data-motion="lite">` (index.css says what that changes),
 * remembered for `RECHECK_DAYS`, then measured again. One hitch never flips a fast machine; only
 * "lite" is ever remembered, so a fast machine is simply measured again on its next visit.
 *
 * ⭐ THE FIRST CLEARLY SLOW ARRIVAL DECIDES (2026-11-12, v217 perf). Waiting for a second slow
 * board meant a struggling laptop drew two whole boards' worth of motion it could not draw before
 * anything changed — and most visits open one board. "Clearly" is the bar a fast machine never
 * meets by accident: its QUICKEST frames under 20 a second (`CLEAR_BASE_MS`), half its frames
 * missing a beat (`CLEAR_SHARE`), or one freeze of a full second (`CLEAR_FREEZE_MS`). Anything
 * merely slow still needs a second arrival to agree.
 *
 * `?motion=lite` / `?motion=full` sets it by hand (testing and support — there is no switch on
 * screen); `?motion=auto` forgets it. Someone who asked their machine for less motion gets none
 * at all already (prefers-reduced-motion), so nothing is measured for them.
 *
 * ⚠️ The judge is pure (`judgeArrival`, `decide`, `readStored`, `fromUrl`) and tested; the rest is
 * a thin rAF sampler. Storage is per browser and best-effort: a private window or blocked
 * storage just means measuring again.
 */
import { reducedMotion } from "./motion";

export const MOTION_KEY = "h2:motion";
/** A remembered "lite" is measured again after this long — a machine can be replaced or fixed. */
export const RECHECK_DAYS = 30;
/** How long one arrival is timed: the board's sections rise over about this long. */
export const SAMPLE_MS = 1500;
/** A frame over this missed a 60Hz display twice over — the eye sees it as a stutter… */
export const LONG_FRAME_MS = 33;
/** …and on a browser drawing slower than 60, a frame is long when it takes this many of the
 *  browser's own frames: a missed beat of ITS rhythm, not ours. */
export const LONG_BEATS = 1.5;
/** An arrival is slow when this share of its frames were long… */
export const SLOW_SHARE = 0.25;
/** …or when even its quickest frames are this slow (under 25 a second at its best). */
export const SLOW_BASE_MS = 40;
/** One freeze this long in an arrival is a stutter anyone sees. */
export const FREEZE_MS = 500;
/** A gap this long is not slow drawing — the laptop slept. (A tab hidden mid-sample is caught
 *  by `visibilitychange`; a SLOW computer can stall a second and more, and that must count.) */
export const ASLEEP_MS = 3000;
/** The first gaps hold the board's own first paint, which is long on every machine. */
const SKIP_GAPS = 2;
/** Two slow arrivals switch it; two fast ones settle it for this visit. */
export const SLOW_OF = 2;
/** ⭐ One arrival this slow switches it alone: the quick end of its frames under 20 a second… */
export const CLEAR_BASE_MS = 50;
/** …or half its frames missing a beat… */
export const CLEAR_SHARE = 0.5;
/** …or one freeze of a full second. */
export const CLEAR_FREEZE_MS = 1000;

export type Verdict = "very-slow" | "slow" | "fast" | "unknown";
export type Mode = "lite" | "full";
export interface Stored {
  mode: Mode;
  /** The day it was decided, YYYY-MM-DD. */
  at: string;
  by: "measured" | "hand";
}

/**
 * One arrival's frames (rAF timestamps, ms): the browser's own rhythm (`base` — the quick end of
 * its frames: 16.7ms on a 60Hz screen, 8.3 at 120Hz, 33.3 when a battery saver, a 30Hz screen or
 * a remote desktop caps it), and the share of frames that missed a beat of THAT rhythm.
 *
 * ⚠️⚠️ JUDGED AGAINST ITS OWN RHYTHM, NEVER AGAINST 60 (review, 2026-09-30). The first cut called
 * a steady 30 frames a second "slow" — every gap is 33ms — so Chrome's Energy Saver (on by
 * default at 20% battery) or Safari's Low Power Mode would have put a perfectly smooth laptop,
 * Brad's own included, on the lighter motion for a month. Steady is smooth; a STUTTER is a
 * frame that takes more than one beat.
 */
export function arrivalStats(frameTimes: number[]): { gaps: number; base: number; longShare: number; worst: number; asleep: boolean } {
  const gaps: number[] = [];
  for (let i = 1; i < frameTimes.length; i++) gaps.push(frameTimes[i]! - frameTimes[i - 1]!);
  const judged = gaps.slice(SKIP_GAPS);
  if (judged.length === 0) return { gaps: 0, base: 0, longShare: 0, worst: 0, asleep: false };
  const sorted = [...judged].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length * 0.2)]!;
  const longAt = Math.max(LONG_FRAME_MS, base * LONG_BEATS);
  return {
    gaps: judged.length,
    base,
    longShare: judged.filter((g) => g > longAt).length / judged.length,
    worst: sorted[sorted.length - 1]!,
    asleep: judged.some((g) => g > ASLEEP_MS),
  };
}

/** One arrival's frames → was this computer keeping up? */
export function judgeArrival(frameTimes: number[]): Verdict {
  const s = arrivalStats(frameTimes);
  // ⚠️ FEW FRAMES IS NOT "NOTHING TO JUDGE": the sample always runs its full `SAMPLE_MS` unless
  // the tab is hidden (that arrival is dropped before it gets here), so a handful of frames in
  // 1.5s IS the slow computer — measured at 20× CPU: 12 frames, 113ms apart.
  if (s.gaps === 0 || s.asleep) return "unknown";
  if (s.base > CLEAR_BASE_MS || s.longShare >= CLEAR_SHARE || s.worst >= CLEAR_FREEZE_MS) return "very-slow";
  return s.base > SLOW_BASE_MS || s.longShare >= SLOW_SHARE || s.worst > FREEZE_MS ? "slow" : "fast";
}

/** The arrivals so far → lite, full, or not decided yet. Unknowns count for nothing; one clearly
 *  slow arrival is enough. */
export function decide(verdicts: Verdict[]): Mode | null {
  if (verdicts.includes("very-slow")) return "lite";
  const slow = verdicts.filter((v) => v === "slow").length;
  const fast = verdicts.filter((v) => v === "fast").length;
  if (slow >= SLOW_OF) return "lite";
  if (fast >= SLOW_OF) return "full";
  return null;
}

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** What this browser remembered — null when nothing, unreadable, or due to be measured again. */
export function readStored(raw: string | null, today: string): Stored | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    if ((v.mode !== "lite" && v.mode !== "full") || typeof v.at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.at)) return null;
    const age = daysBetween(v.at, today);
    if (!Number.isFinite(age) || age < 0 || age >= RECHECK_DAYS) return null;
    return { mode: v.mode, at: v.at, by: v.by === "hand" ? "hand" : "measured" };
  } catch {
    return null;
  }
}

/** `?motion=lite|full|auto` → what the link asks for, else null. */
export function fromUrl(search: string): Mode | "auto" | null {
  const v = new URLSearchParams(search).get("motion");
  return v === "lite" || v === "full" || v === "auto" ? v : null;
}

// ── In the browser ─────────────────────────────────────────────────────────────

/** This computer's own day — a 30-day clock needs nothing finer. */
const today = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const store = {
  get(): string | null {
    try {
      return window.localStorage.getItem(MOTION_KEY);
    } catch {
      return null;
    }
  },
  set(v: Stored | null) {
    try {
      if (v) window.localStorage.setItem(MOTION_KEY, JSON.stringify(v));
      else window.localStorage.removeItem(MOTION_KEY);
    } catch {
      /* measured again next visit */
    }
  },
};

const html = () => document.documentElement;
const apply = (mode: Mode) => {
  if (mode === "lite") html().dataset.motion = "lite";
  else delete html().dataset.motion;
};
/** Said when lite switches on mid-visit. */
export const MOTION_LITE_EVENT = "h2-motion-lite";

let decided = false;
let sampling = false;
const verdicts: Verdict[] = [];
const seen: string[] = [];

/**
 * Before the first render (main.tsx), so the first board already moves the way this computer
 * can draw it.
 */
export function startMotionMode(): void {
  const day = today();
  const hand = fromUrl(window.location.search);
  if (hand === "auto") store.set(null);
  else if (hand) store.set({ mode: hand, at: day, by: "hand" });
  const stored = readStored(store.get(), day);
  if (stored) {
    decided = true;
    apply(stored.mode);
  }
}

/**
 * A board has just arrived (its sections are rising): time the frames for `SAMPLE_MS`. Does
 * nothing once this visit has decided, while another arrival is being timed, for someone on
 * reduced motion, or in a hidden tab.
 */
export function sampleArrival(): void {
  if (decided || sampling || typeof window === "undefined" || reducedMotion() || document.hidden) return;
  sampling = true;
  const times: number[] = [];
  // ⚠️ A hidden tab gets NO frames, so the sample simply resumes when it's shown again and the
  // whole absence reads as one long frame — `document.hidden` is already false by then. Any
  // visibility change during a sample makes that arrival say nothing.
  let hid = false;
  const onVis = () => {
    hid = true;
  };
  document.addEventListener("visibilitychange", onVis);
  const done = () => {
    sampling = false;
    document.removeEventListener("visibilitychange", onVis);
    if (decided) return;
    const v = hid || document.hidden ? "unknown" : judgeArrival(times);
    verdicts.push(v);
    // What it has seen, for anyone asking why a computer moves the way it does:
    // "fast 17ms 3%" = the browser's own frame, share of frames that missed a beat of it.
    const s = arrivalStats(times);
    seen.push(`${v} ${Math.round(s.base)}ms ${Math.round(s.longShare * 100)}%`);
    html().dataset.motionCheck = seen.join(" · ");
    const mode = decide(verdicts);
    if (!mode) return;
    decided = true;
    if (mode === "lite") {
      apply("lite");
      store.set({ mode: "lite", at: today(), by: "measured" });
      window.dispatchEvent(new Event(MOTION_LITE_EVENT));
    }
  };
  let start = -1;
  const tick = (now: number) => {
    if (start < 0) start = now;
    times.push(now);
    if (now - start < SAMPLE_MS && !document.hidden) requestAnimationFrame(tick);
    else done();
  };
  requestAnimationFrame(tick);
}
