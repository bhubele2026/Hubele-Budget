import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// Every query the panels read is one entry in `Q`; a test sets what it needs.
const h = vi.hoisted(() => ({
  Q: {} as Record<string, unknown>,
  horizons: [] as number[],
  spine: { data: undefined as unknown, state: "loaded", refetch: () => {} },
}));
const ok = (data: unknown) => ({ data, isError: false, isLoading: false, refetch: () => {} });
const loading = { data: undefined, isError: false, isLoading: true, refetch: () => {} };
const failed = { data: undefined, isError: true, isLoading: false, refetch: () => {} };
const get = (k: string) => (h.Q[k] ?? loading);

vi.mock("./queries", () => ({
  usePlaidItemsQ: () => get("items"),
  useCashSignalQ: (d: number) => { h.horizons.push(d); return get("cash"); },
  useDebtsQ: () => get("debts"),
  useAmexQ: () => get("amex"),
  useMoneyPositionQ: () => get("pos"),
  useLiabilityAccountsQ: () => get("liab"),
}));
vi.mock("./queriesLazy", () => ({
  useCategoriesQ: () => get("cats"),
  useReviewQueueQ: () => get("queue"),
  useDuplicateCountQ: () => get("dups"),
  useBudgetMonthQ: () => get("budget"),
  useRecurringQ: () => get("recurring"),
  useTxnsQ: () => get("txns"),
  useRecentTxnsQ: () => get("txns"),
  RECENT_WINDOW_DAYS: 30,
  RECENT_LIMIT: 100,
}));
vi.mock("./RecapPreview", () => ({ default: () => <div data-testid="recap-stub">morning text</div> }));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => h.spine }));
vi.mock("@/hooks/use-plaid-sync", () => ({ usePlaidSync: () => ({ runSync: vi.fn(), isPending: false }) }));
vi.mock("@/components/bank-balance-why", () => ({ BankBalanceWhy: () => <span>why</span> }));
vi.mock("@/components/data-state", () => ({ FreshnessLine: () => <span>fresh</span> }));
vi.mock("@/components/agent/agentHooks", () => ({ useOpenFindings: () => get("findings") }));
vi.mock("@/components/agent/FindingsList", () => ({
  FindingsList: ({ findings }: { findings: unknown[] }) => <div data-testid="findings-stub">{findings.length} findings</div>,
}));
vi.mock("@/pages/forecast/ProjectedBalanceChart", () => ({
  ProjectedBalanceChart: (p: { data: unknown[]; cashBuffer: number; lowLabel?: string }) => (
    <div data-testid="chart-stub">{p.data.length} points, buffer {p.cashBuffer}, {p.lowLabel} label</div>
  ),
}));

import DashboardHeader from "./DashboardHeader";
import SummaryRow, { joinNames, roomLines } from "./SummaryRow";
import AccountsPanel from "./AccountsPanel";
import SpendingPanel from "./SpendingPanel";
import UpcomingPanel, { upcomingRows } from "./UpcomingPanel";
import { obligationLine } from "./obligations";
import ForecastPanel from "./ForecastPanel";
import DebtPanel from "./DebtPanel";
import ActivityPanel from "./ActivityPanel";
import AttentionPanel from "./AttentionPanel";
import { BELOW_FOLD } from "./belowFoldSizes";
import { bankLines } from "./bankState";
import { cleanRecap, recapSourceWords } from "./recapWords";
import { remainingDebtTotal } from "@/lib/debtBalance";

// (WP1) The spine's bank carries the snapshot under the balance, what rolled
// since (4,180.50 + 20.00 = 4,200.50) and the account with its ids (row c1).
const spineBank = {
  balance: "4200.50", asOfDate: "2026-10-07T20:00:00Z", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null,
  snapshot: { balance: "4180.50", at: "2026-10-07T20:00:00Z", source: "plaid" },
  sinceSnapshot: { net: "20.00", count: 0, through: "2026-10-08" },
  account: { rowId: "c1", externalId: "p-c1", name: "Total Checking", mask: "5526", subtype: "checking", via: "sole checking" },
};
const spine = (o: Record<string, unknown> = {}) => ({
  asOf: "2026-10-08T15:00:00Z",
  bank: spineBank,
  spentMonth: 900, spentWeek: 120,
  nextBill: { name: "Rent", amount: "1200.00", dueDate: "2026-10-10" },
  billsDueCount: 2,
  forecast: { lowPoint: "350.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "not_yet" },
  debt: { payoffPct: 41.6, nextMilestone: { label: "Visa paid off", estimatedMonth: "2027-03" }, paidDownMtd: 300, confirmedPaymentsMtd: 320, newChargesMtd: 80 },
  reviewCount: 3,
  position: { safeToSpendNow: "210.00", remainingWeek: "210.00", availableUntilPayday: "400.00", paydayDate: "2026-10-16", horizonKind: "payday", withinPlan: "yes", confidence: "firm", degraded: false, weekAdjustment: null },
  ...o,
});
const acct = (id: string, o: Record<string, unknown>) => ({ id, accountId: `p-${id}`, name: null, mask: null, type: "depository", subtype: "checking", ...o });
const item = (id: string, institutionName: string, slug: string, accounts: unknown[], o: Record<string, unknown> = {}) => ({
  id, itemId: `i-${id}`, institutionName, institutionSlug: slug, lastSyncedAt: "2026-10-08T12:00:00Z", lastSyncError: null, lastSyncErrorCode: null, accounts, ...o,
});
// The API's shape: every debt GET /debts returns carries an anchor (`originalBalance`, backfilled).
const debt = (id: string, name: string, balance: string, o: Record<string, unknown> = {}) => ({
  id, name, balance, originalBalance: balance, status: "active", minPayment: "0", apr: "0.2", ...o,
});
const wrap = (n: ReactNode) => render(<div>{n}</div>);
const cashAcct = { name: "Total Checking", mask: "5526", subtype: "checking", via: "sole checking" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T17:00:00Z"));
  h.Q = {}; h.horizons = []; h.spine = { data: spine(), state: "loaded", refetch: () => {} };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

// ── Header ────────────────────────────────────────────────────────────────
describe("header", () => {
  beforeEach(() => {
    h.Q.cash = ok({ account: cashAcct, events: [{ date: "2026-10-10", label: "Rent", amount: "-1200.00", itemId: "r2" }] });
    h.Q.items = ok([
      item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "5526" })], { lastSyncedAt: "2026-10-08T15:00:00Z" }),
      item("b", "American Express", "amex", [acct("x1", { name: "Platinum", mask: "1005", type: "credit", subtype: "credit card" })],
        { lastSyncErrorCode: "ITEM_LOGIN_REQUIRED", lastSyncError: "login" }),
    ]);
  });
  it("says the day, one line of facts from the spine, and each bank's freshness", () => {
    wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-today").textContent).toBe("Today · Thu Oct 8");
    expect(screen.getByTestId("dash-fact-room").textContent).toBe("$210.00 room to spend until payday Fri Oct 16");
    expect(screen.getByTestId("dash-fact-next").textContent).toBe("Next: Rent $1,200.00 · Sat Oct 10");
    expect(screen.getByTestId("dash-fact-review").textContent).toContain("3 charges to match");
    const banks = screen.getByTestId("dash-bank-fresh").textContent!;
    expect(banks).toContain("Chase · synced 2 h ago");
    expect(banks).toContain("American Express · needs reconnecting");
  });
  it("ONE action by priority: Reconnect beats a week over plan, which beats Afford", () => {
    h.spine.data = spine({ bank: { ...spine().bank, stale: true, staleReason: "refresh_failed" }, position: { ...spine().position, withinPlan: "over", remainingWeek: "-25.00" } });
    const a = wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-header-action").getAttribute("data-kind")).toBe("reconnect");
    expect(screen.getByTestId("dash-reconnect").getAttribute("href")).toBe("/settings");
    expect(screen.queryByTestId("ways-back-open")).toBeNull();
    // Afford stays one tap away, as a quiet second control.
    expect(screen.getByTestId("afford-open")).toBeTruthy();
    a.unmount();
    // A CARD's bank needing a new login is a reconnect too (Amex here)…
    h.spine.data = spine({ position: { ...spine().position, withinPlan: "over", remainingWeek: "-25.00" } });
    const a2 = wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-header-action").getAttribute("data-kind")).toBe("reconnect");
    a2.unmount();
    // …so with every bank connected and the forecast above its buffer, a week over plan offers the way back.
    h.Q.items = ok([item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "5526" })])]);
    h.spine.data = spine({ forecast: { ...spine().forecast, lowPoint: "1500.00", status: "ready" }, position: { ...spine().position, withinPlan: "over", remainingWeek: "-25.00" } });
    const b = wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-header-action").getAttribute("data-kind")).toBe("wayBack");
    expect(screen.getByTestId("ways-back-open").textContent).toBe("Pick a way back");
    b.unmount();
    // An old balance or a bill due is not the header's action: those have their own rows.
    h.spine.data = spine({ bank: { ...spine().bank, stale: true, staleReason: "old" }, forecast: { ...spine().forecast, lowPoint: "1500.00", status: "ready" } });
    wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-header-action").getAttribute("data-kind")).toBe("afford");
    expect(screen.getByTestId("afford-open").textContent).toBe("Can we afford something?");
  });
  it("no bank linked: the one action is the app's link path, and the facts say why the page is empty", () => {
    h.Q.items = ok([]);
    h.Q.cash = ok({ account: cashAcct, events: [] });
    h.spine.data = spine({ nextBill: null, reviewCount: 0, position: { ...spine().position, safeToSpendNow: null } });
    wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-header-action").getAttribute("data-kind")).toBe("link");
    expect(screen.getByTestId("dash-link-bank").getAttribute("href")).toBe("/settings");
    expect(screen.getByTestId("dash-facts").textContent).toContain("No bank is linked yet");
    // Afford stays reachable as the quiet second control (parity with the old dashboard).
    expect(screen.getByTestId("afford-open").textContent).toBe("Can we afford something?");
  });
  it("the forecast running short takes the one action (after Reconnect, before Pick a way back)", () => {
    h.Q.items = ok([item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "5526" })])]);
    // spine(): low point $350 under the $500 buffer (not_yet), and over the week's plan.
    h.spine.data = spine({ position: { ...spine().position, withinPlan: "over", remainingWeek: "-25.00" } });
    const a = wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-header-action").getAttribute("data-kind")).toBe("short");
    expect(screen.getByTestId("dash-runs-short").getAttribute("href")).toBe("/forecast");
    expect(screen.getByTestId("dash-runs-short").textContent).toBe("See where it runs short");
    expect(screen.getByTestId("afford-open")).toBeTruthy();
    a.unmount();
    // Above the buffer: back to the week's way back.
    h.spine.data = spine({ forecast: { ...spine().forecast, lowPoint: "1500.00", status: "ready" }, position: { ...spine().position, withinPlan: "over", remainingWeek: "-25.00" } });
    wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-header-action").getAttribute("data-kind")).toBe("wayBack");
  });
  it("the morning text is behind a disclosure and only loads when opened", async () => {
    wrap(<DashboardHeader />);
    expect(screen.queryByTestId("recap-stub")).toBeNull();
    const t = screen.getByTestId("dash-recap-toggle");
    expect(t.textContent).toBe("Preview tomorrow's morning text");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(t);
    await waitFor(() => expect(screen.getByTestId("recap-stub")).toBeTruthy());
    expect(t.getAttribute("aria-expanded")).toBe("true");
  });
  it("leaves out a fact it does not know rather than printing $0", () => {
    h.Q.cash = ok({ account: cashAcct, events: [] });
    h.spine.data = spine({ nextBill: null, reviewCount: 0, position: { ...spine().position, safeToSpendNow: null } });
    wrap(<DashboardHeader />);
    expect(screen.getByTestId("dash-facts").textContent).toBe("Nothing scheduled and nothing waiting.");
  });
});

