/**
 * The parts of the glide that only run AFTER a click (lib/motion.ts loads this chunk once the first page is up — the
 * landing's entry graph has no room for it). Until it is in, these simply do not run: a selection or a row changes as it
 * always did. Pure DOM; each one stands down for reduced motion.
 */
import { cssMs, reducedMotion } from "./motion";

const ARRIVE = "cubic-bezier(0.22,0.61,0.36,1)";
const TRAVEL = "cubic-bezier(0.45,0,0.55,1)";

/**
 * ⭐ A SKELETON NEVER CUTS TO ITS CONTENT. Just before React removes it, its live content moves into a bare stand-in laid
 * over the same place (fixed, clipped to the page's scroller, under the top bar) that fades out on `--dur-in` while the
 * real content arrives beneath it. Nothing waits on it: it takes no pointer and is hidden from assistive tech.
 * Pure DOM; a stand-in inside another stand-in never hands off twice.
 */
export function ghostOut(el: HTMLElement): (() => void) | null {
  if (!el.isConnected || reducedMotion() || el.closest("[data-exit-ghost]") || typeof el.animate !== "function") return null;
  const scroller = el.closest<HTMLElement>("[data-shell-scroller]");
  const r = el.getBoundingClientRect();
  const box = scroller?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  if (r.width === 0 || r.height === 0 || r.bottom < box.top || r.top > box.top + box.height) return null;
  const clip = document.createElement("div");
  clip.setAttribute("data-exit-ghost", "");
  clip.setAttribute("aria-hidden", "true");
  clip.inert = true;
  clip.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;overflow:hidden;pointer-events:none;z-index:20`;
  const stand = el.cloneNode(false) as HTMLElement;
  for (const a of stand.getAttributeNames()) if (a === "id" || a.startsWith("data-")) stand.removeAttribute(a);
  while (el.firstChild) stand.appendChild(el.firstChild);
  stand.style.cssText += `;position:absolute;margin:0;left:${r.left - box.left}px;top:${r.top - box.top}px;width:${r.width}px;height:${r.height}px`;
  clip.appendChild(stand);
  document.body.appendChild(clip);
  const anim = stand.animate([{ opacity: 1 }, { opacity: 0 }], { duration: cssMs("--dur-in", 240), easing: ARRIVE, fill: "forwards" });
  const drop = () => clip.remove();
  anim.onfinish = drop;
  anim.oncancel = drop;
  return () => {
    anim.cancel();
    while (stand.firstChild) el.appendChild(stand.firstChild);
  };
}


/**
 * ⭐ A ROW THAT IS ANSWERED LEAVES WITH A SHORT COLLAPSE (Needs you's OK, a row resolved): just before React removes
 * it, its live content moves into a stand-in at the same place in the list that fades, then folds its height to
 * nothing (`--dur-in` × 1.5), so the rows under it glide up instead of jumping. `rowExitRef` (lib/motion.ts) calls it from the
 * cleanup React runs when the row is removed.
 */
export function rowExit(el: HTMLElement): void {
  if (!el.isConnected || !el.parentNode || reducedMotion() || el.closest("[data-exit-ghost]") || typeof el.animate !== "function") return;
  const h = el.getBoundingClientRect().height;
  if (h === 0) return;
  const stand = el.cloneNode(false) as HTMLElement;
  for (const a of stand.getAttributeNames()) if (a === "id" || a.startsWith("data-") || a.startsWith("aria-")) stand.removeAttribute(a);
  stand.setAttribute("data-exit-ghost", "");
  stand.setAttribute("aria-hidden", "true");
  stand.inert = true;
  while (el.firstChild) stand.appendChild(el.firstChild);
  stand.style.overflow = "hidden";
  stand.style.pointerEvents = "none";
  stand.style.boxSizing = "border-box";
  el.parentNode.insertBefore(stand, el.nextSibling);
  const cs = getComputedStyle(stand);
  const a = stand.animate(
    [
      { opacity: 1, height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
      { opacity: 0, height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, offset: 0.4 },
      { opacity: 0, height: "0px", paddingTop: "0px", paddingBottom: "0px" },
    ],
    { duration: cssMs("--dur-in", 240) * 1.5, easing: TRAVEL },
  );
  const drop = () => stand.remove();
  a.onfinish = drop;
  a.oncancel = drop;
}


/**
 * ⭐ A SELECTION TRAVELS (segmented controls, period switches): when the pressed segment of a group moves, the white
 * pill glides from the old segment to the new one on `--dur-travel` / `--ease-travel` (transform only) instead of
 * jumping. The segments keep their own classes; the travelling pill is a copy of the new one's look laid under the
 * words for the length of the glide.
 */
export function slidePill(g: HTMLElement, was: HTMLElement, on: HTMLElement): void {
  if (!was.isConnected || reducedMotion() || typeof on.animate !== "function") return;
  const from = was.getBoundingClientRect();
  const to = on.getBoundingClientRect();
  const gr = g.getBoundingClientRect();
  if (to.width === 0 || Math.abs(from.top - to.top) > 2) return;
  const cs = getComputedStyle(on);
  const pill = document.createElement("span");
  pill.setAttribute("aria-hidden", "true");
  pill.setAttribute("data-seg-pill", "");
  pill.style.cssText = `position:absolute;z-index:-1;pointer-events:none;left:${to.left - gr.left - g.clientLeft}px;top:${to.top - gr.top - g.clientTop}px;width:${to.width}px;height:${to.height}px;border-radius:${cs.borderRadius};background:${cs.backgroundColor};box-shadow:${cs.boxShadow};transform-origin:0 0`;
  const prev = { pos: g.style.position, iso: g.style.isolation, bg: on.style.backgroundColor, sh: on.style.boxShadow, tp: on.style.transitionProperty };
  if (getComputedStyle(g).position === "static") g.style.position = "relative";
  g.style.isolation = "isolate";
  // Only the words' colour eases; the segment's own white waits under the travelling pill.
  on.style.transitionProperty = "color";
  on.style.backgroundColor = "transparent";
  on.style.boxShadow = "none";
  g.appendChild(pill);
  const a = pill.animate(
    [{ transform: `translateX(${from.left - to.left}px) scaleX(${from.width / to.width})` }, { transform: "none" }],
    { duration: cssMs("--dur-travel", 600), easing: TRAVEL },
  );
  const end = () => {
    pill.remove();
    g.style.position = prev.pos;
    g.style.isolation = prev.iso;
    on.style.backgroundColor = prev.bg;
    on.style.boxShadow = prev.sh;
    on.style.transitionProperty = prev.tp;
  };
  a.onfinish = end;
  a.oncancel = end;
}

/**
 * ⭐ THE LIT TAB'S UNDERLINE TRAVELS from the tab you left to the one you picked (transform only, `--dur-travel`). In a
 * page cross-fade the browser moves it instead (its own `view-transition-name`, index.css), so this stands down then.
 */
export function travelLine(u: HTMLElement, was: { left: number; width: number }, now: { left: number; width: number }): void {
  if (was.left === now.left || now.width === 0 || reducedMotion() || document.documentElement.dataset["vt"] || typeof u.animate !== "function") return;
  u.animate(
    [{ transform: `translateX(${was.left - now.left}px) scaleX(${was.width / now.width})` }, { transform: "none" }],
    { duration: cssMs("--dur-travel", 600), easing: TRAVEL },
  );
}

