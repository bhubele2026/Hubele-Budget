/**
 * (2026-11-12) Brad: "I NEED THE LANDING TO BE ON DASH". The app's own entry
 * points already open on /home, but the browser kept re-opening a bare
 * /banking (address-bar autocomplete, a bookmark, a restored tab). A FRESH
 * open of bare /banking now lands on the Dashboard.
 *
 * Kept on Banking: a reload, an open from another page of this app (same-origin
 * referrer), and any link with a query or a hash (e.g. /banking#needs-you).
 */
export function freshOpenTarget(input: {
  path: string;
  search: string;
  hash: string;
  navType: string | undefined;
  referrer: string;
  origin: string;
}): "/home" | null {
  const path = input.path.replace(/\/+$/, "") || "/";
  if (path !== "/banking") return null;
  if (input.search || input.hash) return null;
  if (input.navType === "reload") return null;
  if (input.referrer) {
    try {
      if (new URL(input.referrer).origin === input.origin) return null;
    } catch {
      /* unreadable referrer: treat as outside */
    }
  }
  return "/home";
}

/** Rewrites the address before the router reads it. Never throws. */
export function sendFreshBankingOpenHome(basePath: string): void {
  try {
    let path = window.location.pathname;
    if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length) || "/";
    const nav = performance.getEntriesByType?.("navigation")?.[0] as
      | PerformanceNavigationTiming
      | undefined;
    const target = freshOpenTarget({
      path,
      search: window.location.search,
      hash: window.location.hash,
      navType: nav?.type,
      referrer: document.referrer,
      origin: window.location.origin,
    });
    if (target) window.history.replaceState(window.history.state, "", `${basePath}${target}`);
  } catch {
    /* never block the open */
  }
}
