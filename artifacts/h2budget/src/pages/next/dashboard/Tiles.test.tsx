import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const h = vi.hoisted(() => ({
  Q: {} as Record<string, unknown>,
  spine: { data: undefined as unknown, state: "loaded", refetch: () => {} },
  prefetch: vi.fn(),
}));
const ok = (data: unknown) => ({ data, isError: false, isLoading: false, refetch: () => {} });
const loading = { data: undefined, isError: false, isLoading: true, refetch: () => {} };
const get = (k: string) => (h.Q[k] ?? loading);
vi.mock("./queries", () => ({
  usePlaidItemsQ: () => get("items"),
  useDebtsQ: () => get("debts"),
  useMoneyPositionQ: () => get("pos"),
  useLiabilityAccountsQ: () => get("liab"),
  useCashSignalQ: () => get("cash"),
}));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => h.spine }));
vi.mock("@/components/data-state", () => ({ FreshnessLine: () => <span>fresh</span> }));
vi.mock("@/lib/routePrefetch", () => ({ prefetchRoute: (href: string) => h.prefetch(href) }));

import Tiles from "./Tiles";
import ForecastPanel from "./ForecastPanel";
import DashboardHeader from "./DashboardHeader";

const bank = {
  balance: "4200.50", asOfDate: "2026-10-07T20:00:00Z", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null,
  snapshot: { balance: "4180.50", at: "2026-10-07T20:00:00Z", source: "plaid" },
  sinceSnapshot: { net: "20.00", count: 0, through: "2026-10-08" },
  account: { rowId: "c1", externalId: "p-c1", name: "Total Checking", mask: "5526", subtype: "checking", via: "sole checking" },
};
const spine = (o: Record<string, unknown> = {}) => ({
  asOf: "2026-10-08T15:00:00Z", bank, spentMonth: 900, spentWeek: 120,
  nextBill: { name: "Rent", amount: "1200.00", dueDate: "2026-10-10" }, billsDueCount: 2,
  forecast: { lowPoint: "350.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "not_yet" },
  debt: { payoffPct: 41.6, nextMilestone: null, paidDownMtd: 300, confirmedPaymentsMtd: 320, newChargesMtd: 80 },
  reviewCount: 3,
  position: { safeToSpendNow: "210.00", remainingWeek: "60.00", availableUntilPayday: "400.00", paydayDate: "2026-10-16", horizonKind: "payday", withinPlan: "yes", confidence: "firm", degraded: false, weekAdjustment: null },
  monthAllowance: { plan: "1000.00", actual: "900.00", status: "within", remaining: "100.00", over: "0.00" },
  ...o,
});
const acct = (id: string, o: Record<string, unknown>) => ({ id, accountId: `p-${id}`, name: null, mask: null, type: "depository", subtype: "checking", ...o });
const item = (id: string, accounts: unknown[]) => ({
  id, itemId: `i-${id}`, institutionName: "Bank", institutionSlug: "chase", lastSyncedAt: "2026-10-08T12:00:00Z", lastSyncError: null, lastSyncErrorCode: null, accounts,
});
const card = (id: string, name: string, mask: string) => acct(id, { name, mask, type: "credit", subtype: "credit card" });
const debt = (id: string, plaidAccountId: string, balance: string) => ({ id, name: id, balance, originalBalance: balance, status: "active", minPayment: "0", plaidAccountId });

function setup(spineOver: Record<string, unknown> = {}, pos: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  h.spine.data = spine(spineOver);
  h.Q.pos = ok({ spentWeekDiscretionary: "140.00", weekCap: "200.00", ...pos });
  h.Q.items = ok([item("a", [acct("c1", { name: "Total Checking", mask: "5526" }), card("x1", "Platinum", "1005"), card("x2", "Gold", "2002")])]);
  h.Q.debts = ok([debt("d1", "x1", "1500.00"), debt("d2", "x2", "800.00")]);
  const mem = memoryLocation({ path: "/home", record: true });
  render(<Router hook={mem.hook}><Tiles {...props} /></Router>);
  return mem;
}

beforeEach(() => { h.Q = {}; h.prefetch.mockClear(); h.spine = { data: undefined, state: "loaded", refetch: () => {} }; });
afterEach(() => cleanup());

describe("six tiles", () => {
  it("renders six whole-card links to their scoped destinations", () => {
    setup();
    const hrefs: Record<string, string> = {
      banking: "/banking?account=c1", amex: "/amex", week: "/spending/week", month: "/spending/month", forecast: "/forecast", debt: "/avalanche",
    };
    for (const [k, href] of Object.entries(hrefs)) {
      const link = screen.getByTestId(`tile-${k}-link`);
      expect(link.getAttribute("href"), k).toBe(href);
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("tabindex")).not.toBe("-1");
    }
  });
  it("hover and focus prefetch the route; activating the focused link navigates (Enter is the anchor's native click)", () => {
    const mem = setup();
    const link = screen.getByTestId("tile-forecast-link");
    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    expect(h.prefetch).toHaveBeenCalledWith("/forecast");
    link.focus();
    expect(document.activeElement).toBe(link);
    fireEvent.click(link);
    expect(mem.history?.at(-1)).toBe("/forecast");
  });
  it("banking: checking once with identity, and review count or up to date", () => {
    setup();
    expect(screen.getByTestId("tile-banking-balance").textContent).toBe("$4,200.50");
    expect(screen.getByTestId("tile-banking-account").textContent).toBe("Total Checking ••5526");
    expect(screen.getByTestId("tile-banking-status").textContent).toBe("3 to review");
    cleanup();
    setup({ reviewCount: 0 });
    expect(screen.getByTestId("tile-banking-status").textContent).toBe("Up to date");
  });
  it("forecast and debt quote the spine", () => {
    setup();
    expect(screen.getByTestId("tile-forecast-low").textContent).toBe("$350.00");
    expect(screen.getByTestId("tile-forecast-status").textContent).toBe("Below buffer");
    expect(screen.getByTestId("tile-forecast-next").textContent).toContain("Rent");
    expect(screen.getByTestId("tile-debt-pct").textContent).toBe("42%");
    expect(screen.getByTestId("tile-debt-mtd").textContent).toBe("$300.00");
    expect(screen.getByTestId("tile-debt").textContent).not.toMatch(/1,500|800/);
  });
  it("loading draws skeletons and no $0", () => {
    h.spine.data = undefined;
    render(<Router hook={memoryLocation({ path: "/home" }).hook}><Tiles /></Router>);
    expect(screen.queryAllByText(/\$0/)).toHaveLength(0);
    expect(document.querySelectorAll("[aria-busy='true']").length).toBeGreaterThanOrEqual(5);
  });
});

