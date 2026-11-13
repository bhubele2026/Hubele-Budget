// The pages the theme guard walks, each with a selector that appears only once
// the page's real content has rendered (from the invented household in api/).
export const PAGES = [
  { id: "home", path: "/home", ready: ['[data-testid="four-checking-value"]', '[data-testid="dash-forecast-chart"] .recharts-surface', '[data-testid="dash-more-summary"]'] },
  { id: "banking", path: "/banking#needs-you", ready: ['[data-testid="br-summary"]', '[data-testid="ny-items"]', '[data-testid="ny-autodone"]'] },
  // Banking's Details opened (a link that names a pill opens it): the proposed fixes, the five pills and their rows.
  // "Unclear" is the bucket the invented household fills this month.
  { id: "banking-details", path: "/banking?bucket=uncertain", ready: ['[data-testid="br-summary"]', '[data-testid="br-rows"]'] },
  { id: "amex", path: "/amex", ready: ['[data-testid="amex-fig-owed"]', '[data-testid^="row-amex-"]'] },
  { id: "spending-week", path: "/spending/week", ready: ['[data-testid="spending-week"] [data-testid="sp-known-amount"]'] },
  { id: "spending-month", path: "/spending/month", ready: ['[data-testid="spending-month"] [data-testid="sp-known-amount"]'] },
  { id: "forecast", path: "/forecast", ready: ['[data-testid="answer-lowest-figure"]', '[data-testid="chart-surface"] .recharts-surface'] },
  { id: "avalanche", path: "/avalanche", ready: ['[data-testid="avalanche-weekly-list"]', '[data-testid="milestones-section"]'] },
  { id: "debts", path: "/debts", ready: ['[data-testid="debt-card-payoff-date"]'] },
  { id: "budget", path: "/budget", ready: ['[data-testid="budget-hero"]', '[data-testid^="row-budget-"]'] },
  { id: "bills", path: "/bills", ready: ['[data-testid="bills-biggest-card"]', '[data-testid="text-overview-net"]'] },
  { id: "bills-all", path: "/bills/all", ready: ['[data-testid^="row-bill-"]', '[data-testid="text-net-monthly"]'] },
  { id: "reports", path: "/reports", ready: ['[data-testid="report-tile-spending"] [data-testid="stackbar-denominator"]'] },
  { id: "reports-cashflow", path: "/reports/cashflow", ready: ['[data-testid="cashflow-forecast-card"] .recharts-surface'] },
  { id: "reports-debt", path: "/reports/debt", ready: ['section.panel:has(h2:text-is("Payoff timeline")) .recharts-surface'] },
  { id: "reports-spending", path: "/reports/spending", ready: ['[data-testid="spend-share-row"]', '[data-testid="spending-total"]'] },
  { id: "review", path: "/review", ready: ['[data-testid="chart-surface"] .recharts-surface', '[data-testid="hero-forecast-balance"]'] },
  { id: "review-categories", path: "/review/categories", ready: ['[data-testid="review-item"]'] },
  { id: "transactions", path: "/transactions", ready: ['[data-testid^="row-tx-"]', '[data-testid="card-balance-trend"] .recharts-surface'] },
  { id: "settings", path: "/settings", ready: ['[data-testid="plaid-item-pi-cedar-hollow"]'] },
  { id: "ask", path: "/ask", ready: ['[data-testid="ask"] [data-testid="suggestions"]'] },
];
/** The fixture's "today", 10:00 in the household's zone. */
export const NOW = "2026-11-10T16:00:00.000Z";
export const TZ = "America/Chicago";
/** The browser key lib/theme.ts and index.html's boot script keep the pick in. */
export const APPEARANCE_KEY = "h2:appearance";

/** Open `p` and wait for its content. Returns "" or what never came. */
export async function visit(page, base, p) {
  await page.goto(base + p.path, { waitUntil: "load" });
  let miss = "";
  for (const sel of p.ready) {
    const ok = await page.waitForSelector(sel, { timeout: 20_000, state: "visible" }).then(() => true, () => false);
    if (!ok) miss ||= `${sel} never appeared`;
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(900); // charts settle, lazy panels land
  return miss;
}

/** Grow the window until the shell's one scroller (<main>) has nothing left to scroll, so one still holds the whole page. */
export async function growToFit(page, width, height, cap = 9000) {
  const extra = await page.evaluate(() => {
    const m = document.querySelector("[data-shell-scroller]");
    const a = m ? m.scrollHeight - m.clientHeight : 0;
    const d = document.documentElement.scrollHeight - window.innerHeight;
    return Math.max(a, d, 0);
  });
  if (extra > 4) {
    await page.setViewportSize({ width, height: Math.min(cap, height + extra + 8) });
    await page.waitForTimeout(700);
  }
}
