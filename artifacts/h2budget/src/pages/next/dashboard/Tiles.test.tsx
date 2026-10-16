import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { memoryLocation } from "wouter/memory-location";

const h = vi.hoisted(() => ({
  Q: {} as Record<string, unknown>,
  spine: { data: undefined as unknown, state: "loaded", refetch: () => {} } as { data: unknown; state: string; refetch: () => void; olderWords?: string | null },
  prefetch: vi.fn(),
  settings: undefined as unknown,
  me: { isOwner: true } as unknown,
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
vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useGetSettings: () => ({ data: h.settings }),
  useGetMe: () => ({ data: h.me, isLoading: false }),
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
  bankConfidence: {
    fetchedAt: "2026-10-08T14:00:00Z", bankBalance: "4180.50", bankAsOf: "2026-10-07T20:00:00Z", h2Balance: "4200.50", pendingCount: 1,
    check: { status: "matches", reason: null, stale: false, staleReason: null, checkedAt: "2026-10-08T13:00:00Z", difference: "0.00", direction: null },
  },
  position: { safeToSpendNow: "210.00", remainingWeek: "60.00", knownWeek: "140.00", unresolvedWeek: "0.00", provisional: false, remainingWeekKnown: "60.00", availableUntilPayday: "400.00", paydayDate: "2026-10-16", horizonKind: "payday", withinPlan: "yes", confidence: "firm", degraded: false, weekAdjustment: null },
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
  h.Q.items = ok([item("a", [acct("c1", { name: "Total Checking", mask: "5526" }), card("v1", "Summit Visa", "3303")]), { ...item("b", [card("x1", "Amex Platinum", "1005"), card("x2", "Amex Gold", "2002")]), institutionName: "American Express", institutionSlug: "amex" }]);
  h.Q.debts = ok([debt("d1", "x1", "1500.00"), debt("d2", "x2", "800.00")]);
  const mem = memoryLocation({ path: "/home", record: true });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><Router hook={mem.hook}><Tiles {...props} /></Router></QueryClientProvider>);
  return mem;
}

beforeEach(() => { h.Q = {}; h.settings = undefined; h.me = { isOwner: true }; h.prefetch.mockClear(); h.spine = { data: undefined, state: "loaded", refetch: () => {} }; });
afterEach(() => cleanup());

describe("six tiles", () => {
  it("renders six whole-card links to their scoped destinations", () => {
    setup();
    const hrefs: Record<string, string> = {
      banking: "/banking?account=c1", amex: "/amex", week: "/spending/week", month: "/spending/month", forecast: "/forecast?horizon=90", debt: "/avalanche",
    };
    for (const [k, href] of Object.entries(hrefs)) {
      const link = screen.getByTestId(`tile-${k}-link`);
      expect(link.getAttribute("href"), k).toBe(href);
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("tabindex")).not.toBe("-1");
    }
  });
  it("pointer-down and touch-start warm the route too (the press itself starts the warm-up)", () => {
    setup();
    const link = screen.getByTestId("tile-banking-link");
    fireEvent.pointerDown(link);
    expect(h.prefetch).toHaveBeenCalledWith("/banking");
    h.prefetch.mockClear();
    fireEvent.touchStart(link);
    expect(h.prefetch).toHaveBeenCalledWith("/banking");
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
    expect(mem.history?.at(-1)).toBe("/forecast?horizon=90");
  });
  it("banking: checking once with identity, and charges to match or nothing to match", () => {
    setup();
    expect(screen.getByTestId("tile-banking-balance").textContent).toBe("$4,200.50");
    expect(screen.getByTestId("tile-banking-account").textContent).toBe("Total Checking ••5526");
    expect(screen.getByTestId("tile-banking-status").textContent).toBe("3 charges to match");
    cleanup();
    setup({ reviewCount: 0 });
    // (Q5) "Up to date" read like a sync verdict; the chip now says what the count is.
    expect(screen.getByTestId("tile-banking-status").textContent).toBe("Nothing to match");
  });
  describe("bank confidence (Q5): separate facts, green only for a matching check", () => {
    const conf = (check: Record<string, unknown>, o: Record<string, unknown> = {}) => ({
      fetchedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), bankBalance: "4180.50", bankAsOf: "2026-10-07T20:00:00Z", h2Balance: "4200.50", pendingCount: 0,
      check: { status: "matches", reason: null, stale: false, staleReason: null, checkedAt: new Date().toISOString(), difference: "0.00", direction: null, ...check }, ...o,
    });
    // The words arrive in a lazy chunk: the tile keeps its place meanwhile.
    const check = () => screen.findByTestId("tile-banking-check");
    // (T2) The same chip words as Banking's Balance check.
    it("matches: Balances match (green), pending beside", async () => {
      setup({ bankConfidence: conf({}, { pendingCount: 2 }) });
      expect((await check()).textContent).toBe("Balances match");
      expect((await check()).getAttribute("data-tone")).toBe("ok");
      expect(screen.getByTestId("tile-banking-pending").textContent).toBe("2 pending");
      // Row A is data (updated + pending); the check is its own row, never merged with it.
      expect(screen.getByTestId("tile-banking-fresh").textContent).toBe("fresh · 2 pending")  // FreshnessLine is mocked here; its own words are tested with it;
      expect(screen.getByTestId("tile-banking-fresh").contains(screen.getByTestId("tile-banking-check"))).toBe(false);
    });
    it("pending shows at once from the spine, before the check's chunk arrives", () => {
      setup({ bankConfidence: conf({}, { pendingCount: 2 }) });
      expect(screen.getByTestId("tile-banking-fresh").textContent).toBe("fresh · 2 pending")  // FreshnessLine is mocked here; its own words are tested with it;
    });
    it("off by: Difference needs review, rust, never green", async () => {
      setup({ bankConfidence: conf({ status: "off_by", difference: "62.50", direction: "bank_lower" }) });
      expect((await check()).textContent).toBe("Difference needs review");
      expect((await check()).getAttribute("data-tone")).toBe("bad");
    });
    it("not checked is grey even though the review count is zero", async () => {
      setup({ reviewCount: 0, bankConfidence: conf({ status: "not_checked", reason: "never", checkedAt: null, difference: null }) });
      expect((await check()).textContent).toBe("Not checked");
      expect((await check()).getAttribute("data-tone")).toBe("grey");
      expect(screen.queryByTestId("tile-banking-pending")).toBeNull();
      expect(screen.getByTestId("tile-banking-status").textContent).toBe("Nothing to match");
    });
    it("an old matching check is grey 'Check is out of date'", async () => {
      setup({ bankConfidence: conf({ stale: true, staleReason: "age", checkedAt: new Date(Date.now() - 9 * 86_400_000).toISOString() }) });
      expect((await check()).textContent).toBe("Check is out of date");
      expect((await check()).getAttribute("data-tone")).toBe("grey");
    });
    it("no bank balance: no confidence row at all", () => {
      setup({ bank: { ...bank, source: null, asOfDate: null, balance: "0.00" }, bankConfidence: conf({}) });
      expect(screen.queryByTestId("tile-banking-confidence")).toBeNull();
    });
  });
  it("forecast and debt quote the spine", () => {
    setup();
    expect(screen.getByTestId("tile-forecast-low").textContent).toBe("$350.00");
    // (T2) Under the buffer at or above $0 is quiet, never rust; only below zero is the alarm.
    expect(screen.getByTestId("tile-forecast-status").textContent).toBe("Under the $500 buffer");
    expect(screen.getByTestId("tile-forecast-status").getAttribute("data-tone")).toBe("neutral");
    expect(screen.getByTestId("tile-forecast-link").getAttribute("href")).toBe("/forecast?horizon=90");
    expect(screen.queryByTestId("tile-forecast-shortfall")).toBeNull();
    expect(screen.getByTestId("tile-forecast-next").textContent).toContain("Rent");
    expect(screen.getByTestId("tile-debt-pct").textContent).toBe("42%");
    expect(screen.getByTestId("tile-debt-mtd").textContent).toBe("$300.00");
    expect(screen.getByTestId("tile-debt").textContent).not.toMatch(/1,500|800/);
  });
  it("⭐ (T2) a projected NEGATIVE low point is the only rust: 'Below zero on <date>', and the tile opens that day", () => {
    setup({ forecast: { lowPoint: "-42.10", lowPointDate: "2026-10-20", runwayDays: 5, cashBuffer: "500.00", status: "not_yet" } });
    expect(screen.getByTestId("tile-forecast-status").textContent).toBe("Below zero on Oct 20");
    expect(screen.getByTestId("tile-forecast-status").getAttribute("data-tone")).toBe("bad");
    expect(screen.getByTestId("tile-forecast-shortfall").textContent).toBe("Review shortfall →");
    expect(screen.getByTestId("tile-forecast-link").getAttribute("href")).toBe("/forecast?horizon=90&day=2026-10-20");
    cleanup();
    // Near the buffer is quiet; well above it is ok.
    setup({ forecast: { lowPoint: "620.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "tight" } });
    expect(screen.getByTestId("tile-forecast-status").textContent).toBe("Near buffer");
    expect(screen.getByTestId("tile-forecast-status").getAttribute("data-tone")).toBe("neutral");
  });
  it("(T1, H1) a checking balance of exactly $0.00 is a real figure: plain, never rust, never a dash", () => {
    setup({ bank: { ...bank, balance: "0.00", snapshot: { balance: "0.00", at: "2026-10-08T12:00:00Z", source: "plaid" } } });
    expect(screen.getByTestId("tile-banking-balance").textContent).toBe("$0.00");
    expect(screen.getByTestId("tile-banking-balance").className).not.toContain("text-bad-ink");
  });
  it("(T1, H2) a spine older than the newest reading seen: the figure stays, grey words say it is an earlier reading — never 'current'", async () => {
    setup();
    h.spine = { ...h.spine, olderWords: "Earlier reading (Oct 7) — updating…" };
    cleanup();
    render(<QueryClientProvider client={new QueryClient()}><Router hook={memoryLocation({ path: "/home" }).hook}><Tiles /></Router></QueryClientProvider>);
    expect(screen.getByTestId("tile-banking-balance").textContent).toBe("$4,200.50");
    expect((await screen.findByTestId("checking-balance-line")).textContent).toBe("Earlier reading (Oct 7) — updating…");
  });
  it("(H12) a failed refresh keeps the figures; the low point says it is from an out-of-date balance (no new rust)", () => {
    setup({ bank: { ...bank, stale: true, staleReason: "refresh_failed" } });
    expect(screen.getByTestId("tile-banking-balance").textContent).toBe("$4,200.50");
    expect(screen.getByTestId("tile-forecast-low").textContent).toBe("$350.00");
    expect(screen.getByTestId("tile-forecast-status").getAttribute("data-tone")).toBe("neutral");
  });
  it("loading draws skeletons and no $0", () => {
    h.spine.data = undefined;
    render(<QueryClientProvider client={new QueryClient()}><Router hook={memoryLocation({ path: "/home" }).hook}><Tiles /></Router></QueryClientProvider>);
    expect(screen.queryAllByText(/\$0/)).toHaveLength(0);
    expect(document.querySelectorAll("[aria-busy='true']").length).toBeGreaterThanOrEqual(5);
  });
});

describe("this week and this month", () => {
  const pos = (o: Record<string, unknown>) => ({ ...spine().position, ...o });
  it("no weekly plan: Plan not set, never $0 and never Over", () => {
    setup({ position: pos({ remainingWeek: null, remainingWeekKnown: null, withinPlan: null }) }, { weekCap: null });
    const t = screen.getByTestId("tile-week");
    expect(within(t).getByTestId("tile-week-status").textContent).toBe("Plan not set");
    // said once: the chip, not the body
    expect(within(t).queryByTestId("tile-week-noplan")).toBeNull();
    expect(t.textContent!.split("Plan not set").length - 1).toBe(1);
    expect(t.textContent).not.toMatch(/Over/);
    expect(within(t).getByTestId("tile-week-spent").textContent).toBe("$140.00");
    expect(t.textContent).not.toContain("$0.00");
  });
  const noPlan = () => setup({ position: pos({ remainingWeek: null, remainingWeekKnown: null, withinPlan: null }) }, { weekCap: null });
  const reserve = (o: Record<string, unknown>) => ({ hook: "weekly", occurrenceDate: "2026-10-17", amount: "450.00", storedAmount: "450.00", basis: "stored_amount", ...o });
  it("(E3) no plan, owner: one action to set it and one line saying what the forecast assumes", async () => {
    h.Q.cash = ok({ hookReserves: [reserve({ occurrenceDate: "2026-10-24" }), reserve({})] });
    noPlan();
    const t = screen.getByTestId("tile-week");
    expect(within(t).getByTestId("tile-week-status").textContent).toBe("Plan not set");
    await within(t).findByTestId("tile-week-assumed");
    expect(within(t).getByTestId("tile-week-assumed").textContent).toBe("Forecast assumes $450 a week");
    const a = within(t).getByTestId("tile-week-setplan");
    expect(a.textContent).toBe("Set weekly plan →");
    expect(a.getAttribute("href")).toBe("/spending/week?plan=1");
    expect(t.textContent).not.toMatch(/Over/);
  });
  it("(E3) no plan, member or unknown: the line, no action", async () => {
    h.Q.cash = ok({ hookReserves: [reserve({})] });
    h.me = { isOwner: false };
    noPlan();
    expect(await screen.findByTestId("tile-week-assumed")).toBeTruthy();
    expect(screen.queryByTestId("tile-week-setplan")).toBeNull();
    cleanup();
    h.me = undefined;
    noPlan();
    expect(await screen.findByTestId("tile-week-assumed")).toBeTruthy();
    expect(screen.queryByTestId("tile-week-setplan")).toBeNull();
  });
  it("(E3) a plan that reads $0 says 'Plan set to $0': no action, no assumption, never Over", async () => {
    h.Q.cash = ok({ hookReserves: [reserve({ basis: "plan", amount: "0.00" })] });
    noPlan();
    const t = screen.getByTestId("tile-week");
    await waitFor(() => expect(within(t).getByTestId("tile-week-status").textContent).toBe("Plan set to $0"));
    expect(within(t).queryByTestId("tile-week-setplan")).toBeNull();
    expect(within(t).queryByTestId("tile-week-assumed")).toBeNull();
    expect(t.textContent).not.toMatch(/Over/);
  });
  it("(E3) no cash signal yet: no figure invented, no action until it answers", async () => {
    noPlan();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("tile-week-assumed")).toBeNull();
    expect(screen.queryByTestId("tile-week-setplan")).toBeNull();
  });
  it("plan and overspend: Over $X on the KNOWN figure, named 'Counts toward plan'", () => {
    // The cautious total (spentWeekDiscretionary 999) is never what the tile shows.
    setup({ position: pos({ remainingWeek: "-40.00", remainingWeekKnown: "-40.00", knownWeek: "240.00", withinPlan: "over" }) }, { spentWeekDiscretionary: "999.00", weekCap: "200.00" });
    const t = screen.getByTestId("tile-week");
    expect(t.textContent).toContain("Counts toward plan");
    expect(within(t).getByTestId("tile-week-spent").textContent).toBe("$240.00");
    expect(within(t).getByTestId("tile-week-plan").textContent).toBe("$200.00");
    expect(within(t).getByTestId("tile-week-left").textContent).toBe("Over $40.00");
    expect(within(t).getByTestId("tile-week-status").textContent).toBe("Over");
    expect(t.textContent).not.toContain("999");
  });
  it("on plan shows what is left", () => {
    setup();
    expect(screen.getByTestId("tile-week-left").textContent).toBe("$60.00 left");
    expect(screen.getByTestId("tile-week-status").textContent).toBe("On plan");
    expect(screen.queryByTestId("tile-week-provisional")).toBeNull();
  });
  it("provisional and the known figure already over: the chip says Over (certain), the line keeps 'so far' and is rust", () => {
    setup({ position: pos({ remainingWeekKnown: "-24.50", knownWeek: "324.50", unresolvedWeek: "1150.40", provisional: true, withinPlan: "over" }) });
    expect(screen.getByTestId("tile-week-status").textContent).toBe("Over");
    expect(screen.getByTestId("tile-week-status").getAttribute("data-tone")).toBe("bad");
    expect(screen.getByTestId("tile-week-left").textContent).toBe("Over $24.50 so far");
    expect(screen.getByTestId("tile-week-left").className).toContain("text-bad-ink");
    expect(screen.getByTestId("tile-week-provisional").textContent).toBe("Unconfirmed $1,150.40 may change this");
  });
  it("provisional and the known figure within the plan: plain 'Not final', never the jargon 'Provisional'", () => {
    setup({ position: pos({ remainingWeekKnown: "300.00", knownWeek: "200.00", unresolvedWeek: "400.00", provisional: true, remainingWeek: "-100.00", withinPlan: "over" }) });
    expect(screen.getByTestId("tile-week-status").textContent).toBe("Not final");
    expect(screen.getByTestId("tile-week").textContent).not.toContain("Provisional");
    expect(screen.getByTestId("tile-week-left").textContent).toBe("$300.00 left so far");
  });
  it("(Q5 fix) known within the plan, the cautious total over, not provisional: Tight (amber), never a green 'On plan' — the one helper the Room line reads", () => {
    // Plan 500, known 490, unconfirmed 20 (under the provisional threshold): remainingWeekKnown 10, cautious -10.
    setup({ position: pos({ knownWeek: "490.00", unresolvedWeek: "20.00", provisional: false, remainingWeekKnown: "10.00", remainingWeek: "-10.00", withinPlan: "over" }) });
    expect(screen.getByTestId("tile-week-status").textContent).toBe("Tight");
    expect(screen.getByTestId("tile-week-status").getAttribute("data-tone")).not.toBe("ok");
    expect(screen.getByTestId("tile-week-left").textContent).toBe("$10.00 left");
  });
  it("small unconfirmed (not provisional) is still said, without alarm", () => {
    setup({ position: pos({ unresolvedWeek: "12.00", provisional: false }) });
    expect(screen.getByTestId("tile-week-provisional").textContent).toBe("Unconfirmed $12.00");
  });
  it("the plan read loading is a skeleton; failing is a dash with Retry; the known figure and the rows never move", () => {
    setup();
    cleanup();
    h.spine.data = spine();
    h.Q.pos = { data: undefined, isError: false, isLoading: true, refetch: () => {} };
    render(<QueryClientProvider client={new QueryClient()}><Router hook={memoryLocation({ path: "/home" }).hook}><Tiles /></Router></QueryClientProvider>);
    const plan = screen.getByTestId("tile-week-plan");
    expect(plan.querySelector("[aria-busy='true']")).toBeTruthy();
    // The skeleton is one text line (1lh), so the tile keeps its height through every state.
    expect(plan.querySelector("[aria-busy='true']")!.className).toContain("h-[1lh]");
    expect(screen.getByTestId("tile-week-spent").textContent).toBe("$140.00");
    expect(screen.getByTestId("tile-week-left").textContent).toBe("$60.00 left");
    cleanup();
    const refetch = vi.fn();
    h.Q.pos = { data: undefined, isError: true, isLoading: false, refetch };
    render(<QueryClientProvider client={new QueryClient()}><Router hook={memoryLocation({ path: "/home" }).hook}><Tiles /></Router></QueryClientProvider>);
    // Retry sits inline beside the dash (inside the Plan figure), not on a row of its own.
    expect(screen.getByTestId("tile-week-plan").textContent).toBe("— Retry");
    expect(screen.getByTestId("tile-week-plan").contains(screen.getByTestId("tile-week-retry"))).toBe(true);
    fireEvent.click(screen.getByTestId("tile-week-retry"));
    expect(refetch).toHaveBeenCalled();
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
    // Amex cards only (the bank's Visa is not here), named the way the Amex page names them.
    expect(rows.map((r) => r.textContent)).toEqual(["Platinum ••1005$1,500.00", "Platinum ••2002$800.00"]);
    expect(screen.getByTestId("tile-amex").textContent).not.toMatch(/Visa|3303|American Express/);
    expect(screen.queryByTestId("tile-amex-weekcharges")).toBeNull();
  });
  it("the household's own card name wins", () => {
    h.settings = { preferences: { amexCardNames: { "p-x1": "Travel card" } } };
    setup();
    expect(screen.getAllByTestId("tile-amex-card")[0]!.textContent).toBe("Travel card ••1005$1,500.00");
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
