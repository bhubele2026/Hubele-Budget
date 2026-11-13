/**
 * The glide's pieces that only a page with switches and answers uses (Banking, Chase, Amex, Budget, Bills, Forecast):
 * their own module, so none of it rides the landing's entry graph.
 */
import { useLayoutEffect } from "react";
import { rowExit } from "./motion-extra";

/** ⭐ A row that is answered collapses away (motion-extra `rowExit`). A STABLE ref: React's cleanup is the hand-off. */
export const rowExitRef = (el: HTMLElement | null): (() => void) | undefined => (el ? () => rowExit(el) : undefined);

/**
 * ⭐ A SWITCH NEVER BLANKS THE PAGE (a month stepper, a range, a horizon). While the next answer loads the page's panels
 * DIM (the previous answer, or the page's own "loading" line, stays where it was); when it lands they come back up on
 * `--dur-fade`, so the new figures cross-fade in instead of cutting. Only the look moves: what is shown, and when, is
 * the page's own rule (index.css `[data-swapping]`).
 */
export function useSwapDim(busy: boolean): void {
  useLayoutEffect(() => {
    const host = document.querySelector<HTMLElement>("[data-page]");
    if (!host) return;
    if (busy) host.setAttribute("data-swapping", "");
    else host.removeAttribute("data-swapping");
    return () => host.removeAttribute("data-swapping");
  }, [busy]);
}