describe("morning text words", () => {
  it("never says TEMPLATE: code-written text says so, and that AI is off", () => {
    expect(recapSourceWords(null)).toBe("Written from your numbers · AI is off");
    expect(recapSourceWords({ demo: true })).toBe("Demo draft");
    expect(recapSourceWords({})).not.toMatch(/template/i);
  });
  it("strips the trailing link and keeps the date", () => {
    expect(cleanRecap("You spent $40.\nhttps://h2budget.onrender.com/?d=2026-10-04")).toEqual({ body: "You spent $40.", forDate: "2026-10-04" });
    expect(cleanRecap("No link here.").forDate).toBeNull();
  });
});

describe("bank freshness lines", () => {
  it("one line per bank, never per account, synthetic items left out", () => {
    const now = Date.parse("2026-10-08T17:00:00Z");
    const lines = bankLines([
      item("a", "Chase", "chase", [acct("c1", {}), acct("c2", { subtype: "savings" })], { lastSyncedAt: "2026-10-05T12:00:00Z" }),
      item("n", "Wells", "wells", [], { lastSyncedAt: null }),
    ] as never, now);
    expect(lines.map((l) => [l.institution, l.state, l.words])).toEqual([
      ["Chase", "stale", "out of date · synced 3 d ago"],
      ["Wells", "never", "not synced yet"],
    ]);
  });
});

