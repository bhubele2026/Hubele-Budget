/**
 * Route-chunk importers and the hover/focus/idle prefetch, ported from the
 * classic app.
 *
 * The importer functions here are the SINGLE source of truth for each lazy
 * route's dynamic import: App.tsx's `lazy()` calls consume these exact
 * functions, so a prefetch can never warm a different chunk from the one the
 * route renders. `routes.test.tsx` holds App.tsx and this table in lockstep.
 *
 * ⚠️ NO `importToday`, DELIBERATELY. Today is where every open lands, so it is
 * in the entry; splitting it would only buy an extra round trip on the one
 * screen that must feel instant.
 */
export const importDesign = () => import("../screens/design/Design");
export const importPlaidOAuth = () => import("../screens/plaid-oauth/PlaidOAuth");

/** href → importer, keyed exactly as the routes are declared in App.tsx. */
export const routeImporters: Record<string, () => Promise<unknown>> = {
  "/design": importDesign,
  "/plaid-oauth": importPlaidOAuth,
};

const prefetched = new Set<string>();

/**
 * Warm the chunk for the route `href` maps to (longest matching key), once.
 * Safe to call on every hover/focus: deduped, and a failure clears the entry
 * so a later hover retries.
 */
export function prefetchRoute(href: string): void {
  if (typeof window === "undefined") return;
  let best: string | null = null;
  for (const key of Object.keys(routeImporters)) {
    if (href === key || href.startsWith(`${key}/`)) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  if (best === null || prefetched.has(best)) return;
  prefetched.add(best);
  const key = best;
  void routeImporters[key]!().catch(() => {
    prefetched.delete(key);
  });
}
