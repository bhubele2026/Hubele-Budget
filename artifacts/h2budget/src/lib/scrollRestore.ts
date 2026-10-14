/**
 * ⭐ SCROLL RESTORATION for the shell's one scroller (`<main data-shell-scroller>`).
 *
 * - A new push (a link click) starts at the top.
 * - Back/Forward (popstate) puts you where you were on that URL (path + search),
 *   once the page's data has made the scroller tall enough: it retries on
 *   animation frames and gives up after ~1.5 s. Touching the page (wheel, touch,
 *   key, pointer) cancels it — the person is in charge.
 * - Offsets live in sessionStorage per URL, so a refresh keeps them too.
 *
 * Installed once by the layout. wouter patches `history.pushState` /
 * `replaceState` to fire events of the same name, which is what this listens to.
 * `replaceState` (a filter change, `?tx=` stripped) re-keys the page WITHOUT
 * saving or resetting: it is the same history entry.
 */
const STORE_KEY = "h2budget:scroll-by-url";
const MAX_ENTRIES = 60;
export const RESTORE_GIVE_UP_MS = 1500;
/** Frames the offset must hold for before a restore is called done (late content can clamp it). */
const HOLD_FRAMES = 8;

const INTERRUPTS = ["wheel", "touchstart", "pointerdown"] as const;

type Store = Record<string, number>;

function readStore(): Store {
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete store[k];
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* storage blocked: scroll restoration is a convenience */
  }
}

const urlKey = () => `${window.location.pathname}${window.location.search}`;

export function installScrollRestoration(getScroller: () => HTMLElement | null): () => void {
  let routeKey = urlKey();
  let top = 0;
  let cancel: (() => void) | null = null;

  const scroller = () => getScroller();

  const onScroll = () => {
    const el = scroller();
    if (el && urlKey() === routeKey) top = el.scrollTop;
  };

  const save = () => {
    if (top <= 0) {
      const store = readStore();
      if (routeKey in store) {
        delete store[routeKey];
        writeStore(store);
      }
      return;
    }
    const store = readStore();
    delete store[routeKey]; // re-insert last: the cap drops the oldest
    store[routeKey] = top;
    writeStore(store);
  };

  const restore = (target: number) => {
    cancel?.();
    const el = scroller();
    if (!el) return;
    if (target <= 0) {
      el.scrollTop = 0; // nothing saved: a page we left at the top opens at the top
      return;
    }
    const started = performance.now();
    let held = 0;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const ev of INTERRUPTS) el.removeEventListener(ev, stop);
      window.removeEventListener("keydown", stop);
      if (cancel === stop) cancel = null;
    };
    for (const ev of INTERRUPTS) el.addEventListener(ev, stop, { passive: true });
    window.addEventListener("keydown", stop);
    cancel = stop;
    const tick = () => {
      const tall = el.scrollHeight - el.clientHeight >= target;
      if (tall) {
        if (Math.abs(el.scrollTop - target) > 1) {
          el.scrollTop = target;
          top = el.scrollTop; // (the scroll event follows later; keep our own count true)
          held = 0;
        } else if (++held >= HOLD_FRAMES) return stop();
      }
      if (performance.now() - started >= RESTORE_GIVE_UP_MS) return stop();
      raf = requestAnimationFrame(tick);
    };
    tick();
  };

  const onPush = () => {
    cancel?.();
    const next = urlKey();
    if (next === routeKey) return;
    save();
    routeKey = next;
    top = 0;
    const el = scroller();
    if (el) el.scrollTop = 0;
  };

  const onPop = () => {
    const next = urlKey();
    if (next !== routeKey) save();
    routeKey = next;
    top = 0;
    restore(readStore()[next] ?? 0);
  };

  const onReplace = () => {
    // Same history entry, new address: carry the offset, save nothing.
    routeKey = urlKey();
  };

  // `scroll` does not bubble: one capture listener on the window hears the
  // scroller whenever it mounts.
  const winScroll = (e: Event) => {
    if (e.target === scroller()) onScroll();
  };
  window.addEventListener("scroll", winScroll, { capture: true, passive: true });
  window.addEventListener("pushState", onPush);
  window.addEventListener("popstate", onPop);
  window.addEventListener("replaceState", onReplace);
  window.addEventListener("pagehide", save);
  return () => {
    cancel?.();
    window.removeEventListener("scroll", winScroll, { capture: true });
    window.removeEventListener("pushState", onPush);
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("replaceState", onReplace);
    window.removeEventListener("pagehide", save);
  };
}