// ── Summary row ───────────────────────────────────────────────────────────
describe("summary row: four figures, status-aware", () => {
  beforeEach(() => {
    h.Q.cash = ok({ account: cashAcct });
    h.Q.pos = ok({ reservesHeld: "0.00" });
    h.Q.debts = ok([debt("d1", "Amex Blue Cash Preferred", "1500.00"), debt("d2", "Amex Platinum", "500.25"), debt("d3", "Old card", "999.00", { status: "archived" })]);
  });
  it("is ONE surface split by hairlines, four cells in the owner's order", () => {
    wrap(<SummaryRow />);
    const s = screen.getByTestId("dash-summary");
    expect(s.className).toContain("panel");
    const grid = s.querySelector(".kpi-grid")!;
    expect(Array.from(grid.children, (c) => c.getAttribute("data-testid") ?? c.firstElementChild?.getAttribute("data-testid"))).toEqual([
      "dash-kpi-checking", "dash-kpi-room", "dash-kpi-low", "dash-kpi-debt",
    ]);
    expect(s.querySelectorAll(".panel").length).toBe(0); // no card inside the card
  });
  it("normal: checking with identity, room with both sublines, low point, debt % with the amount left and its scope", () => {
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-kpi-checking-value").textContent).toBe("$4,200.50");
    expect(screen.getByTestId("dash-kpi-checking").textContent).toContain("Total Checking");
    expect(screen.getByTestId("dash-kpi-checking").textContent).toContain("••5526");
    expect(screen.getByTestId("dash-kpi-room-value").textContent).toBe("$210.00");
    expect(screen.getByTestId("dash-room-week").textContent).toBe("This week's plan $210.00 left");
    expect(screen.getByTestId("dash-room-cover").textContent).toBe("Checking covers $400.00 until Fri Oct 16, after the $500 buffer");
    expect(screen.getByTestId("dash-kpi-debt-value").textContent).toBe("42%");
    expect(screen.getByTestId("dash-debt-left").textContent).toBe("$2,000.25 left on your payoff plan (Amex Blue Cash Preferred and Amex Platinum)");
  });
  it("not_yet: the low point is SHOWN, with its date and 'below your buffer' (it used to be blank)", () => {
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-kpi-low-value").textContent).toBe("$350.00");
    expect(screen.getByTestId("dash-low-when").textContent).toBe("Tue Oct 20 · next 90 days");
    expect(screen.getByTestId("dash-low-words").textContent).toContain("below your $500 buffer");
    expect(screen.getByTestId("dash-low-words").parentElement!.className).toContain("text-bad-ink");
  });
  it("(dash-accuracy) under the buffer says how far short; tight and ready say where it sits", () => {
    const a = wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-under-buffer").textContent).toContain("short by $150.00");
    a.unmount();
    h.spine.data = spine({ forecast: { lowPoint: "620.00", lowPointDate: "2026-10-21", runwayDays: null, cashBuffer: "500.00", status: "tight" } });
    const b = wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-kpi-low-value").textContent).toBe("$620.00");
    expect(screen.getByTestId("dash-low-words").textContent).toContain("just above your $500 buffer");
    expect(screen.queryByTestId("dash-under-buffer")).toBeNull();
    b.unmount();
    h.spine.data = spine({ forecast: { lowPoint: "1500.00", lowPointDate: "2026-10-22", runwayDays: null, cashBuffer: "500.00", status: "ready" } });
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-low-words").textContent).toBe("above your $500 buffer");
  });
  it("negative: the low point carries the alarm tone and says when it goes below zero", () => {
    h.spine.data = spine({ forecast: { lowPoint: "-120.00", lowPointDate: "2026-10-20", runwayDays: 12, cashBuffer: "500.00", status: "not_yet" }, bank: { ...spine().bank, balance: "-40.00" } });
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-kpi-low-value").className).toContain("text-bad");
    expect(screen.getByTestId("dash-runway").textContent).toContain("below zero in 12 days");
    expect(screen.getByTestId("dash-kpi-checking-value").className).toContain("text-bad");
  });
  it("missing: no bank balance means words and an em dash, never $0", () => {
    h.spine.data = spine({
      bank: { balance: "0.00", asOfDate: null, source: null, lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null },
      forecast: { lowPoint: "0.00", lowPointDate: null, runwayDays: null, cashBuffer: "500.00", status: "no_data" },
      position: { ...spine().position, safeToSpendNow: null, availableUntilPayday: null },
      debt: { ...spine().debt, payoffPct: null },
    });
    h.Q.debts = ok([]);
    wrap(<SummaryRow />);
    const row = screen.getByTestId("dash-summary");
    expect(row.textContent).not.toContain("$0.00");
    for (const k of ["checking", "room", "low", "debt"]) {
      expect(screen.getByTestId(`dash-kpi-${k}-value`).textContent).toBe("—");
      expect(screen.getByTestId(`dash-kpi-${k}`).getAttribute("data-missing")).toBe("true");
    }
    expect(screen.getByTestId("dash-kpi-checking-missing").textContent).toContain("No bank balance yet");
    expect(screen.getByTestId("dash-kpi-room-missing").textContent).toContain("Needs a bank balance");
    expect(screen.getByTestId("dash-kpi-low-missing").textContent).toContain("No bank balance yet");
    expect(screen.getByTestId("dash-kpi-debt-missing").textContent).toBe("No debts on the payoff plan yet.");
  });
  it("stale: the figures stay, and the low point says its balance is out of date", () => {
    h.spine.data = spine({ bank: { ...spine().bank, stale: true, staleReason: "old" }, forecast: { ...spine().forecast, status: "ready" } });
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-kpi-checking-value").textContent).toBe("$4,200.50");
    expect(screen.getByTestId("dash-low-words").textContent).toContain("from an out-of-date bank balance");
  });
  it("says how many entries the balance rolls forward on top of the snapshot (manual entries included, by design) — from the spine", () => {
    const at = "2026-10-05T15:00:00Z";
    h.spine.data = spine({ bank: { ...spineBank, asOfDate: at, stale: true, staleReason: "old",
      snapshot: { balance: "4224.50", at, source: "plaid" }, sinceSnapshot: { net: "-24.00", count: 2, through: "2026-10-08" } } });
    const a = wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-since-snapshot").textContent).toBe("Includes 2 entries since the Oct 5 snapshot");
    a.unmount();
    // Nothing rolled on top: nothing said.
    h.spine.data = spine({ bank: { ...spineBank, sinceSnapshot: { net: "0.00", count: 0, through: "2026-10-08" } } });
    const b = wrap(<SummaryRow />);
    expect(screen.queryByTestId("dash-since-snapshot")).toBeNull();
    b.unmount();
    // ⭐ (WP1) A same-day snapshot with an entry after the read says so too: the
    // count is free on the spine now, and the balance is not the bank's figure.
    h.spine.data = spine({ bank: { ...spineBank, asOfDate: "2026-10-08T14:00:00Z",
      snapshot: { balance: "4212.50", at: "2026-10-08T14:00:00Z", source: "plaid" }, sinceSnapshot: { net: "-12.00", count: 1, through: "2026-10-08" } } });
    const c = wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-since-snapshot").textContent).toBe("Includes 1 entry since the Oct 8 snapshot");
    c.unmount();
    // No snapshot at all: nothing to say it rolled from.
    h.spine.data = spine({ bank: { ...spineBank, snapshot: null, sinceSnapshot: null } });
    wrap(<SummaryRow />);
    expect(screen.queryByTestId("dash-since-snapshot")).toBeNull();
  });
  it("(WP1) names the account from the spine itself — no cash-signal read, and an unresolved account says only 'Checking'", () => {
    h.Q.cash = loading;
    const a = wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-kpi-checking").textContent).toContain("Total Checking");
    expect(screen.getByTestId("dash-kpi-checking").textContent).toContain("••5526");
    expect(h.horizons).toEqual([]); // the summary row never asked for the cash signal
    a.unmount();
    h.spine.data = spine({ bank: { ...spineBank, account: { rowId: null, externalId: null, name: null, mask: null, subtype: null, via: "unresolved" } } });
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-kpi-checking").textContent).toContain("Checking");
    expect(screen.getByTestId("dash-kpi-checking").textContent).not.toContain("Total Checking");
  });
  it("over the week's plan: room is the real $0 the position computes, said in words", () => {
    h.spine.data = spine({ position: { ...spine().position, safeToSpendNow: "0.00", remainingWeek: "-25.00", withinPlan: "over" } });
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-kpi-room-value").textContent).toBe("$0.00");
    expect(screen.getByTestId("dash-room-week").textContent).toBe("This week's plan $25.00 over");
    // Small alarm words take the AA rust; the big figure keeps the alarm orange (large text).
    expect(screen.getByTestId("dash-room-week").className).toContain("text-bad-ink");
    expect(screen.getByTestId("dash-kpi-room-value").className).toMatch(/\btext-bad\b/);
  });
  it("(WP4) the amount left names its scope as the payoff plan: one debt, or an and-list", () => {
    h.Q.debts = ok([debt("h1", "HELOC", "18500.00")]);
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-debt-left").textContent).toBe("$18,500.00 left on your payoff plan (HELOC)");
  });
  it("(WP4) the amount left measures the debts % paid measures: an unanchored active debt is in neither", () => {
    h.Q.debts = ok([debt("h1", "HELOC", "18500.00"), debt("z1", "Never anchored", "120.00", { originalBalance: "0.00" })]);
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-debt-left").textContent).toBe("$18,500.00 left on your payoff plan (HELOC)");
  });
  describe("(WP4) the cards the amount left does not cover", () => {
    const amexItem = (o: Record<string, unknown> = {}) => item("b", "American Express", "amex", [
      acct("b1", { name: "Blue Cash Preferred", mask: "1001", type: "credit", subtype: "credit card" }),
      acct("x1", { name: "Platinum Card", mask: "1005", type: "credit", subtype: "credit card" }),
    ], o);
    beforeEach(() => {
      h.Q.items = ok([amexItem()]);
      h.Q.debts = ok([debt("d1", "Amex ••1001", "1500.00", { plaidAccountId: "b1" }), debt("h1", "HELOC", "18500.00")]);
      h.Q.liab = ok([{ id: "x1", accountId: "p-x1", balance: "3842.98", minPayment: null, lastFetchedAt: "2026-10-08T12:00:00Z", suggestedDebt: null }]);
      h.Q.amex = ok({ cards: [{ accountId: "p-x1", cadence: "weekly" }] });
    });
    it("names the card off the plan, says it is paid in full weekly when the weekly payoff bills it so, and links to the plan", () => {
      wrap(<SummaryRow />);
      expect(screen.getByTestId("dash-debt-left").textContent).toBe("$20,000.00 left on your payoff plan (Amex ••1001 and HELOC)");
      expect(screen.getByTestId("dash-debt-offplan").textContent).toBe(
        "American Express Platinum Card ••1005 is paid in full weekly, not on the plan · Put it on the plan",
      );
      expect(screen.getByTestId("dash-debt-offplan-link").getAttribute("href")).toBe("/avalanche");
    });
    it("without the weekly payoff's word (monthly, or not in it), it says only that the card is not on the plan", () => {
      h.Q.amex = ok({ cards: [{ accountId: "p-x1", cadence: "monthly" }] });
      wrap(<SummaryRow />);
      expect(screen.getByTestId("dash-debt-offplan").textContent).toBe("American Express Platinum Card ••1005 is not on the plan · Put it on the plan");
    });
    it("several cards: one sentence, an and-list, 'Put them on the plan'", () => {
      h.Q.debts = ok([debt("h1", "HELOC", "18500.00")]);
      h.Q.liab = ok([
        { id: "b1", accountId: "p-b1", balance: "684.12", suggestedDebt: null },
        { id: "x1", accountId: "p-x1", balance: "3842.98", suggestedDebt: null },
      ]);
      h.Q.amex = ok({ cards: [{ accountId: "p-b1", cadence: "weekly" }, { accountId: "p-x1", cadence: "weekly" }] });
      wrap(<SummaryRow />);
      expect(screen.getByTestId("dash-debt-offplan").textContent).toBe(
        "American Express Blue Cash Preferred ••1001 and American Express Platinum Card ••1005 are paid in full weekly, not on the plan · Put them on the plan",
      );
    });
    it("waits for Plaid's figures and the weekly payoff, so the sentence never changes under the reader", () => {
      h.Q.amex = loading;
      const a = wrap(<SummaryRow />);
      expect(screen.queryByTestId("dash-debt-offplan")).toBeNull();
      a.unmount();
      h.Q.amex = failed; // a failed payoff read drops only the weekly word
      wrap(<SummaryRow />);
      expect(screen.getByTestId("dash-debt-offplan").textContent).toBe("American Express Platinum Card ••1005 is not on the plan · Put it on the plan");
    });
    it("a card off the plan that owes nothing changes nothing about the total, so it is not named", () => {
      h.Q.liab = ok([{ id: "x1", accountId: "p-x1", balance: "0.00", suggestedDebt: null }]);
      wrap(<SummaryRow />);
      expect(screen.queryByTestId("dash-debt-offplan")).toBeNull();
    });
    it("an archived card is off the plan too (and never in the amount left)", () => {
      h.Q.debts = ok([debt("d1", "Amex ••1001", "1500.00", { plaidAccountId: "b1" }), debt("h1", "HELOC", "18500.00"),
        debt("dx", "Amex ••1005", "0.00", { plaidAccountId: "x1", status: "archived", balanceSource: "manual" })]);
      h.Q.amex = ok({ cards: [] }); // a debt-linked card is not in the weekly payoff
      wrap(<SummaryRow />);
      expect(screen.getByTestId("dash-debt-left").textContent).toBe("$20,000.00 left on your payoff plan (Amex ••1001 and HELOC)");
      expect(screen.getByTestId("dash-debt-offplan").textContent).toBe("American Express Platinum Card ••1005 is not on the plan · Put it on the plan");
    });
    it("no debt on the plan at all: the words, and still the card that is off it", () => {
      h.Q.debts = ok([]);
      h.Q.liab = ok([
        { id: "b1", accountId: "p-b1", balance: "0.00", suggestedDebt: null },
        { id: "x1", accountId: "p-x1", balance: "3842.98", suggestedDebt: null },
      ]);
      wrap(<SummaryRow />);
      expect(screen.getByTestId("dash-kpi-debt").textContent).toContain("No debts on the payoff plan yet.");
      expect(screen.getByTestId("dash-debt-offplan").textContent).toContain("American Express Platinum Card ••1005 is paid in full weekly, not on the plan");
    });
  });
  it("the debt line says when its amount did not load, and never a balance on loading", () => {
    h.Q.debts = failed;
    wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-debt-left").textContent).toContain("did not load");
  });
  it("loading draws no figure, a failed first load says so", () => {
    h.spine = { data: undefined, state: "loading", refetch: () => {} };
    const a = wrap(<SummaryRow />);
    expect(screen.getByTestId("dash-summary-loading").textContent).toBe("");
    a.unmount();
    h.spine = { data: undefined, state: "failed", refetch: () => {} };
    wrap(<SummaryRow />);
    expect(screen.getByTestId("panel-error").textContent).toContain("The summary did not load");
  });
  it("names the figures with distinct words, and the scope helpers join names plainly", () => {
    const p = spine().position as never;
    expect(roomLines(p, "500.00", "120.00").cover).toBe("Checking covers $400.00 until Fri Oct 16, after the $500 buffer and $120.00 held for goals");
    expect(roomLines({ ...(p as object), horizonKind: "week_end", paydayDate: null } as never, "500.00").cover).toContain("until the week ends");
    expect(roomLines({ ...(p as object), remainingWeek: null } as never, "500.00").week).toBe("No weekly plan set");
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });
});

