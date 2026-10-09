import { useEffect, useRef, useState, type MutableRefObject } from "react";

/**
 * (F8) `?tx=<id>` on a ledger page: once the rows are on screen, scroll the
 * matching row into view, then strip the param so a reload does not do it
 * again (other params, like `?month=`, stay). The Chase page has had this
 * since #488 (CH-09); Amex takes it from here, so an Ask answer's charge link
 * can land on either ledger.
 *
 * `rowTestIds(id)` lists the row's test ids in preference order — Amex renders
 * a desktop and a phone tree, and only one is visible; the first VISIBLE one
 * wins, else the first that exists. `scrolledRef` is the page's "scrolled to
 * today" latch: setting it stops that scroll from pulling the view away.
 *
 * Returns the id while its row should read as focused (about two seconds).
 */
export function useTxDeepLink({
  ready,
  rowTestIds,
  scrolledRef,
  deps = [],
}: {
  ready: boolean;
  rowTestIds: (id: string) => string[];
  scrolledRef?: MutableRefObject<boolean>;
  deps?: readonly unknown[];
}): string | null {
  const [focusId, setFocusId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("tx");
  });
  const handled = useRef(false);
  // The pulse timer outlives re-runs of the effect below (a page that passes
  // `deps` re-runs it as rows arrive); only unmount cancels it.
  const pulse = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pulse.current) clearTimeout(pulse.current);
  }, []);

  useEffect(() => {
    if (!focusId || handled.current || !ready) return;
    const find = (): HTMLElement | null => {
      const found = rowTestIds(focusId)
        // An attribute selector needs only `"` and `\` escaped (and needs no
        // `CSS.escape`, which some test DOMs lack).
        .map((t) => document.querySelector<HTMLElement>(`[data-testid="${t.replace(/["\\]/g, "\\$&")}"]`))
        .filter((el): el is HTMLElement => el != null);
      return found.find((el) => el.offsetParent !== null) ?? found[0] ?? null;
    };
    const tryScroll = () => {
      const el = find();
      if (!el) return false;
      el.scrollIntoView?.({ behavior: "smooth", block: "center" });
      if (scrolledRef) scrolledRef.current = true;
      return true;
    };
    requestAnimationFrame(() => {
      if (!tryScroll()) requestAnimationFrame(() => void tryScroll());
    });
    handled.current = true;
    const params = new URLSearchParams(window.location.search);
    params.delete("tx");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    pulse.current = setTimeout(() => setFocusId(null), 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, ready, ...deps]);

  return focusId;
}
