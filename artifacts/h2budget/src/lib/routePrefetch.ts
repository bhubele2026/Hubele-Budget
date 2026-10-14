// (#perf) Route-CHUNK prefetch. Each page is code-split (see App.tsx's
// `lazy()` calls), so the *first* visit to a route pays a network round-trip to
// stream in that route's JS chunk before it can render — the visible lag on a
// deliberate click. This module warms those chunks ahead of the click: on nav
// hover/focus and on idle after first paint. By the time the user clicks, the
// chunk is already in the browser cache and the page mounts instantly.
//
// The importer functions here are the SINGLE source of truth for each route's
// dynamic import — App.tsx consumes these exact same functions in its `lazy()`
// calls, so the prefetch map can never drift from what actually renders (a
// hover that warms one chunk while the route renders another would be a silent
// waste). Import specifiers are relative to this file (`../pages/...`); they
// resolve to the same modules App.tsx references (`./pages/...`), so the
// bundler emits one shared chunk per page.

import { loadedModule, preloadImporter } from "./lazyWithPreload";

// ── Per-page importers (reused by App.tsx's lazy() calls) ────────────────────
// ⚠️ NO IMPORTER FOR THE LANDING HERE, DELIBERATELY. The landing (/home) is the
// dashboard page, statically imported by App.tsx: it is the default destination
// of every open, so code-splitting it only bought a guaranteed extra round trip
// on the one route that must feel instant. Nothing to prefetch when the chunk
// is already the entry.
export const importCommandCenter = () => import("../pages/command-center");
export const importForecast = () => import("../pages/forecast");
export const importForecastOverview = () => import("../pages/forecast-overview");
export const importReports = () => import("../pages/reports");
export const importReportsDebt = () => import("../pages/reports/DebtPage");
export const importReportsCashFlow = () => import("../pages/reports/CashFlowPage");
export const importReportsSpending = () => import("../pages/reports/SpendingPage");
export const importReportsBudget = () => import("../pages/reports/BudgetPage");
export const importReportsBehavior = () => import("../pages/reports/BehaviorPage");
export const importDebts = () => import("../pages/debts");
export const importAvalanche = () => import("../pages/avalanche");
export const importReviewCategories = () => import("../pages/review-categories");
export const importAmex = () => import("../pages/amex");
export const importTransactions = () => import("../pages/transactions");
export const importBills = () => import("../pages/bills");
export const importBillsOverview = () => import("../pages/bills-overview");
export const importBudget = () => import("../pages/budget");
export const importAllowances = () => import("../pages/allowances");
// (W1) This week / This month — Allowances' page in a titled frame for now.
export const importSpendingPeriod = () => import("../pages/spending-period");
export const importMappingRules = () => import("../pages/mapping-rules");
export const importWishlist = () => import("../pages/wishlist");
export const importSettings = () => import("../pages/settings");
// (F8) Ask, outside the five areas, and Review › Suggestions (its proposals).
export const importAsk = () => import("../pages/ask/Ask");
export const importSuggestions = () => import("../pages/ask/Suggestions");
// The /next preview pages (lazy; outside the ribbon until the owner approves).
export const importNextForecast = () => import("../pages/next/Forecast");
export const importNextAccounts = () => import("../pages/next/Accounts");

// ── href → importer map (keyed exactly as the nav links / routes) ────────────
// A route may map to a shared page component (e.g. /forecast + /review both
// render the Forecast page); both keys point at the same importer so either
// hover warms the right chunk.
export const routeImporters: Record<string, () => Promise<unknown>> = {
  "/banking": importCommandCenter,
  "/bills": importBillsOverview,
  "/bills/all": importBills,
  "/forecast/overview": importForecastOverview,
  "/forecast": importForecast,
  "/review": importForecast,
  "/review/categories": importReviewCategories,
  "/review/suggestions": importSuggestions,
  "/avalanche": importAvalanche,
  "/amex": importAmex,
  "/transactions": importTransactions,
  "/budget": importBudget,
  "/allowances": importAllowances,
  "/spending/week": importSpendingPeriod,
  "/spending/month": importSpendingPeriod,
  "/wishlist": importWishlist,
  "/debts": importDebts,
  "/reports": importReports,
  "/reports/debt": importReportsDebt,
  "/reports/cashflow": importReportsCashFlow,
  "/reports/spending": importReportsSpending,
  "/reports/budget": importReportsBudget,
  "/reports/behavior": importReportsBehavior,
  "/settings": importSettings,
  "/ask": importAsk,
  "/mapping-rules": importMappingRules,
  "/next/forecast": importNextForecast,
  "/next/accounts": importNextAccounts,
};

// Chunks we've already kicked off — prefetch is a no-op after the first call
// for a given importer, so repeated hovers cost nothing.
const prefetched = new Set<string>();

/** The map key (longest-prefix match) for `href`, or null when it has no chunk. */
function bestKey(href: string): string | null {
  let best: string | null = null;
  for (const key of Object.keys(routeImporters)) {
    if (href === key || href.startsWith(key + "/")) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  return best;
}

/**
 * Warm the JS chunk for the route `href` maps to. Finds the best (longest-
 * prefix) matching importer — so `/bills/all` warms the Bills list (not the
 * Overview) and `/reports/debt` warms the Debt report (not the Reports hub) —
 * and calls it once. Safe to call on every hover/focus/idle: SSR-guarded and
 * deduped, so it never double-fetches.
 */
export function prefetchRoute(href: string): void {
  if (typeof window === "undefined") return;
  const best = bestKey(href);
  if (best === null || prefetched.has(best)) return;
  prefetched.add(best);
  // Fire-and-forget; on failure, drop from the set so a later hover retries.
  // (#perf) Through `preloadImporter`, not the bare importer: App.tsx's
  // `lazyWithPreload` shares that cache, so a warmed route renders without
  // suspending (no ~300 ms Suspense retry hold).
  void preloadImporter(routeImporters[best] as () => Promise<{ default: never }>).catch(() => {
    prefetched.delete(best);
    failed.add(best);
  });
}

// Chunks that failed to load: the shell stops waiting on them and lets the
// route's own `lazyWithPreload` fallback (and error boundary) take over.
const failed = new Set<string>();

/**
 * (#perf) null when the page for `href` can render RIGHT NOW without suspending
 * (no chunk of its own, already loaded, or known to have failed). Otherwise a
 * promise that settles when its chunk is in. The shell waits on this instead of
 * mounting a `lazy()` that would suspend: React holds a suspended tree's retry
 * ~300 ms after the fallback commits, even when the chunk arrives in 20 ms.
 */
export function whenRouteChunkLoaded(href: string): Promise<void> | null {
  const key = bestKey(href);
  if (key === null || failed.has(key)) return null;
  const importer = routeImporters[key] as () => Promise<{ default: never }>;
  if (loadedModule(importer)) return null;
  prefetched.add(key);
  return preloadImporter(importer).then(
    () => undefined,
    () => {
      failed.add(key);
    },
  );
}