// ── Accounts ──────────────────────────────────────────────────────────────
describe("accounts list", () => {
  beforeEach(() => {
    h.Q.items = ok([
      item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "5526" }), acct("s1", { name: "Premier Savings", mask: "7001", subtype: "savings" })]),
      item("b", "American Express", "amex", [acct("x1", { name: "Platinum Card", mask: "1005", type: "credit", subtype: "credit card" })]),
      item("c", "Capital One", "capone", [acct("k1", { name: "Quicksilver", mask: "7788", type: "credit", subtype: "credit card" })],
        { lastSyncedAt: "2026-10-01T12:00:00Z" }),
      item("d", "Wells Fargo", "wells", [acct("w1", { name: "Everyday", mask: "9911" })],
        { lastSyncErrorCode: "ITEM_LOGIN_REQUIRED", lastSyncError: "login" }),
    ]);
    h.Q.cash = ok({ account: cashAcct });
    h.Q.debts = ok([debt("d1", "Amex Platinum", "1500.00", { plaidAccountId: "x1", minPayment: "35.00", dueDay: 22 })]);
    h.Q.amex = ok({ cards: [{ plaidAccountId: "x1", statementBalance: 1200 }] });
  });
  it("is ONE list surface: a row per account, no card per account", () => {
    wrap(<AccountsPanel />);
    const panel = screen.getByTestId("dash-accounts");
    expect(panel.querySelectorAll(".panel").length).toBe(0);
    expect(screen.getAllByTestId("dash-account")).toHaveLength(5);
    expect(panel.className).not.toContain("panel-link"); // no hover lift on a panel that is not a destination
  });
  it("cash held for checking, owed + minimum + due for a card on the debt list, and only fields that exist", () => {
    h.Q.liab = ok([]);
    wrap(<AccountsPanel />);
    const rows = screen.getAllByTestId("dash-account");
    expect(within(rows[0]!).getByTestId("dash-account-balance").textContent).toBe("$4,200.50");
    expect(rows[0]!.textContent).toContain("Cash held");
    expect(within(rows[1]!).getByTestId("dash-account-nobalance").textContent).toContain("Savings balance is not tracked");
    expect(within(rows[2]!).getByTestId("dash-account-balance").textContent).toBe("$1,500.00");
    expect(within(rows[2]!).getByTestId("dash-account-min").textContent).toContain("$35.00");
    expect(within(rows[2]!).getByTestId("dash-account-due").textContent).toContain("the 22nd");
    // A card with nothing reported anywhere says so in words: no dashes or zeros standing in.
    expect(within(rows[3]!).queryByTestId("dash-account-balance")).toBeNull();
    expect(within(rows[3]!).getByTestId("dash-account-nodebt")).toBeTruthy();
    expect(rows[3]!.textContent).not.toContain("$0");
  });
  it("a card that is not on the debt list reads Plaid's stored liability figures as ITS balance, never 'Owed'; a missing one is words, never $0", () => {
    h.Q.debts = ok([]);
    h.Q.liab = ok([
      { id: "x1", accountId: "p-x1", balance: "684.12", minPayment: "40.00", lastFetchedAt: "2026-10-08T11:00:00Z", suggestedDebt: { name: "Platinum", type: "credit_card", dueDay: 14 } },
      { id: "k1", accountId: "p-k1", balance: null, minPayment: null, suggestedDebt: { name: "Quicksilver", type: "credit_card", dueDay: 22 } },
    ]);
    wrap(<AccountsPanel />);
    const rows = screen.getAllByTestId("dash-account");
    // (WP3) Off the payoff plan: the card's own current balance, named, and the plan words.
    expect(within(rows[2]!).queryByTestId("dash-account-balance")).toBeNull();
    expect(within(rows[2]!).getByTestId("dash-account-creditor").textContent).toBe("Card's current balance$684.12");
    expect(within(rows[2]!).getByTestId("dash-account-plan").textContent).toBe("Not on the payoff plan");
    expect(rows[2]!.getAttribute("data-plan")).toBe("off_plan");
    expect(within(rows[2]!).getByTestId("dash-account-min").textContent).toContain("$40.00");
    expect(within(rows[2]!).getByTestId("dash-account-due").textContent).toContain("the 14th");
    expect(rows[2]!.textContent).not.toContain("Owed");
    expect(within(rows[3]!).getByTestId("dash-account-noowed").textContent).toBe("not reported");
    expect(within(rows[3]!).queryByTestId("dash-account-min")).toBeNull();
    expect(rows[3]!.textContent).not.toContain("$0");
  });
  it("(WP3) an archived debt is 'Paid off · not on the payoff plan': never Owed, its own balance named", () => {
    h.Q.debts = ok([debt("d1", "Amex Platinum", "3842.98", { plaidAccountId: "x1", status: "archived", balanceSource: "plaid", lastBalanceUpdate: "2026-10-08T11:00:00Z" })]);
    h.Q.liab = ok([]);
    wrap(<AccountsPanel />);
    const row = screen.getAllByTestId("dash-account")[2]!;
    expect(row.getAttribute("data-plan")).toBe("archived");
    expect(within(row).getByTestId("dash-account-plan").textContent).toBe("Paid off · not on the payoff plan");
    expect(within(row).queryByTestId("dash-account-balance")).toBeNull();
    expect(row.textContent).not.toContain("Owed");
    expect(within(row).getByTestId("dash-account-creditor").textContent).toBe("Card's current balance$3,842.98");
  });
  it("(WP3) an archived row typed at $0.00 never poses as the card's balance: Plaid's stored figure does, and it waits for it", () => {
    h.Q.debts = ok([debt("d1", "Amex Platinum", "0.00", { plaidAccountId: "x1", status: "archived", balanceSource: "manual", dueDay: 22 })]);
    h.Q.liab = loading;
    const { unmount } = wrap(<AccountsPanel />);
    let row = screen.getAllByTestId("dash-account")[2]!;
    expect(row.textContent).not.toContain("$0.00"); // a skeleton while Plaid's figures load
    expect(within(row).getByTestId("dash-account-plan").textContent).toBe("Paid off · not on the payoff plan");
    unmount();
    h.Q.liab = ok([{ id: "x1", accountId: "p-x1", balance: "1940.00", minPayment: "40.00", lastFetchedAt: "2026-10-08T15:00:00Z", suggestedDebt: null }]);
    wrap(<AccountsPanel />);
    row = screen.getAllByTestId("dash-account")[2]!;
    expect(within(row).getByTestId("dash-account-creditor").textContent).toBe("Card's current balance$1,940.00");
    expect(within(row).getByTestId("dash-account-due").textContent).toContain("the 22nd");
    expect(row.textContent).not.toContain("$0.00");
  });
  it("(WP4) a row off the plan links onto it; a row on the plan does not", () => {
    h.Q.debts = ok([debt("d1", "Amex Platinum", "1500.00", { plaidAccountId: "x1" })]);
    h.Q.liab = ok([{ id: "k1", accountId: "p-k1", balance: "642.18", minPayment: null, suggestedDebt: null }]);
    wrap(<AccountsPanel />);
    const rows = screen.getAllByTestId("dash-account");
    expect(within(rows[2]!).queryByTestId("dash-account-add-plan")).toBeNull(); // Platinum is on the plan
    expect(within(rows[3]!).getByTestId("dash-account-plan-row").textContent).toBe("Not on the payoff plan · Add to the plan");
    expect(within(rows[3]!).getByTestId("dash-account-add-plan").getAttribute("href")).toBe("/avalanche");
  });
  it("(WP3) the live case: Owed is netted, and the card's own balance sits beside it, each named", () => {
    h.Q.debts = ok([debt("d1", "Amex Platinum", "3842.98", { plaidAccountId: "x1", pendingPaymentTotal: "2615.71", pendingPaymentCount: 2 })]);
    wrap(<AccountsPanel />);
    const row = screen.getAllByTestId("dash-account")[2]!;
    expect(within(row).getByTestId("dash-account-balance").textContent).toBe("$1,227.27");
    expect(within(row).getByTestId("dash-account-creditor").textContent).toBe("Card's current balance$3,842.98");
    expect(within(row).getByTestId("dash-account-pending").textContent).toBe("Paid, not posted$2,615.71");
    expect(within(row).queryByTestId("dash-account-plan")).toBeNull(); // on the plan: nothing to say
  });
  it("(WP3) a card with no pending payment shows Owed once (its own balance is the same figure)", () => {
    wrap(<AccountsPanel />);
    const row = screen.getAllByTestId("dash-account")[2]!;
    expect(within(row).getByTestId("dash-account-balance").textContent).toBe("$1,500.00");
    expect(within(row).queryByTestId("dash-account-creditor")).toBeNull();
  });
  it("(WP3) freshness is three named stamps; 'data through' is the newest bank row, never the sync day", () => {
    h.Q.items = ok([
      item("b", "American Express", "amex", [acct("x1", { name: "Platinum Card", mask: "1005", type: "credit", subtype: "credit card" })],
        { lastSyncedAt: "2026-10-08T15:00:00Z", lastBankTxOn: "2026-10-06" }),
    ]);
    h.Q.debts = ok([debt("d1", "Amex Platinum", "1500.00", { plaidAccountId: "x1", lastBalanceUpdate: "2026-10-08T12:00:00Z" })]);
    wrap(<AccountsPanel />);
    const fresh = screen.getByTestId("dash-account-fresh").textContent!;
    expect(fresh).toBe("Up to date · synced 2 h ago · balance read 5 h ago · data through Oct 6");
    expect(fresh).not.toContain("Oct 8");
  });
  it("(WP3) savings shows its last reading, not rolled forward, or says it is not tracked", () => {
    h.Q.items = ok([
      item("a", "Chase", "chase", [
        acct("s1", { name: "Premier Savings", mask: "7001", subtype: "savings", snapshot: { balance: "0.00", at: "2026-10-06T14:00:00Z", source: "plaid" } }),
        acct("s2", { name: "Goal Savings", mask: "7002", subtype: "savings", snapshot: null }),
      ]),
    ]);
    wrap(<AccountsPanel />);
    const rows = screen.getAllByTestId("dash-account");
    // A real zero reading is $0.00, never dropped; the words say it is a reading.
    expect(within(rows[0]!).getByTestId("dash-account-snapshot").textContent).toBe("Snapshot $0.00 · as of Oct 6 · not rolled forward");
    expect(within(rows[0]!).getByTestId("dash-account-fresh").textContent).toContain("balance read 2 d ago");
    expect(within(rows[1]!).getByTestId("dash-account-nobalance").textContent).toBe("Savings balance is not tracked yet.");
  });
  it("no bank linked: an honest empty state with the existing link path", () => {
    h.Q.items = ok([]);
    wrap(<AccountsPanel />);
    expect(screen.getByTestId("dash-accounts-empty").textContent).toContain("No bank accounts are linked yet");
    expect(screen.getByTestId("dash-accounts-link-bank").getAttribute("href")).toBe("/settings");
  });
  it("full names and ••last4, never truncated", () => {
    wrap(<AccountsPanel />);
    const names = screen.getAllByTestId("dash-account-name");
    expect(names[0]!.textContent).toBe("Chase Total Checking");
    expect(names[0]!.className).not.toContain("truncate");
    expect(screen.getAllByTestId("dash-account-link")[0]!.textContent).toContain("••5526");
  });
  it("names stale and reconnect states with the app's own reason", () => {
    wrap(<AccountsPanel />);
    const rows = screen.getAllByTestId("dash-account");
    expect(rows[0]!.getAttribute("data-state")).toBe("ok");
    expect(rows[3]!.getAttribute("data-state")).toBe("stale");
    expect(within(rows[3]!).getByTestId("dash-account-state").textContent).toBe("Out of date");
    expect(rows[4]!.getAttribute("data-state")).toBe("reauth");
    expect(within(rows[4]!).getByTestId("dash-account-reason").textContent!.length).toBeGreaterThan(10);
  });
  it("links each account to its view, and Sync once per BANK", () => {
    wrap(<AccountsPanel />);
    const links = screen.getAllByTestId("dash-account-link").map((a) => a.getAttribute("href"));
    // (WP7) By the EXTERNAL Plaid account_id (`acct()` gives "p-<id>"), the id
    // the account chips, the route and every transaction use (`accountPageHref`).
    expect(links).toEqual(["/next/accounts/p-c1", "/next/accounts/p-s1", "/next/accounts/p-x1", "/next/accounts/p-k1", "/next/accounts/p-w1"]);
    for (const b of ["a", "b", "c", "d"]) expect(screen.getAllByTestId(`dash-sync-${b}`)).toHaveLength(1);
    expect(screen.getByTestId("dash-all-accounts").getAttribute("href")).toBe("/next/accounts");
  });
  it("nets a payment the card has not posted yet, and says so", () => {
    h.Q.debts = ok([debt("d1", "Amex Platinum", "1500.00", { plaidAccountId: "x1", pendingPaymentTotal: "300.00", pendingPaymentCount: 1 })]);
    wrap(<AccountsPanel />);
    const row = screen.getAllByTestId("dash-account")[2]!;
    expect(within(row).getByTestId("dash-account-balance").textContent).toBe("$1,200.00"); // $1,500 reported − $300 paid
    expect(within(row).getByTestId("dash-account-pending").textContent).toContain("$300.00");
  });
  it("⭐ parity: each on-plan card's Owed is the netted figure the summary tile sums (every active debt here is a linked card)", () => {
    // (WP3) Debts link by the account's INTERNAL row id (`debts.plaid_account_id`
    // is a uuid FK to `plaid_accounts.id`); Plaid's external id never matches.
    const debts = [
      debt("d1", "Amex Platinum", "1500.00", { plaidAccountId: "x1", pendingPaymentTotal: "300.00", pendingPaymentCount: 1 }),
      debt("d2", "Quicksilver", "642.18", { plaidAccountId: "k1" }),
    ];
    h.Q.debts = ok(debts);
    h.Q.pos = ok({ reservesHeld: "0.00" });
    wrap(<><SummaryRow /><AccountsPanel /></>);
    const owed = screen.getAllByTestId("dash-account-balance")
      .filter((el) => el.closest("[data-testid='dash-account']")?.querySelector("[data-testid='dash-account-facts'] dt")?.textContent === "Owed")
      .map((el) => Number(el.textContent!.replace(/[$,]/g, "")));
    const sum = Math.round(owed.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(sum).toBe(Math.round(remainingDebtTotal(debts as never) * 100) / 100); // 1,200.00 + 642.18
    expect(sum).toBe(1842.18);
    expect(screen.getByTestId("dash-debt-left").textContent).toContain("$1,842.18 left on your payoff plan (");
  });
  it("shows a skeleton while loading and an error when it failed", () => {
    h.Q.items = loading;
    const { unmount } = wrap(<AccountsPanel />);
    expect(screen.getByTestId("panel-skeleton")).toBeTruthy();
    unmount();
    h.Q.items = failed;
    wrap(<AccountsPanel />);
    expect(screen.getByTestId("panel-error").textContent).toContain("Accounts did not load");
  });
});

