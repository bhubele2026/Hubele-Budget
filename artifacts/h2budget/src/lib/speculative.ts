import type { QueryClient } from "@tanstack/react-query";
import { hasMark, onMark } from "./perfMarks";

/**
 * ⭐ SPECULATIVE WORK WAITS FOR THE REAL NUMBERS (perf phase 2).
 *
 * Warming a page the person has not asked for (its chunk, its first data) is a
 * bet on the next click. It is only worth placing once the open has paid for
 * itself: on a throttled phone the layout's first-idle warm and the lazy panels
 * pulled 113 files / 654 KB at the very moment the four numbers were waiting on
 * their answers, and those answers queued behind them for ~3 s.
 *
 * So every speculative warm goes through `whenForegroundIdle`:
 *   1. the device and network can afford it (`warmAllowed`): never on Save-Data,
 *      a 2G/3G connection, or a device with ≤ 2 GB of memory;
 *   2. the page's own real-number marks have fired (`h2:home-numbers-ready`,
 *      `h2:weekly-pay-ready` on Home), or, if they never come (a failed read),
 *      `giveUpMs` has passed — after which the other rules still hold;
 *   3. the foreground is quiet: no query in flight, no lazy chunk loading
 *      (`trackChunk`, fed by `preloadImporter`), and no network response for
 *      `quietMs`; then one idle callback, and the same check again.
 *
 * Hover / focus / press prefetch (`warmRoute`) is intent, not speculation: it
 * never goes through here.
 */

type Nav = Navigator & {
  connection?: { saveData?: boolean; effectiveType?: string };
  deviceMemory?: number;
};

const SLOW = new Set(["slow-2g", "2g", "3g"]);

/** False when this device or connection should not spend anything on a guess. */
export function warmAllowed(): boolean {
  return warmAllowedFor(typeof navigator === "undefined" ? undefined : (navigator as Nav));
}

/** The rule itself, for a given navigator (tests). */
export function warmAllowedFor(nav: Nav | undefined): boolean {
  if (!nav) return false;
  const c = nav.connection;
  if (c?.saveData) return false;
  if (c?.effectiveType && SLOW.has(c.effectiveType)) return false;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 2) return false;
  return true;
}

// ── Foreground chunk loads ───────────────────────────────────────────────────
let chunks = 0;
/** Count `p` as a lazy chunk in flight until it settles. */
export function trackChunk<T>(p: Promise<T>): Promise<T> {
  chunks += 1;
  const done = () => {
    chunks -= 1;
  };
  p.then(done, done);
  return p;
}
export const chunksInFlight = (): number => chunks;

// ── The network's last answer (any resource, the API included) ─────────────
let lastResponseAt = -Infinity;
let observing = false;
function observeNetwork(): void {
  if (observing || typeof PerformanceObserver === "undefined" || typeof performance === "undefined") return;
  observing = true;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) lastResponseAt = Math.max(lastResponseAt, (e as PerformanceResourceTiming).responseEnd || e.startTime);
    }).observe({ type: "resource", buffered: true });
  } catch {
    /* no resource timing here: the query and chunk counts still hold the line */
  }
}
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ── Charts ───────────────────────────────────────────────────────────────────
// The chart library (vendor-charts, ~113 KB on the wire) is never fetched on a
// guess. Once a chart the person can see has pulled it in, warming a page that
// draws charts costs only that page's own chunk.
let charts = false;
/** Called at load by every module that imports recharts. */
export function noteChartsLoaded(): void {
  charts = true;
}
export const chartsLoaded = (): boolean => charts;

// ── The gate ─────────────────────────────────────────────────────────────────
export interface ForegroundIdleOptions {
  /** Marks of this page view that must have fired (lib/perfMarks). */
  marks?: readonly string[];
  /** The foreground must have been quiet this long. */
  quietMs: number;
  /** After this long the marks are no longer waited for (everything else still is). */
  giveUpMs?: number;
  /** How often the quiet is re-checked. */
  checkMs?: number;
}

/**
 * Calls `run` once, when speculation is allowed and the foreground is idle (see the
 * module doc). Returns a cancel: call it on unmount / navigation.
 */
export function whenForegroundIdle(qc: QueryClient, o: ForegroundIdleOptions, run: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  observeNetwork();
  const started = now();
  const checkMs = o.checkMs ?? 250;
  let timer: number | undefined;
  let idle: number | undefined;
  let done = false;
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };

  const marksIn = () => !o.marks || o.marks.every(hasMark) || (o.giveUpMs !== undefined && now() - started >= o.giveUpMs);
  const quiet = () => qc.isFetching() === 0 && chunks === 0 && now() - lastResponseAt >= o.quietMs;
  const ready = () => warmAllowed() && marksIn() && quiet();

  const fire = () => {
    idle = undefined;
    if (done) return;
    if (!ready()) return schedule();
    done = true;
    stopMarks();
    run();
  };
  const check = () => {
    timer = undefined;
    if (done) return;
    if (!ready()) return schedule();
    if (typeof w.requestIdleCallback === "function") idle = w.requestIdleCallback(fire, { timeout: 2_000 });
    else fire();
  };
  function schedule() {
    if (done || timer !== undefined) return;
    timer = window.setTimeout(check, checkMs);
  }
  // A mark arriving re-checks at once instead of at the next tick.
  const stopMarks = onMark(() => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (idle === undefined) schedule();
  });
  schedule();

  return () => {
    done = true;
    stopMarks();
    if (timer !== undefined) window.clearTimeout(timer);
    if (idle !== undefined) w.cancelIdleCallback?.(idle);
  };
}

/** Tests only. */
export function _resetSpeculativeForTests(): void {
  chunks = 0;
  lastResponseAt = -Infinity;
  charts = false;
}
