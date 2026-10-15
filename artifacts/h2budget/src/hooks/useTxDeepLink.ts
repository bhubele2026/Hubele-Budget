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
/** (Q6b) How long a loaded ledger may lack the row before the link is dropped. */
export const GIVE_UP_MS = 1500;

/**
 * (Q6b r3) Has this scope's ledger been READ? Only a successful, current-scope,
 * settled fetch counts: a failed fetch (TanStack v5 then has isLoading and
 * isFetching both false) must keep the link, so a reload still opens the row.
 */
export function ledgerLoaded(q: { isLoading: boolean; isSuccess: boolean; isPlaceholderData: boolean; isFetching: boolean }): boolean {
  return !q.isLoading && q.isSuccess && !q.isPlaceholderData && !q.isFetching;
}

export function useTxDeepLink({
  ready,
  rowTestIds,
  scrolledRef,
  scroll = true,
  loaded = false,
  scopeKey,
  onGiveUp,
  deps = [],
}: {
  ready: boolean;
  rowTestIds: (id: string) => string[];
  scrolledRef?: MutableRefObject<boolean>;
  /** false: a page that does its own single scroll (Amex) only gets the param stripped and the focus pulse. */
  scroll?: boolean;
  /**
   * (Q6b) The current scope's ledger has finished loading. A row still absent
   * after a short wait is not coming: the link is dropped (see `onGiveUp`).
   */
  loaded?: boolean;
  /** (Q6b) The scope the link was opened in (the card). A change before the row appeared drops the link. */
  scopeKey?: unknown;
  /** (Q6b) The link was dropped: the param is gone from the URL; clear any "for the row you opened" words. */
  onGiveUp?: () => void;
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
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const giveUpRef = useRef(onGiveUp);
  giveUpRef.current = onGiveUp;
  useEffect(() => () => {
    if (pulse.current) clearTimeout(pulse.current);
    if (wait.current) clearTimeout(wait.current);
  }, []);

  /** Drop a link whose row is not coming: strip `tx`, end the focus, tell the page. */
  const giveUp = () => {
    if (handled.current) return;
    handled.current = true;
    if (wait.current) clearTimeout(wait.current);
    const params = new URLSearchParams(window.location.search);
    params.delete("tx");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    setFocusId(null);
    giveUpRef.current?.();
  };

  // The card (scope) changed before the row appeared: the link no longer applies.
  const firstScope = useRef(scopeKey);
  useEffect(() => {
    if (firstScope.current === scopeKey) return;
    firstScope.current = scopeKey;
    if (focusId && !handled.current) giveUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  useEffect(() => {
    // (Q6b r3) The ledger started loading again inside the wait: that wait no longer counts. A row
    // that arrives in the second load must still be found; the wait restarts when it has loaded.
    if (!loaded && wait.current) {
      clearTimeout(wait.current);
      wait.current = null;
    }
    if (!focusId || handled.current || !ready) return;
    const find = (): HTMLElement | null => {
      const found = rowTestIds(focusId)
        // An attribute selector needs only `"` and `\` escaped (and needs no
        // `CSS.escape`, which some test DOMs lack).
        .map((t) => document.querySelector<HTMLElement>(`[data-testid="${t.replace(/["\\]/g, "\\$&")}"]`))
        .filter((el): el is HTMLElement => el != null);
      return found.find((el) => el.offsetParent !== null) ?? found[0] ?? null;
    };
    // One scroll, once the row exists: a row that is not there yet (its month is
    // still loading) leaves the link armed for the next render of `deps`.
    const settle = () => {
      const el = find();
      if (!el || handled.current) return false;
      handled.current = true;
      if (wait.current) clearTimeout(wait.current);
      if (scroll) el.scrollIntoView?.({ behavior: "smooth", block: "center" });
      if (scrolledRef) scrolledRef.current = true;
      const params = new URLSearchParams(window.location.search);
      params.delete("tx");
      const qs = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
      pulse.current = setTimeout(() => setFocusId(null), 2000);
      return true;
    };
    requestAnimationFrame(() => {
      if (!settle()) requestAnimationFrame(() => void settle());
    });
    // The ledger is loaded and the row is not in it: wait a moment, then drop the link.
    if (loaded && !wait.current && !find()) {
      wait.current = setTimeout(() => {
        wait.current = null;
        if (loadedRef.current && !find()) giveUp();
      }, GIVE_UP_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, ready, loaded, ...deps]);

  return focusId;
}