// ── Coming up ─────────────────────────────────────────────────────────────
describe("coming up", () => {
  const signal = {
    account: cashAcct,
    hookAmountIgnored: [{ itemId: "r6", cadence: "weekly", storedAmount: "450.00" }],
    events: [
      { date: "2026-10-09", label: "Paycheck", amount: "2000.00", itemId: "r1" },
      { date: "2026-10-10", label: "Rent", amount: "-1200.00", itemId: "r2", occurrenceDate: "2026-10-10" },
      { date: "2026-10-10", label: "Weekly Spend", amount: "-612.40", itemId: "r6", occurrenceDate: "2026-10-10" },
      { date: "2026-10-12", label: "Visa payment", amount: "-150.00", itemId: "r3" },
      { date: "2026-10-14", label: "Car loan", amount: "-300.00", itemId: "r4" },
      { date: "2026-10-20", label: "Phone", amount: "-80.00", itemId: "r5" },
      { date: "2026-10-30", label: "Sixth", amount: "-10.00", itemId: "r7" },
      { date: "2026-10-31", label: "Visa minimum", amount: "-35.00", itemId: "debt:d1" },
      { date: "2026-10-01", label: "Already past", amount: "-10.00", itemId: "r8" },
    ],
  };
  beforeEach(() => {
    h.Q.cash = ok(signal);
    h.Q.debts = ok([{ id: "d1", type: "credit_card" }, { id: "d2", type: "auto" }]);
    h.Q.recurring = ok([
      { id: "r2", frequency: "monthly" }, { id: "r3", debtId: "d1", frequency: "monthly" },
      { id: "r4", debtId: "d2", frequency: "monthly" }, { id: "r5", frequency: "monthly" }, { id: "r6", frequency: "weekly" },
    ]);
  });
  it("the next 5 payments out, soonest first: one payment each, frequency word, card/debt kind, paid-from chip", () => {
    wrap(<UpcomingPanel />);
    const rows = screen.getAllByTestId("dash-up-row");
    expect(rows.map((r) => r.querySelector("[data-testid='dash-up-amount']")!.textContent)).toEqual([
      "$1,200.00", "$612.40", "$150.00", "$300.00", "$80.00",
    ]);
    expect(rows[0]!.textContent).toContain("monthly");
    expect(rows[2]!.textContent).toContain("card payment");
    expect(rows[3]!.textContent).toContain("debt payment");
    expect(within(screen.getByTestId("dash-up-list")).queryByText("Paycheck")).toBeNull(); // money in is not an obligation…
    expect(screen.getByTestId("dash-up-payday").textContent).toContain("Paycheck"); // …it is the footnote
    expect(screen.getByTestId("dash-up-from").textContent).toContain("Total Checking");
    expect(screen.getByTestId("dash-all-bills").getAttribute("href")).toBe("/bills");
  });
  it("a debt minimum scheduled from the debt itself (itemId debt:<id>) is a card or debt payment too", () => {
    const rows = upcomingRows({ signal: signal as never, recurring: [], debts: [{ id: "d1", type: "credit_card" }, { id: "d2", type: "auto" }], today: "2026-10-08", count: 20 });
    const visa = rows.find((r) => r.label === "Visa minimum")!;
    expect(visa.kind).toBe("card");
    expect(Math.abs(visa.amount)).toBe(35);
    const extra = upcomingRows({ signal: { events: [{ date: "2026-10-09", label: "Avalanche extra", amount: "-200.00", itemId: "avalanche:extra" }] } as never, today: "2026-10-08" })[0]!;
    expect(extra.kind).toBe("debt");
  });
  it("labels a Weekly Spend hook as the card payoff, with the item's own plan amount", () => {
    wrap(<UpcomingPanel />);
    const hook = screen.getAllByTestId("dash-up-row")[1]!;
    expect(hook.textContent).toContain("Weekly Spend");
    expect(within(hook).getByTestId("dash-up-hook").textContent).toContain("card payoff (plan $450)");
  });
  it("⭐ ONE next obligation, ONE amount: header, Needs attention and Coming up read the same hook-aware event", () => {
    // The hooked Weekly Spend is due TOMORROW and is the first thing to leave checking.
    h.Q.cash = ok({
      account: cashAcct,
      hookAmountIgnored: [{ itemId: "r6", cadence: "weekly", storedAmount: "450.00" }],
      events: [
        { date: "2026-10-09", label: "Weekly Spend", amount: "-477.57", itemId: "r6" },
        { date: "2026-10-12", label: "Spectrum Internet", amount: "-79.99", itemId: "r5" },
      ],
    });
    h.spine.data = spine({ reviewCount: 0 }); // the spine's own nextBill ($1,200 Rent) is NOT what the dashboard quotes now
    h.Q.items = ok([]);
    h.Q.queue = ok({ total: 0 }); h.Q.dups = ok({ duplicateCount: 0 }); h.Q.findings = ok({ findings: [] });
    h.Q.txns = ok([]); h.Q.cats = ok([]);
    wrap(<><DashboardHeader /><UpcomingPanel /><AttentionPanel /></>);
    const words = "Weekly Spend · card payoff $477.57 (plan $450)";
    expect(screen.getByTestId("dash-fact-next").textContent).toBe(`Next: ${words} · Fri Oct 9`);
    const first = screen.getAllByTestId("dash-up-row")[0]!;
    expect(first.getAttribute("data-next")).toBe("true");
    expect(within(first).getByTestId("dash-up-amount").textContent).toBe("$477.57");
    expect(within(first).getByTestId("dash-up-hook").textContent).toContain("card payoff (plan $450)");
    const due = screen.getByTestId("dash-att-bill");
    expect(due.textContent).toContain(words);
    expect(due.textContent).toContain("Due tomorrow");
    // The stored $450 alone (what the Bills page and morning text quote) appears nowhere as the amount.
    expect(screen.getByTestId("dash-fact-next").textContent).not.toMatch(/Weekly Spend \$450/);
    // And a regular bill reads its one payment.
    expect(obligationLine(upcomingRows({ signal: { events: [{ date: "2026-10-10", label: "Rent", amount: "-1200.00" }] } as never, today: "2026-10-08" })[0]!)).toBe("Rent $1,200.00 · Sat Oct 10");
  });
  it("says so when nothing is scheduled", () => {
    h.Q.cash = ok({ account: { via: "unresolved" }, events: [] });
    wrap(<UpcomingPanel />);
    expect(screen.getByText(/Nothing is scheduled/)).toBeTruthy();
  });
});

