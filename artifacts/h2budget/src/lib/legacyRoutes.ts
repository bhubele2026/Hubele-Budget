/**
 * ⭐ OLD LINKS STILL LAND (the switch, 2026-10-09).
 *
 * Until the switch, `/` served the interim H2 app, whose routes are gone with
 * it. Bookmarks, a phone's home-screen icon, texts and emails may still carry
 * them, so each one is mapped to the page of this app that holds the same
 * thing. Read only by the not-found page (a lazy chunk), so the table costs
 * the open path nothing: a known old path redirects, anything else is a 404.
 *
 * `/ask`, `/plaid-oauth`, `/sign-in` and `/sign-up` exist here under the same
 * paths and need no entry.
 */
const EXACT: Readonly<Record<string, string>> = {
  "/today": "/home",
  "/activity": "/review/categories",
  "/activity/review": "/review/categories",
  "/activity/rules": "/mapping-rules",
  "/plan": "/allowances",
  "/plan/bills": "/bills",
  "/plan/debt": "/avalanche",
  "/plan/categories": "/budget",
  "/plan/wishlist": "/wishlist",
  "/plan/proposals": "/review/suggestions",
  "/ask/memory": "/settings?tab=memory",
  "/household": "/settings?tab=household",
  "/household/members": "/settings?tab=household",
  "/household/ai": "/settings?tab=ai",
  "/household/automation": "/settings?tab=automation",
  "/recap": "/settings?tab=morning-text",
};

/**
 * Where an old path now lives, or null when it was never one.
 * - `/activity?txn=<id>` (the interim Ask answers linked a transaction so)
 *   opens that transaction on Chase: `/transactions?tx=<id>`.
 * - `/design` and its sample pages were made-up data: the dashboard.
 * - A trailing slash is ignored.
 */
export function legacyTarget(pathname: string, search = ""): string | null {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (p === "/activity") {
    const txn = new URLSearchParams(search).get("txn");
    if (txn) return `/transactions?tx=${encodeURIComponent(txn)}`;
  }
  if (p === "/design" || p.startsWith("/design/")) return "/home";
  return EXACT[p] ?? null;
}
