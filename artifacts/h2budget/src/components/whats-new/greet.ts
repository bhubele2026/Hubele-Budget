/**
 * ⭐ (WN) WHEN THE WHAT'S NEW SHEET GREETS — after the page has come in and
 * gone quiet, and never over something the person is in the middle of.
 *
 *   1. At least GREET_MIN_MS after the host mounts (they see the page first).
 *   2. A quiet moment: no request in flight for QUIET_MS (on the dashboard,
 *      after the panels below the fold have settled), then an idle callback.
 *      A page that never goes quiet stops being waited for after MAX_WAIT_MS.
 *   3. Nothing in the way (`greetBlocker`): a hidden tab, an open dialog,
 *      sheet, drawer, menu or list, Clerk's account popover, Plaid Link, a
 *      focused field, the bank's OAuth return page, or (in production) a
 *      version check that has not answered or a reload that is coming. Held,
 *      it looks again every RECHECK_MS and when the tab comes back.
 *   4. The host then asks the server again before it opens (a note read on
 *      another device never pops up).
 *
 * Lazy (the host's chunk): nothing here is on the open path.
 */

export const GREET_MIN_MS = 1500;
export const QUIET_MS = 600;
export const QUIET_POLL_MS = 100;
export const IDLE_TIMEOUT_MS = 2000;
export const MAX_WAIT_MS = 15_000;
export const RECHECK_MS = 1500;

/** Open overlays that own the person's attention (Radix dialogs/sheets/drawer, menus, lists, Clerk's popover). */
const OVERLAY =
  '[role="dialog"][data-state="open"],[role="alertdialog"],[role="menu"],[role="listbox"],.cl-userButtonPopoverCard,.cl-modalBackdrop';

function shown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden";
}

/** Typing: focus is in a field. */
export function isTyping(doc: Document = document): boolean {
  const ae = doc.activeElement as HTMLElement | null;
  if (!ae || ae === doc.body) return false;
  const tag = ae.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable === true;
}

export type GreetBlock = "hidden" | "overlay" | "plaid" | "typing" | "route" | "version";

/**
 * Why the sheet may not open right now, or null. `version`: "waiting" while a
 * production version check has not answered, "outdated" when a reload is
 * coming; "ok" otherwise (and always in dev and tests).
 */
export function greetBlocker(opts: {
  path: string;
  version: "ok" | "waiting" | "outdated";
  doc?: Document;
}): GreetBlock | null {
  const doc = opts.doc ?? document;
  if (doc.visibilityState === "hidden") return "hidden";
  if (doc.querySelector(OVERLAY)) return "overlay";
  if (doc.querySelector('[data-testid="version-update-banner"]')) return "version";
  for (const f of Array.from(doc.querySelectorAll('iframe[id^="plaid-link-iframe"]'))) if (shown(f)) return "plaid";
  if (isTyping(doc)) return "typing";
  if (opts.path.startsWith("/plaid-oauth")) return "route";
  if (opts.version !== "ok") return "version";
  return null;
}

type Idle = (cb: () => void, opts: { timeout: number }) => number;
type CancelIdle = (id: number) => void;

/**
 * Run `greet` once the page is quiet and nothing blocks it. `isQuiet` = no
 * request in flight. `blocker` is asked right before each attempt; `greet` may
 * answer false (blocked after all, e.g. a dialog opened while it re-asked the
 * server) and the wait resumes. Returns a cancel.
 */
export function scheduleGreet(opts: {
  isQuiet: () => boolean;
  blocker: (waitedMs: number) => GreetBlock | null;
  greet: () => Promise<boolean> | boolean;
  doc?: Document;
}): () => void {
  const doc = opts.doc ?? document;
  const win = doc.defaultView ?? window;
  const started = Date.now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleId: number | null = null;
  let quietSince: number | null = null;
  let attempting = false;
  /** Past the quiet wait and held by a blocker: a tab coming back looks again at once. */
  let held = false;

  const idle: Idle =
    typeof (win as { requestIdleCallback?: Idle }).requestIdleCallback === "function"
      ? (cb, o) => (win as unknown as { requestIdleCallback: Idle }).requestIdleCallback(cb, o)
      : (cb) => win.setTimeout(cb, 1) as unknown as number;
  const cancelIdle: CancelIdle =
    typeof (win as { cancelIdleCallback?: CancelIdle }).cancelIdleCallback === "function"
      ? (id) => (win as unknown as { cancelIdleCallback: CancelIdle }).cancelIdleCallback(id)
      : (id) => win.clearTimeout(id);

  const later = (fn: () => void, ms: number) => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!cancelled) fn();
    }, ms);
  };

  const attempt = async () => {
    if (cancelled || attempting) return;
    if (opts.blocker(Date.now() - started) != null) {
      held = true;
      later(attempt, RECHECK_MS);
      return;
    }
    held = false;
    attempting = true;
    let done = false;
    try {
      done = await opts.greet();
    } catch {
      done = true; // the re-ask failed: no greeting this time
    } finally {
      attempting = false;
    }
    if (done) stop();
    else if (!cancelled) {
      held = true;
      later(attempt, RECHECK_MS);
    }
  };

  const waitQuiet = () => {
    const now = Date.now();
    if (opts.isQuiet()) quietSince ??= now;
    else quietSince = null;
    const quietLongEnough = quietSince != null && now - quietSince >= QUIET_MS;
    if (quietLongEnough || now - started >= MAX_WAIT_MS) {
      idleId = idle(() => {
        idleId = null;
        if (!cancelled) void attempt();
      }, { timeout: IDLE_TIMEOUT_MS });
      return;
    }
    later(waitQuiet, QUIET_POLL_MS);
  };

  const onVisible = () => {
    // Back on the tab while held: look again now rather than at the next tick.
    if (doc.visibilityState === "visible" && held && !attempting && !cancelled) later(attempt, 0);
  };
  doc.addEventListener("visibilitychange", onVisible);

  later(waitQuiet, GREET_MIN_MS);

  function stop() {
    cancelled = true;
    if (timer != null) clearTimeout(timer);
    if (idleId != null) cancelIdle(idleId);
    doc.removeEventListener("visibilitychange", onVisible);
  }
  return stop;
}