// ── Forecast ──────────────────────────────────────────────────────────────
describe("cash-flow forecast", () => {
  const signal = (o: Record<string, unknown> = {}) => ({
    status: "ready", cashBuffer: "500.00", lowestProjected: "350.00", lowestDate: "2026-10-20", events: [],
    daily: [{ date: "2026-10-09", balance: "4000.00" }, { date: "2026-10-20", balance: "350.00" }, { date: "2026-10-21", balance: "-20.00" }], ...o,
  });
  it("loads the chart lazily with the 90-day default; the legend names the low point in THESE days", async () => {
    h.Q.cash = ok(signal());
    wrap(<ForecastPanel />);
    expect(h.horizons[0]).toBe(90);
    expect(screen.getByTestId("dash-forecast-low").textContent).toBe("Low point in these 90 days: $350.00 on Tue Oct 20");
    await waitFor(() => expect(screen.getByTestId("chart-stub").textContent).toBe("3 points, buffer 500, short label"));
    expect(screen.getByTestId("dash-forecast-link").getAttribute("href")).toBe("/forecast");
    expect(screen.getByTestId("dash-forecast-chart").className).toContain("h-80");
  });
  it("⭐ at 90 days the legend's low point equals the summary row's (one figure, two places)", () => {
    h.Q.cash = ok({ ...signal(), lowestProjected: "350.00", lowestDate: "2026-10-20", account: cashAcct });
    h.Q.pos = ok({ reservesHeld: "0.00" });
    h.Q.debts = ok([]);
    wrap(<><SummaryRow /><ForecastPanel /></>);
    const kpi = screen.getByTestId("dash-kpi-low-value").textContent!;
    expect(screen.getByTestId("dash-forecast-low").textContent).toContain(kpi);
  });
  it("switches horizon and says which", () => {
    h.Q.cash = ok(signal());
    wrap(<ForecastPanel />);
    fireEvent.click(screen.getByTestId("dash-horizon-30"));
    expect(h.horizons.at(-1)).toBe(30);
    expect(screen.getByTestId("dash-horizon-30").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("dash-forecast-low").textContent).toContain("these 30 days");
  });
  it("draws nothing false when there is no bank balance", () => {
    h.Q.cash = ok(signal({ status: "no_data" }));
    wrap(<ForecastPanel />);
    expect(screen.getByTestId("dash-forecast-empty")).toBeTruthy();
    expect(screen.queryByTestId("dash-forecast-chart")).toBeNull();
  });
});

// ── Spending pace ─────────────────────────────────────────────────────────
describe("spending pace", () => {
  beforeEach(() => {
    h.Q.pos = ok({ spentWeekDiscretionary: "80.00", weekCap: "200.00", remainingWeek: "120.00", paceAllowedToday: "142.86", weekStart: "2026-10-04", weekEnd: "2026-10-10" });
    h.Q.budget = ok({ summary: { expenses: { budget: "3000.00", actual: "3200.00" } } });
  });
  it("week vs plan and month vs budget, each with its period, scope and an even-pace tick", () => {
    wrap(<SpendingPanel />);
    expect(screen.getByTestId("dash-week-meter").textContent).toContain("$80.00");
    expect(screen.getByTestId("dash-week-meter-scope").textContent).toBe("Sun Oct 4 – Sat Oct 10 · discretionary spending");
    expect(screen.getByTestId("dash-week-meter-status").textContent).toBe("$120.00 left in the plan");
    expect(screen.getByTestId("dash-month-meter-scope").textContent).toBe("October 1–31 · budgeted expense categories");
    expect(screen.getByTestId("dash-month-meter-status").textContent).toBe("$200.00 over");
    expect(screen.getAllByTestId("meter-pace")).toHaveLength(2);
  });
  it("the week's words come from the position's remainingWeek, the same figure the summary quotes", () => {
    h.Q.pos = ok({ spentWeekDiscretionary: "80.00", weekCap: "200.00", remainingWeek: "-40.00", paceAllowedToday: "142.86", weekStart: "2026-10-04", weekEnd: "2026-10-10" });
    wrap(<SpendingPanel />);
    expect(screen.getByTestId("dash-week-meter-status").textContent).toBe("$40.00 over the plan");
  });
  it("says no plan set instead of inventing one", () => {
    h.Q.pos = ok({ spentWeekDiscretionary: "80.00", weekCap: null, remainingWeek: null, paceAllowedToday: null, weekStart: "2026-10-04", weekEnd: "2026-10-10" });
    wrap(<SpendingPanel />);
    expect(screen.getByTestId("dash-week-meter-status").textContent).toBe("No weekly plan set");
  });
  it("quotes all household spending from the spine, and links the detail that moved off the dashboard", () => {
    wrap(<SpendingPanel />);
    expect(screen.getByTestId("dash-spent-week").textContent).toBe("$120.00");
    expect(screen.getByTestId("dash-spent-month").textContent).toBe("$900.00");
    expect(screen.getByTestId("dash-link-allowances").getAttribute("href")).toBe("/allowances");
    expect(screen.getByTestId("dash-link-biggest").getAttribute("href")).toBe("/banking");
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/budget");
  });
});

// ── Debt progress ─────────────────────────────────────────────────────────
describe("debt progress", () => {
  it("% paid meter, paid down, new charges, milestone, with the plan and report links", () => {
    h.Q.debts = ok([debt("d1", "Visa", "500.00")]);
    wrap(<DebtPanel />);
    expect(screen.getByTestId("dash-debt-paid").textContent).toContain("42%");
    expect(screen.getByTestId("dash-debt-paid-down").textContent).toBe("$300.00");
    expect(screen.getByTestId("dash-debt-new").textContent).toBe("$80.00");
    expect(screen.getByTestId("dash-debt-milestone").textContent).toContain("Visa paid off · Mar 2027");
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/avalanche", "/reports/debt"]));
    // The amount owed is the summary tile's job; this panel carries no balance.
    expect(screen.getByTestId("dash-debt").textContent).not.toMatch(/left on your payoff plan|Total balance/);
  });
  it("no debts at all: words and the way to add one, never a row of $0.00", () => {
    h.Q.debts = ok([]);
    h.spine.data = spine({ debt: { payoffPct: null, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 } });
    wrap(<DebtPanel />);
    expect(screen.getByTestId("dash-debt-empty").textContent).toContain("No debts are on the payoff plan yet");
    expect(screen.getByTestId("dash-debt").textContent).not.toContain("$0.00");
  });
  it("blanks % paid and says there is no milestone when the spine has none", () => {
    h.Q.debts = ok([debt("d1", "Visa", "500.00")]);
    h.spine.data = spine({ debt: { payoffPct: null, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 } });
    wrap(<DebtPanel />);
    expect(screen.getByTestId("dash-debt-paid").textContent).toContain("—");
    expect(screen.getByTestId("dash-debt-milestone").textContent).toContain("None on the plan yet");
  });
});