describe("this week and this month", () => {
  it("no weekly plan: Plan not set, never $0 and never Over", () => {
    setup({ position: { ...spine().position, remainingWeek: null, withinPlan: null } }, { weekCap: null });
    const t = screen.getByTestId("tile-week");
    expect(within(t).getByTestId("tile-week-status").textContent).toBe("Plan not set");
    expect(within(t).getByTestId("tile-week-noplan")).toBeTruthy();
    expect(t.textContent).not.toMatch(/Over/);
    expect(within(t).getByTestId("tile-week-spent").textContent).toBe("$140.00");
    expect(t.textContent).not.toContain("$0.00");
  });
  it("plan and overspend: Over $X, named figure 'Counts toward plan'", () => {
    setup({ position: { ...spine().position, remainingWeek: "-40.00", withinPlan: "over" } }, { spentWeekDiscretionary: "240.00" });
    const t = screen.getByTestId("tile-week");
    expect(t.textContent).toContain("Counts toward plan");
    expect(within(t).getByTestId("tile-week-left").textContent).toBe("Over $40.00");
    expect(within(t).getByTestId("tile-week-status").textContent).toBe("Over");
  });
  it("on plan shows what is left", () => {
    setup();
    expect(screen.getByTestId("tile-week-left").textContent).toBe("$60.00 left");
    expect(screen.getByTestId("tile-week-status").textContent).toBe("On plan");
  });
  it("monthly allowance: within, over, and not set", () => {
    setup();
    expect(screen.getByTestId("tile-month-left").textContent).toBe("$100.00 left");
    expect(screen.getByTestId("tile-month-status").textContent).toBe("Within");
    cleanup();
    setup({ monthAllowance: { plan: "1000.00", actual: "1125.50", status: "over", remaining: "-125.50", over: "125.50" } });
    expect(screen.getByTestId("tile-month-left").textContent).toBe("Over $125.50");
    expect(screen.getByTestId("tile-month-status").textContent).toBe("Over");
    cleanup();
    setup({ monthAllowance: { plan: null, actual: "300.00", status: "not_set", remaining: null, over: null } });
    const t = screen.getByTestId("tile-month");
    expect(within(t).getByTestId("tile-month-status").textContent).toBe("Plan not set");
    expect(t.textContent).not.toMatch(/Over|\$0\.00/);
  });
});

describe("(S6) this month reads left / over from the server, never plan − actual", () => {
  it("quotes the server's remaining and over, even when they are not plan − actual", () => {
    // A server answer the browser could not have computed: remaining is not 1000 − 900.
    setup({ monthAllowance: { plan: "1000.00", actual: "900.00", status: "within", remaining: "75.25", over: "0.00" } });
    expect(screen.getByTestId("tile-month-left").textContent).toBe("$75.25 left");
    cleanup();
    setup({ monthAllowance: { plan: "1000.00", actual: "990.00", status: "over", remaining: "-12.34", over: "12.34" } });
    expect(screen.getByTestId("tile-month-left").textContent).toBe("Over $12.34");
    expect(screen.getByTestId("tile-month-status").textContent).toBe("Over");
  });
  it("exactly on plan: $0.00 left, within", () => {
    setup({ monthAllowance: { plan: "1000.00", actual: "1000.00", status: "within", remaining: "0.00", over: "0.00" } });
    expect(screen.getByTestId("tile-month-left").textContent).toBe("$0.00 left");
    expect(screen.getByTestId("tile-month-status").textContent).toBe("Within");
  });
});

describe("amex tile", () => {
  it("each card as name ••last4 with its owed; no week-charges row when the slot is absent", () => {
    setup();
    const rows = screen.getAllByTestId("tile-amex-card");
    expect(rows.map((r) => r.textContent)).toEqual(["Bank Platinum ••1005$1,500.00", "Bank Gold ••2002$800.00"]);
    expect(screen.queryByTestId("tile-amex-weekcharges")).toBeNull();
  });
  it("the weekCharges slot renders only when given", () => {
    setup({}, {}, { weekCharges: <span>This week $50.00</span> });
    expect(screen.getByTestId("tile-amex-weekcharges").textContent).toBe("This week $50.00");
  });
});

describe("one attention line, forecast present, no repeated figures", () => {
  it("the header holds one action and the page quotes checking once", () => {
    h.Q.cash = ok({ status: "no_data", events: [], daily: [], account: {} });
    setup();
    render(<Router hook={memoryLocation({ path: "/home" }).hook}><DashboardHeader /><ForecastPanel /></Router>);
    expect(screen.getAllByTestId("dash-header-action")).toHaveLength(1);
    expect(screen.getByTestId("dash-forecast")).toBeTruthy();
    expect(document.body.textContent!.split("$4,200.50").length - 1).toBe(1);
  });
});
