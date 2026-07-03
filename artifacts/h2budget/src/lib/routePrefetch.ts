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

// ── Per-page importers (reused by App.tsx's lazy() calls) ────────────────────
export const importLanding = () => import("../pages/landing");
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
export const importAmex = () => import("../pages/amex");
export const importTransactions = () => import("../pages/transactions");
export const importBills = () => import("../pages/bills");
export const importBillsOverview = () => import("../pages/bills-overview");
export const importBudget = () => import("../pages/budget");
export const importAllowances = () => import("../pages/allowances");
export const importMappingRules = () => import("../pages/mapping-rules");
export const importDebrief = () => import("../pages/debrief");
export const importSettings = () => import("../pages/settings");

// ── href → importer map (keyed exactly as the nav links / routes) ────────────
// A route may map to a shared page component (e.g. /forecast + /review both
// render the Forecast page); both keys point at the same importer so either
// hover warms the right chunk.
export const routeImporters: Record<string, () => Promise<unknown>> = {
  "/home": importLanding,
  "/banking": importCommandCenter,
  "/bills": importBillsOverview,
  "/bills/all": importBills,
  "/forecast/overview": importForecastOverview,
  "/forecast": importForecast,
  "/review": importForecast,
  "/avalanche": importAvalanche,
  "/amex": importAmex,
  "/transactions": importTransactions,
  "/budget": importBudget,
  "/allowances": importAllowances,
  "/debts": importDebts,
  "/debrief": importDebrief,
  "/reports": importReports,
  "/reports/debt": importReportsDebt,
  "/reports/cashflow": importReportsCashFlow,
  "/reports/spending": importReportsSpending,
  "/reports/budget": importReportsBudget,
  "/reports/behavior": importReportsBehavior,
  "/settings": importSettings,
  "/mapping-rules": importMappingRules,
};

// Chunks we've already kicked off — prefetch is a no-op after the first call
// for a given importer, so repeated hovers cost nothing.
const prefetched = new Set<string>();

/**
 * Warm the JS chunk for the route `href` maps to. Finds the best (longest-
 * prefix) matching importer — so `/bills/all` warms the Bills list (not the
 * Overview) and `/reports/debt` warms the Debt report (not the Reports hub) —
 * and calls it once. Safe to call on every hover/focus/idle: SSR-guarded and
 * deduped, so it never double-fetches.
 */
export function prefetchRoute(href: string): void {
  if (typeof window === "undefined") return;
  let best: string | null = null;
  for (const key of Object.keys(routeImporters)) {
    if (href === key || href.startsWith(key + "/")) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  if (best === null || prefetched.has(best)) return;
  prefetched.add(best);
  // Fire-and-forget; on failure, drop from the set so a later hover retries.
  const key = best;
  void routeImporters[key]().catch(() => {
    prefetched.delete(key);
  });
}
