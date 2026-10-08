/**
 * ⭐ THE SHELL'S SCROLLER. Inside the signed-in shell `<main>` is the only
 * vertical scroller (`components/layout.tsx`; the `html` note in `index.css`).
 * The window never scrolls there — `window.scrollY` stays 0 — so a window
 * virtualizer, a scroll spy or a `window.scrollTo` silently does nothing.
 * Code that needs the scroller finds it here, by the attribute the shell puts
 * on `<main>`, never by tag name or by assuming the window.
 */
export const SHELL_SCROLLER_ATTR = "data-shell-scroller";

/** The shell scroller `el` lives in, or null outside the shell (sign-in, tests). */
export function shellScrollerOf(el: Element | null | undefined): HTMLElement | null {
  return el?.closest<HTMLElement>(`[${SHELL_SCROLLER_ATTR}]`) ?? null;
}

/**
 * How far down the scroller's content `el` starts, in px — the virtualizer's
 * `scrollMargin`. Rect delta plus the current scroll, so it reads the same
 * wherever the scroller happens to be scrolled when it is measured.
 */
export function offsetWithinScroller(el: Element, scroller: HTMLElement): number {
  const top = el.getBoundingClientRect().top;
  const origin = scroller.getBoundingClientRect().top + scroller.clientTop;
  return Math.round(top - origin + scroller.scrollTop);
}
