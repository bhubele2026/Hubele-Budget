import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ⭐ URL STATE — a page's view (month, week/month/year, card, account) lives in
 * the address, so a refresh, a shared link and Back/Forward all land on the same
 * view. Writes use `history.replaceState` (a filter change is not a place you
 * go back to) and KEEP every other param (`tx`, `category`, …). `push: true` is
 * for a CHOICE of place (an account, a card): one history entry per choice, so
 * Back returns to the one before; a setter call can still pass `{ replace: true }`
 * (a self-heal that is not the person's choice).
 *
 * wouter patches `history.replaceState`/`pushState` to fire an event, so
 * `useSearch()` readers (the layout's section tabs) follow these writes.
 *
 * `codec.read` turns the raw param (or null) into a value, or null to use the
 * fallback; `codec.write` turns a value into the param text, or null to remove
 * the param (the default). A drop-in for `useState`: same setter shape, same
 * first-render value a hand-rolled `new URLSearchParams(...)` read gave.
 */
export interface UrlCodec<T> {
  read: (raw: string | null) => T | null;
  write: (value: T) => string | null;
}

/** `?a=1&b=2` with one param set (null removes it); the rest of the URL stays. */
export function withParam(search: string, key: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value == null) params.delete(key);
  else params.set(key, value);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Write one param to the address bar without adding a history entry. */
export function replaceUrlParam(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const next = `${pathname}${withParam(search, key, value)}${hash}`;
  if (next === `${pathname}${search}${hash}`) return;
  window.history.replaceState(window.history.state, "", next);
}

/**
 * Write one param as a NEW history entry: a place you can go Back to (a card or
 * an account the person chose). wouter patches `pushState`, so `useSearch()`
 * readers follow it, as they follow a link.
 */
export function pushUrlParam(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const next = `${pathname}${withParam(search, key, value)}${hash}`;
  if (next === `${pathname}${search}${hash}`) return;
  window.history.pushState(window.history.state, "", next);
}

/** Remove params (e.g. `tx` once handled) and keep the others. */
export function removeUrlParams(...keys: string[]): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(search);
  for (const k of keys) params.delete(k);
  const qs = params.toString();
  window.history.replaceState(window.history.state, "", `${pathname}${qs ? `?${qs}` : ""}${hash}`);
}

export function useUrlState<T>(
  key: string,
  codec: UrlCodec<T>,
  fallback: T | (() => T),
  /** `url: false` makes it a plain `useState` (a page embedded in another route). */
  opts: {
    url?: boolean;
    push?: boolean;
    /** What a Back/Forward onto an address with NO such param means (default: the
     * `fallback`). Chase passes the default account: a missing `?account=` is "no
     * pick", not the last saved one. */
    popFallback?: T | (() => T);
  } = {},
): [T, (next: T, how?: { replace?: boolean }) => void] {
  const useUrl = opts.url !== false;
  const codecRef = useRef(codec);
  codecRef.current = codec;
  const popRef = useRef(opts.popFallback);
  popRef.current = opts.popFallback;
  const read = useCallback((): T => {
    const raw =
      !useUrl || typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(key);
    const got = codecRef.current.read(raw);
    if (got != null) return got;
    return typeof fallback === "function" ? (fallback as () => T)() : fallback;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, useUrl]);
  const [value, setValue] = useState<T>(read);

  // The param text this hook last saw in the address: a link that pushes a new
  // one (a section tab, a row link) re-reads it; a push that leaves it alone
  // (the same page's own history entry) does not disturb the state.
  const seenRaw = useRef<string | null>(
    !useUrl || typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(key),
  );
  const push = opts.push === true;
  const set = useCallback(
    (next: T, how?: { replace?: boolean }) => {
      setValue(next);
      if (useUrl) {
        const text = codecRef.current.write(next);
        // Set first: the push event below must find the value already seen.
        const probe = new URLSearchParams(withParam(window.location.search, key, text));
        seenRaw.current = probe.get(key);
        if (push && !how?.replace) pushUrlParam(key, text);
        else replaceUrlParam(key, text);
      }
    },
    [key, useUrl, push],
  );

  // Back/Forward (and any other address change) re-reads the param.
  useEffect(() => {
    if (!useUrl) return;
    const onPop = () => {
      const raw = new URLSearchParams(window.location.search).get(key);
      seenRaw.current = raw;
      const pf = popRef.current;
      if (pf !== undefined && codecRef.current.read(raw) == null) {
        setValue(typeof pf === "function" ? (pf as () => T)() : pf);
        return;
      }
      setValue(read());
    };
    // A link inside the app (wouter's `pushState` event) that lands on this
    // page with a different param — the Amex card tabs — re-reads it too.
    const onPush = () => {
      const raw = new URLSearchParams(window.location.search).get(key);
      if (raw === seenRaw.current) return;
      seenRaw.current = raw;
      setValue(read());
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("pushState", onPush);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("pushState", onPush);
    };
  }, [read, useUrl, key]);

  return [value, set];
}