// ── Needs attention ───────────────────────────────────────────────────────
describe("needs attention", () => {
  beforeEach(() => {
    h.Q.cash = h.Q.cash ?? ok({ account: cashAcct, events: [] });
    h.Q.findings = ok({ findings: [] });
    h.Q.txns = ok([]);
    h.Q.cats = ok([]);
    h.Q.items = ok([]);
  });
  it("one list: the bank, the week, and the two review queues worded distinctly", () => {
    h.spine.data = spine({ bank: { ...spine().bank, stale: true, staleReason: "refresh_failed" }, position: { ...spine().position, withinPlan: "over", remainingWeek: "-25.00" } });
    h.Q.queue = ok({ total: 7 });
    h.Q.dups = ok({ duplicateCount: 2 });
    wrap(<AttentionPanel />);
    expect(screen.getByTestId("dash-att-reconnect").getAttribute("href")).toBe("/settings");
    expect(screen.getByTestId("dash-att-over").textContent).toContain("Over this week's limit by $25.00");
    expect(screen.getByTestId("dash-review-forecast").textContent).toContain("Charges to match to the forecast");
    expect(screen.getByTestId("dash-review-forecast").getAttribute("href")).toBe("/review");
    expect(screen.getByTestId("dash-review-cats").textContent).toContain("Categories to confirm");
    expect(screen.getByTestId("dash-review-cats").getAttribute("href")).toBe("/review/categories");
    expect(screen.getByTestId("dash-review-dups").getAttribute("href")).toBe("/transactions");
    // Each count beside its own queue (spine.reviewCount 3 · categories 7 · duplicates 2).
    expect(screen.getByTestId("dash-review-forecast").textContent).toContain("3");
    expect(screen.getByTestId("dash-review-cats").textContent).toContain("7");
    expect(screen.getByTestId("dash-review-dups").textContent).toContain("2");
    expect(screen.getByTestId("dash-review-forecast").textContent).not.toContain("7");
    expect(screen.getByTestId("dash-review-cats").textContent).not.toContain("3");
  });
  const incomeRow = (o: Record<string, unknown>) => ({
    id: "t1", occurredOn: "2026-10-08", description: "ACME PAYROLL DIRECT DEP", amount: "2100.00", source: "plaid:chase", plaidAccountId: "p-c1", categoryId: "dining",
    isTransfer: false, debtId: null, isExternalCardPayment: false, reimbursable: false, pfcDetailed: "INCOME_WAGES", ...o,
  });
  const incomeSetup = () => {
    h.spine.data = spine({ reviewCount: 0 });
    h.Q.queue = ok({ total: 0 });
    h.Q.dups = ok({ duplicateCount: 0 });
    h.Q.cats = ok([{ id: "dining", name: "Dining & Coffee", kind: "expense" }]);
    h.Q.items = ok([item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "5526" })])]);
  };
  it("(dash-accuracy) flags income filed under an expense category, by the shared rule, linking to the row", () => {
    incomeSetup();
    h.Q.txns = ok([incomeRow({}), incomeRow({ id: "t2", reimbursable: true, description: "VENMO FROM J" }), incomeRow({ id: "t3", amount: "-8.00" })]);
    wrap(<AttentionPanel />);
    const r = screen.getByTestId("dash-review-income");
    expect(r.textContent).toContain("Income filed under an expense category");
    expect(r.textContent).toContain("ACME PAYROLL DIRECT DEP · Dining & Coffee");
    expect(r.textContent).not.toContain("more"); // the reimbursable credit is not flagged
    // (WP7) It opens the ledger that lists the row — its checking account's page — on its month, filtered to its category.
    expect(r.getAttribute("href")).toBe("/next/accounts/p-c1?tx=t1&month=2026-10-01&category=Dining%20%26%20Coffee");
  });
  it("(WP7) the income row opens where its row is listed, per kind; a row no ledger lists says so, never a dead link", () => {
    incomeSetup();
    // A manual entry: the checking ledger.
    h.Q.txns = ok([incomeRow({ plaidAccountId: null, source: "manual" })]);
    const a = wrap(<AttentionPanel />);
    expect(screen.getByTestId("dash-review-income").getAttribute("href")).toBe("/transactions?tx=t1&month=2026-10-01&category=Dining%20%26%20Coffee");
    a.unmount();
    // A card that is no longer linked: no link, the reason in words, the count kept.
    h.Q.txns = ok([incomeRow({ plaidAccountId: "p-gone", source: "plaid:chase" })]);
    wrap(<AttentionPanel />);
    const r = screen.getByTestId("dash-review-income");
    expect(r.tagName).toBe("LI");
    expect(r.querySelector("a")).toBeNull();
    expect(r.textContent).toContain("Income filed under an expense category");
    expect(r.textContent).toContain("ACME PAYROLL DIRECT DEP · Dining & Coffee");
    expect(r.textContent).toContain("No ledger: Chase (no longer linked)");
    expect(r.textContent).toContain("1");
  });
  it("(WP7) the income check waits for the linked accounts: without them every row would read 'no longer linked'", () => {
    incomeSetup();
    h.Q.txns = ok([incomeRow({})]);
    h.Q.items = loading;
    const a = wrap(<AttentionPanel />);
    expect(screen.queryByTestId("dash-review-income")).toBeNull();
    expect(screen.getByTestId("dash-review-income-pending").textContent).toContain("loading");
    expect(screen.queryByText("Nothing needs you today.")).toBeNull();
    a.unmount();
    h.Q.items = failed;
    wrap(<AttentionPanel />);
    expect(screen.getByTestId("dash-review-income-pending").textContent).toContain("did not load");
  });
  it("keeps the monitor's findings (Why / Resolve / Dismiss live in FindingsList)", () => {
    h.Q.queue = ok({ total: 0 });
    h.Q.dups = ok({ duplicateCount: 0 });
    h.Q.findings = ok({ findings: [{ id: "f1" }] });
    wrap(<AttentionPanel />);
    expect(screen.getByTestId("findings-stub").textContent).toBe("1 findings");
  });
  it("(D20) a queue that is loading or failed is never 'nothing needs you'", () => {
    h.spine.data = spine({ reviewCount: 0 });
    h.Q.dups = ok({ duplicateCount: 0 });
    h.Q.queue = loading;
    const { unmount } = wrap(<AttentionPanel />);
    expect(screen.queryByText("Nothing needs you today.")).toBeNull();
    expect(screen.getByTestId("dash-review-cats-pending").textContent).toContain("loading");
    unmount();
    h.Q.queue = failed;
    wrap(<AttentionPanel />);
    expect(screen.getByTestId("dash-review-cats-pending").textContent).toContain("did not load");
  });
  it("an all-clear only when every source answered", () => {
    h.spine.data = spine({ reviewCount: 0 });
    h.Q.queue = ok({ total: 0 });
    h.Q.dups = ok({ duplicateCount: 0 });
    wrap(<AttentionPanel />);
    expect(screen.getByText("Nothing needs you today.")).toBeTruthy();
  });
  it("findings, the recent window and the cash signal hold the all-clear while they load, and say so when they fail", () => {
    h.spine.data = spine({ reviewCount: 0 });
    h.Q.queue = ok({ total: 0 });
    h.Q.dups = ok({ duplicateCount: 0 });
    for (const [key, testid] of [["findings", "dash-findings-pending"], ["txns", "dash-review-income-pending"], ["cash", "dash-att-due-pending"]] as const) {
      const keep = h.Q[key];
      h.Q[key] = loading;
      const a = wrap(<AttentionPanel />);
      expect(screen.queryByText("Nothing needs you today."), key).toBeNull();
      expect(screen.getByTestId(testid).textContent, key).toContain("loading");
      a.unmount();
      h.Q[key] = failed;
      const b = wrap(<AttentionPanel />);
      expect(screen.getByTestId(testid).textContent, key).toContain("did not load");
      expect(within(screen.getByTestId(testid)).getByRole("button", { name: "Try again" })).toBeTruthy();
      b.unmount();
      h.Q[key] = keep;
    }
  });
  it("a spine failure hides only the spine's rows: the queues and the findings (with their actions) still show", () => {
    h.spine = { data: undefined, state: "failed", refetch: () => {} };
    h.Q.queue = ok({ total: 7 });
    h.Q.dups = ok({ duplicateCount: 0 });
    h.Q.findings = ok({ findings: [{ id: "f1" }] });
    wrap(<AttentionPanel />);
    expect(screen.getByTestId("dash-att-spine-pending").textContent).toContain("did not load");
    expect(screen.getByTestId("dash-review-forecast-pending").textContent).toContain("did not load");
    expect(screen.getByTestId("dash-review-cats").textContent).toContain("7");
    expect(screen.getByTestId("findings-stub").textContent).toBe("1 findings");
    expect(screen.queryByTestId("panel-error")).toBeNull();
  });
  it("a full recent window says the income check stopped at the newest 100 rows, and is never 'nothing'", () => {
    h.spine.data = spine({ reviewCount: 0 });
    h.Q.queue = ok({ total: 0 });
    h.Q.dups = ok({ duplicateCount: 0 });
    h.Q.cats = ok([{ id: "food", name: "Groceries", kind: "expense" }]);
    h.Q.txns = ok(Array.from({ length: 100 }, (_, i) => ({
      id: `t${i}`, occurredOn: "2026-10-08", description: `Shop ${i}`, amount: "-5.00", source: "plaid:chase", categoryId: "food",
      isTransfer: false, debtId: null, isExternalCardPayment: false, reimbursable: false, pfcDetailed: null,
    })));
    wrap(<AttentionPanel />);
    expect(screen.queryByText("Nothing needs you today.")).toBeNull();
    expect(screen.getByTestId("dash-review-income-capped").textContent).toContain("older rows of the last 30 days were not checked");
  });
});

