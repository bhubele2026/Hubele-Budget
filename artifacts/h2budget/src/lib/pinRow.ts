/**
 * (Q6b) Keep a row we just scrolled to where it landed while the page settles.
 *
 * A deep link scrolls once, but content above the row can still change height a
 * moment later (a skeleton becomes the chart, a summary fills in) and slide the
 * row away. For a short window each frame compares the row's top with where it
 * landed and, if the page moved it, scrolls it back to the same place. The first
 * thing the person does (wheel, touch, key, click) ends it: their scroll wins.
 *
 * With `clearance`, the row is held against a LIVE line instead of where it first
 * landed: the bottom of the sticky stack, measured on every frame (`stickyClearance`).
 * The pinned pane's height lags the layout (`--page-sticky-top` is set a render
 * later), so the first landing can sit under the day head; the live line cannot.
 * Returns a cancel function.
 */
export function pinRowInView(
  find: () => HTMLElement | null,
  opts: { ms?: number; clearance?: (row: HTMLElement) => number | null } | number = {},
): () => void {
  const { ms = 2500, clearance } = typeof opts === "number" ? { ms: opts } : opts;
  if (typeof window === "undefined" || typeof requestAnimationFrame === "undefined") return () => undefined;
  let done = false;
  let want: number | null = null;
  const start = performance.now();
  const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const stop = () => {
    done = true;
    for (const e of events) window.removeEventListener(e, stop, true);
  };
  for (const e of events) window.addEventListener(e, stop, { capture: true, passive: true });
  const tick = () => {
    if (done) return;
    if (performance.now() - start > ms) return stop();
    const el = find();
    if (el) {
      const top = el.getBoundingClientRect().top;
      const live = clearance ? clearance(el) : null;
      if (live != null) {
        // Hold the row's top at the live bottom of the sticky stack.
        if (Math.abs(top - live) > 1) scrollByIn(el, top - live);
      } else if (want == null) want = top;
      else if (Math.abs(top - want) > 2) {
        el.scrollIntoView?.({ block: "start" });
        want = el.getBoundingClientRect().top;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return stop;
}

/** The nearest ancestor that scrolls vertically, or null for the window. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

function scrollByIn(el: HTMLElement, dy: number): void {
  const sc = scrollerOf(el);
  if (sc) sc.scrollTop += dy;
  else window.scrollBy(0, dy);
}

/**
 * The viewport y just under the sticky stack a ledger row sits beneath, from
 * LIVE sizes: the scroll port's top, the pinned pane's height right now and the
 * row's own day head (it sticks under the pane). Null when the pane is gone.
 */
export function stickyClearance(row: HTMLElement, pane: HTMLElement | null, gap = 8): number | null {
  if (!pane) return null;
  const sc = scrollerOf(row);
  const portTop = sc ? sc.getBoundingClientRect().top + sc.clientTop : 0;
  const head = row.closest("[data-day-group]")?.querySelector<HTMLElement>('[data-testid^="day-head-"]');
  return portTop + pane.offsetHeight + (head?.offsetHeight ?? 0) + gap;
}