// ── Recent activity ───────────────────────────────────────────────────────
describe("recent activity", () => {
  it("six rows as a list with identity, status and category; All activity opens the ledger", () => {
    h.Q.items = ok([item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "4821" })])]);
    h.Q.cats = ok([{ id: "cat1", name: "Groceries" }]);
    // ⚠️ (dash-accuracy) A transaction carries Plaid's EXTERNAL account_id
    // (`acct()` gives each account `accountId: "p-<id>"`), never the internal row id.
    h.Q.txns = ok([
      { id: "t1", occurredOn: "2026-10-07", description: "Aldi", amount: "-32.10", plaidAccountId: "p-c1", source: "plaid:chase", pending: false, categoryId: "cat1" },
      { id: "t2", occurredOn: "2026-10-07", description: "Cash deposit", amount: "50.00", plaidAccountId: null, source: "manual", account: "Manual", pending: true, categoryId: null },
    ]);
    wrap(<ActivityPanel />);
    expect(screen.getByTestId("txn-list")).toBeTruthy();
    const rows = screen.getAllByTestId("txn-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Aldi");
    expect(rows[0]!.textContent).toContain("Groceries");
    expect(rows[0]!.querySelector('[title="Chase Total Checking"]')).toBeTruthy();
    expect(rows[1]!.querySelector('[title="Manual entry"]')).toBeTruthy();
    expect(rows[0]!.textContent).toContain("••4821");
    expect(rows[0]!.textContent).toContain("Posted");
    expect(rows[0]!.textContent).toContain("-$32.10");
    expect(rows[1]!.textContent).toContain("Pending");
    expect(rows[1]!.textContent).toContain("Uncategorized");
    expect(screen.getByTestId("dash-all-activity").getAttribute("href")).toBe("/transactions");
  });
  it("(dash-accuracy) never prints a bare 'Account': every source is named honestly", () => {
    h.Q.items = ok([item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "4821" })])]);
    h.Q.cats = ok([]);
    h.Q.txns = ok([
      { id: "t1", occurredOn: "2026-10-07", description: "Workbook row", amount: "18.00", plaidAccountId: null, source: "amex", pending: false, categoryId: null },
      { id: "t2", occurredOn: "2026-10-07", description: "Old card", amount: "-9.00", plaidAccountId: "p-gone", source: "plaid:chase", pending: false, categoryId: null },
      { id: "t3", occurredOn: "2026-10-06", description: "Mystery", amount: "-1.00", plaidAccountId: null, source: "xlsx", pending: false, categoryId: null },
      // The internal row id is not a transaction's account id: it must not resolve.
      { id: "t4", occurredOn: "2026-10-06", description: "Wrong key", amount: "-2.00", plaidAccountId: "c1", source: "plaid:chase", pending: false, categoryId: null },
    ]);
    wrap(<ActivityPanel />);
    const rows = screen.getAllByTestId("txn-row");
    const titles = rows.map((r) => r.querySelector("[title]")?.getAttribute("title"));
    expect(titles).toEqual(["Amex (imported)", "Chase (no longer linked)", "Unknown account", "Chase (no longer linked)"]);
    for (const r of rows) expect(r.querySelector('[title="Account"]')).toBeNull();
    // An Amex WORKBOOK row is stored charge-positive: it still reads as money out.
    expect(rows[0]!.textContent).toContain("-$18.00");
  });
  it("(WP7) each row opens the ledger that lists it, on its month, per kind; a row no ledger lists says why", () => {
    h.Q.items = ok([
      item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "4821" })]),
      item("b", "American Express", "amex", [acct("x1", { name: "Blue Cash", mask: "1001", type: "credit", subtype: "credit card" })]),
      item("c", "Capital One", "capone", [acct("k1", { name: "Quicksilver", mask: "7788", type: "credit", subtype: "credit card" })]),
    ]);
    h.Q.cats = ok([]);
    const t = (id: string, o: Record<string, unknown>) => ({ id, occurredOn: "2026-10-07", description: id, amount: "-1.00", pending: false, categoryId: null, ...o });
    h.Q.txns = ok([
      t("CHECKING", { plaidAccountId: "p-c1", source: "plaid:chase" }),
      t("AMEX", { plaidAccountId: "p-x1", source: "plaid:amex", occurredOn: "2026-09-30" }),
      t("CAPONE", { plaidAccountId: "p-k1", source: "plaid:capone" }),
      t("WORKBOOK", { plaidAccountId: null, source: "amex" }),
      t("MANUAL", { plaidAccountId: null, source: "manual" }),
      t("GONE", { plaidAccountId: "p-gone", source: "plaid:chase" }),
    ]);
    wrap(<ActivityPanel />);
    const hrefOf = (name: string) => screen.queryByRole("link", { name })?.getAttribute("href") ?? null;
    expect(hrefOf("CHECKING")).toBe("/next/accounts/p-c1?tx=CHECKING&month=2026-10-01");
    expect(hrefOf("AMEX")).toBe("/next/accounts/p-x1?tx=AMEX&month=2026-09-01");
    expect(hrefOf("CAPONE")).toBe("/next/accounts/p-k1?tx=CAPONE&month=2026-10-01");
    expect(hrefOf("WORKBOOK")).toBe("/amex?tx=WORKBOOK&month=2026-10-01");
    expect(hrefOf("MANUAL")).toBe("/transactions?tx=MANUAL&month=2026-10-01");
    // Never a dead end at /transactions for a row that ledger does not list.
    expect(hrefOf("GONE")).toBeNull();
    const rows = screen.getAllByTestId("txn-row");
    const gone = rows.find((r) => r.textContent!.includes("GONE"))!;
    expect(within(gone).getByTestId("txn-note").textContent).toBe("No ledger: Chase (no longer linked)");
    expect(screen.getAllByTestId("txn-note")).toHaveLength(1);
  });
  it("(WP7 review) while the linked accounts load, no row reads 'no longer linked': Plaid rows wait unlinked, others still open", () => {
    h.Q.items = loading;
    h.Q.cats = ok([]);
    const t = (id: string, o: Record<string, unknown>) => ({ id, occurredOn: "2026-10-07", description: id, amount: "-1.00", pending: false, categoryId: null, ...o });
    h.Q.txns = ok([
      t("CHECKING", { plaidAccountId: "p-c1", source: "plaid:chase" }),
      t("WORKBOOK", { plaidAccountId: null, source: "amex" }),
      t("MANUAL", { plaidAccountId: null, source: "manual" }),
    ]);
    wrap(<ActivityPanel />);
    expect(screen.getByTestId("dash-activity").textContent).not.toContain("no longer linked");
    expect(screen.queryAllByTestId("txn-note")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "CHECKING" })).toBeNull();
    expect(screen.getByRole("link", { name: "WORKBOOK" }).getAttribute("href")).toBe("/amex?tx=WORKBOOK&month=2026-10-01");
    expect(screen.getByRole("link", { name: "MANUAL" }).getAttribute("href")).toBe("/transactions?tx=MANUAL&month=2026-10-01");
    expect(screen.queryByTestId("dash-activity-accounts-failed")).toBeNull();
  });
  it("(WP7 review) when the linked accounts fail, it says so with Try again, and still never 'no longer linked'", () => {
    const refetch = vi.fn();
    h.Q.items = { ...failed, refetch };
    h.Q.cats = ok([]);
    h.Q.txns = ok([
      { id: "t1", occurredOn: "2026-10-07", description: "Aldi", amount: "-32.10", plaidAccountId: "p-c1", source: "plaid:chase", pending: false, categoryId: null },
    ]);
    wrap(<ActivityPanel />);
    const alert = screen.getByTestId("dash-activity-accounts-failed");
    expect(alert.textContent).toContain("did not load");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.getByTestId("dash-activity").textContent).not.toContain("no longer linked");
    expect(screen.queryAllByTestId("txn-note")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Aldi" })).toBeNull();
  });
  it("chips a recent credit filed under an expense category", () => {
    h.Q.items = ok([item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "4821" })])]);
    h.Q.cats = ok([{ id: "dining", name: "Dining & Coffee", kind: "expense" }]);
    h.Q.txns = ok([
      { id: "t1", occurredOn: "2026-10-08", description: "ACME PAYROLL DIRECT DEP", amount: "2100.00", plaidAccountId: "p-c1", source: "plaid:chase", categoryId: "dining",
        isTransfer: false, debtId: null, isExternalCardPayment: false, reimbursable: false, pfcDetailed: "INCOME_WAGES", pending: false },
    ]);
    wrap(<ActivityPanel />);
    expect(screen.getByTestId("txn-flag").textContent).toBe("Income in an expense category");
  });
});

// ── Sizes: the real panels carry the skeletons' minimum heights ───────────
describe("lazy panels match their skeletons", () => {
  it("each lazy panel wears its BELOW_FOLD span and minimum height", () => {
    h.Q.cash = ok({ status: "no_data", events: [], daily: [], account: cashAcct });
    h.Q.pos = ok({ spentWeekDiscretionary: "0", weekCap: null, remainingWeek: null, paceAllowedToday: null, weekStart: "2026-10-04", weekEnd: "2026-10-10" });
    h.Q.budget = ok({ summary: { expenses: { budget: "0", actual: "0" } } });
    h.Q.cash = h.Q.cash ?? ok({ account: cashAcct, events: [] });
    h.Q.findings = ok({ findings: [] });
    h.Q.queue = ok({ total: 0 }); h.Q.dups = ok({ duplicateCount: 0 });
    h.Q.txns = ok([]); h.Q.items = ok([]); h.Q.cats = ok([]); h.Q.recurring = ok([]); h.Q.debts = ok([]);
    wrap(<><ForecastPanel /><UpcomingPanel /><SpendingPanel /><DebtPanel /><AttentionPanel /><ActivityPanel /></>);
    const ids: Record<string, string> = { forecast: "dash-forecast", upcoming: "dash-upcoming", spending: "dash-spending", debt: "dash-debt", attention: "dash-attention", activity: "dash-activity" };
    for (const [k, v] of Object.entries(BELOW_FOLD)) {
      const el = screen.getByTestId(ids[k]!);
      expect(el.className, k).toContain(`span-${v.span}`);
      expect(el.className, k).toContain(v.minH);
      expect(el.className, k).not.toContain("panel-link");
    }
  });
});
