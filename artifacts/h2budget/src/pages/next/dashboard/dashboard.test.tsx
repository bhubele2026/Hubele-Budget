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
  useSettingsQ: () => get("settings"),
  useBudgetMonthQ: () => get("budget"),
  useBillsSummaryQ: () => get("bills"),
  useRecurringQ: () => get("recurring"),
  useTxnsQ: () => get("txns"),
  useCategoriesQ: () => get("cats"),
  useReviewQueueQ: () => get("queue"),
  useDuplicateCountQ: () => get("dups"),
  useRecapPreviewQ: () => get("recap"),
}));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => h.spine }));
vi.mock("@/hooks/use-plaid-sync", () => ({ usePlaidSync: () => ({ runSync: vi.fn(), isPending: false }) }));
vi.mock("@/components/bank-balance-why", () => ({ BankBalanceWhy: () => <span>why</span> }));
vi.mock("@/components/data-state", () => ({ FreshnessLine: () => <span>fresh</span> }));
vi.mock("@/pages/forecast/ProjectedBalanceChart", () => ({
  ProjectedBalanceChart: (p: { data: unknown[]; cashBuffer: number }) => (
    <div data-testid="chart-stub">{p.data.length} points, buffer {p.cashBuffer}</div>
  ),
}));

import AccountsRow from "./AccountsRow";
import CashPanel from "./CashPanel";
import SpendingPanel from "./SpendingPanel";
import UpcomingPanel from "./UpcomingPanel";
import ForecastPanel from "./ForecastPanel";
import DebtPanel from "./DebtPanel";
import ActivityPanel from "./ActivityPanel";
import ReviewPanel from "./ReviewPanel";
import BriefingPanel, { cleanRecap } from "./BriefingPanel";

const spine = (o: Record<string, unknown> = {}) => ({
  asOf: "2026-10-08T15:00:00Z",
  bank: { balance: "4200.50", asOfDate: "2026-10-07T20:00:00Z", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null },
  spentMonth: 900, spentWeek: 120,
  nextBill: { name: "Rent", amount: "1200.00", dueDate: "2026-10-10" },
  billsDueCount: 2,
  forecast: { lowPoint: "350.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "tight" },
  debt: { payoffPct: 41.6, nextMilestone: { label: "Visa paid off", estimatedMonth: "2027-03" }, paidDownMtd: 300, confirmedPaymentsMtd: 320, newChargesMtd: 80 },
  reviewCount: 3,
  position: { safeToSpendNow: "210.00", remainingWeek: "210.00", availableUntilPayday: "400.00", paydayDate: "2026-10-15", horizonKind: "payday", withinPlan: "yes", confidence: "firm", degraded: false, weekAdjustment: null },
  ...o,
});
const acct = (id: string, o: Record<string, unknown>) => ({ id, accountId: `p-${id}`, name: null, mask: null, type: "depository", subtype: "checking", ...o });
const item = (id: string, institutionName: string, slug: string, accounts: unknown[], o: Record<string, unknown> = {}) => ({
  id, itemId: `i-${id}`, institutionName, institutionSlug: slug, lastSyncedAt: "2026-10-08T12:00:00Z", lastSyncError: null, lastSyncErrorCode: null, accounts, ...o,
});
const wrap = (n: ReactNode) => render(<div>{n}</div>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T17:00:00Z"));
  h.Q = {}; h.horizons = []; h.spine = { data: spine(), state: "loaded", refetch: () => {} };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("accounts row", () => {
  beforeEach(() => {
    h.Q.items = ok([
      item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "4821" })]),
      item("b", "American Express", "amex", [acct("x1", { name: "Platinum", mask: "1005", type: "credit", subtype: "credit card" })]),
      item("c", "Capital One", "capone", [acct("k1", { name: "Quicksilver", mask: "7788", type: "credit", subtype: "credit card" })],
        { lastSyncedAt: "2026-10-01T12:00:00Z" }),
      item("d", "Wells Fargo", "wells", [acct("w1", { name: "Everyday", mask: "9911" })],
        { lastSyncErrorCode: "ITEM_LOGIN_REQUIRED", lastSyncError: "login" }),
    ]);
    h.Q.cash = ok({ account: { name: "Total Checking", mask: "4821", subtype: "checking", via: "sole" } });
    h.Q.debts = ok([{ id: "d1", status: "active", plaidAccountId: "x1", balance: "1500.00", minPayment: "35.00", dueDay: 22 }]);
    h.Q.amex = ok({ cards: [{ plaidAccountId: "x1", statementBalance: 1200 }] });
  });
  it("shows balances, liability facts, and blanks where the data is missing", () => {
    wrap(<AccountsRow />);
    const cards = screen.getAllByTestId("dash-account");
    expect(cards).toHaveLength(4);
    expect(within(cards[0]!).getByTestId("dash-account-balance").textContent).toBe("$4,200.50");
    expect(within(cards[1]!).getByTestId("dash-account-balance").textContent).toBe("$1,500.00");
    expect(within(cards[1]!).getByText("$1,200.00")).toBeTruthy();
    expect(within(cards[1]!).getByText("$35.00")).toBeTruthy();
    expect(within(cards[1]!).getByText("The 22nd")).toBeTruthy();
    // No debt row for the second card: balance, minimum and due are dashes, never $0.
    expect(within(cards[2]!).getByTestId("dash-account-balance").textContent).toBe("—");
    expect(within(cards[2]!).getAllByText("—").length).toBeGreaterThanOrEqual(4);
    expect(cards[2]!.textContent).not.toContain("$0");
  });
  it("names stale and reconnect states with the app's own reason", () => {
    wrap(<AccountsRow />);
    const cards = screen.getAllByTestId("dash-account");
    expect(cards[0]!.getAttribute("data-state")).toBe("ok");
    expect(cards[2]!.getAttribute("data-state")).toBe("stale");
    expect(within(cards[2]!).getByTestId("dash-account-state").textContent).toBe("Out of date");
    expect(cards[3]!.getAttribute("data-state")).toBe("reauth");
    expect(within(cards[3]!).getAllByText(/Needs reconnecting/)).toHaveLength(1);
    expect(within(cards[3]!).getByTestId("dash-account-reason").textContent!.length).toBeGreaterThan(10);
  });
  it("checking uses the bank freshness words even when the item has never synced", () => {
    h.Q.items = ok([item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "4821" })], { lastSyncedAt: null })]);
    wrap(<AccountsRow />);
    const card = screen.getByTestId("dash-account");
    expect(card.textContent).not.toContain("Not synced yet");
    expect(within(card).getByTestId("dash-account-state").textContent).toBe("fresh");
  });
  it("links each account to its page and has a Sync button per bank", () => {
    wrap(<AccountsRow />);
    const links = screen.getAllByTestId("dash-account-link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/next/accounts/c1", "/next/accounts/x1", "/next/accounts/k1", "/next/accounts/w1"]);
    expect(screen.getByTestId("dash-sync-a")).toBeTruthy();
    expect(screen.getByTestId("dash-sync-d")).toBeTruthy();
  });
  it("shows a skeleton while loading and an error when it failed", () => {
    h.Q.items = loading;
    const { unmount } = wrap(<AccountsRow />);
    expect(screen.getByTestId("panel-skeleton")).toBeTruthy();
    unmount();
    h.Q.items = failed;
    wrap(<AccountsRow />);
    expect(screen.getByTestId("panel-error").textContent).toContain("Accounts did not load");
  });
});

describe("cash position", () => {
  it("renders the spine figures exactly, with the under-buffer gap", () => {
    wrap(<CashPanel />);
    expect(screen.getByTestId("dash-bank").textContent).toContain("$4,200.50");
    expect(screen.getByTestId("dash-room").textContent).toContain("$210.00");
    expect(screen.getByTestId("dash-room").textContent).toContain("Until payday · Oct 15");
    expect(screen.getByTestId("dash-low").textContent).toContain("$350.00");
    expect(screen.getByTestId("dash-low").textContent).toContain("Oct 20");
    expect(screen.getByTestId("dash-under-buffer").textContent).toContain("under the buffer by $150.00");
    expect(screen.getByTestId("dash-buffer").textContent).toContain("$500.00");
    expect(screen.getByText("why")).toBeTruthy();
  });
  it("uses the week's limit caption and blanks the low point without a forecast", () => {
    h.spine.data = spine({
      forecast: { lowPoint: "0.00", lowPointDate: null, runwayDays: null, cashBuffer: "500.00", status: "no_data" },
      position: { ...spine().position, horizonKind: "week_end", safeToSpendNow: null },
    });
    wrap(<CashPanel />);
    expect(screen.getByTestId("dash-room").textContent).toContain("—");
    expect(screen.getByTestId("dash-room").textContent).toContain("This week's limit");
    expect(screen.getByTestId("dash-low").textContent).toContain("—");
    expect(screen.queryByTestId("dash-under-buffer")).toBeNull();
  });
});

describe("spending", () => {
  const txn = (id: string, amount: string, o: Record<string, unknown> = {}) => ({
    id, occurredOn: "2026-10-05", description: `Shop ${id}`, amount, reimbursable: false, isTransfer: false, isExternalCardPayment: false,
    weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false, ...o,
  });
  beforeEach(() => {
    h.Q.pos = ok({ spentWeekDiscretionary: "80.00", weekCap: "200.00" });
    h.Q.budget = ok({ summary: { expenses: { budget: "3000.00", actual: "3200.00" } } });
    h.Q.settings = ok({ weeklyAllowanceAmount: "200", monthlyAllowanceAmount: "300", unplannedAllowanceAmount: "0", preferences: {} });
    h.Q.recurring = ok([]);
    h.Q.txns = ok([txn("t1", "-45.00"), txn("t2", "-120.00")]);
  });
  it("shows the week and month meters with left/over words", () => {
    wrap(<SpendingPanel />);
    expect(screen.getByTestId("dash-week-meter").textContent).toContain("$80.00");
    expect(screen.getByTestId("dash-week-meter-status").textContent).toBe("$120.00 left");
    expect(screen.getByTestId("dash-month-meter-status").textContent).toBe("$200.00 over");
  });
  it("says no limit set instead of inventing one", () => {
    h.Q.pos = ok({ spentWeekDiscretionary: "80.00", weekCap: null });
    wrap(<SpendingPanel />);
    expect(screen.getByTestId("dash-week-meter-status").textContent).toBe("No limit set");
  });
  it("lists allowances and biggest charges, and links to budget and allowances", () => {
    h.Q.txns = ok([txn("t1", "-45.00"), txn("t2", "-120.00"), txn("t3", "-60.00", { weeklyAllowance: true, weeklyBucket: "weekly" })]);
    wrap(<SpendingPanel />);
    expect(screen.getByTestId("dash-allowances")).toBeTruthy();
    expect(screen.getByTestId("dash-biggest").textContent).toContain("$120");
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/budget");
    expect(hrefs).toContain("/allowances");
  });
  it("discloses the cap when the window is full", () => {
    h.Q.txns = ok(Array.from({ length: 100 }, (_, i) => txn(`t${i}`, "-1.00")));
    wrap(<SpendingPanel />);
    expect(screen.getByTestId("dash-spend-cap").textContent).toContain("most recent 100");
  });
});

describe("upcoming 14 days", () => {
  beforeEach(() => {
    h.Q.cash = ok({
      account: { name: "Total Checking", mask: "4821", subtype: "checking", via: "sole" },
      events: [
        { date: "2026-10-09", label: "Paycheck", amount: "2000.00", itemId: "r1" },
        { date: "2026-10-10", label: "Rent", amount: "-1200.00", itemId: "r2" },
        { date: "2026-10-12", label: "Visa payment", amount: "-150.00", itemId: "r3" },
        { date: "2026-10-14", label: "Car loan", amount: "-300.00", itemId: "r4" },
        { date: "2026-10-30", label: "Too far", amount: "-10.00", itemId: "r5" },
      ],
    });
    h.Q.debts = ok([{ id: "d1", type: "credit_card" }, { id: "d2", type: "auto" }]);
    h.Q.recurring = ok([{ id: "r3", debtId: "d1" }, { id: "r4", debtId: "d2" }]);
  });
  it("groups the window by what each line is and leaves out later events", () => {
    wrap(<UpcomingPanel />);
    expect(within(screen.getByTestId("dash-up-income")).getByText("+$2,000.00")).toBeTruthy();
    expect(within(screen.getByTestId("dash-up-bill")).getByText("Rent")).toBeTruthy();
    expect(within(screen.getByTestId("dash-up-card")).getByText("Visa payment")).toBeTruthy();
    expect(within(screen.getByTestId("dash-up-debt")).getByText("Car loan")).toBeTruthy();
    expect(screen.queryByText("Too far")).toBeNull();
    expect(screen.getByTestId("dash-next-bill").textContent).toContain("Rent");
    expect(screen.getByTestId("dash-next-bill").textContent).toContain("$1,200.00");
    expect(screen.getByText(/Total Checking/)).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/bills", "/forecast"]));
  });
  it("says so when nothing is scheduled", () => {
    h.Q.cash = ok({ account: { via: "unresolved" }, events: [] });
    wrap(<UpcomingPanel />);
    expect(screen.getByText(/Nothing scheduled/)).toBeTruthy();
  });
});

describe("cash-flow forecast", () => {
  const signal = (o: Record<string, unknown> = {}) => ({
    status: "ready", cashBuffer: "500.00", lowestProjected: "350.00", lowestDate: "2026-10-20", events: [],
    daily: [{ date: "2026-10-09", balance: "4000.00" }, { date: "2026-10-20", balance: "350.00" }, { date: "2026-10-21", balance: "-20.00" }], ...o,
  });
  it("loads the chart lazily with the 90-day default, legend and low point", async () => {
    h.Q.cash = ok(signal());
    wrap(<ForecastPanel />);
    expect(h.horizons[0]).toBe(90);
    expect(screen.getByTestId("dash-forecast-legend").textContent).toContain("Projected cash (checking)");
    expect(screen.getByTestId("dash-forecast-low").textContent).toContain("$350.00");
    await waitFor(() => expect(screen.getByTestId("chart-stub").textContent).toBe("3 points, buffer 500"));
    expect(screen.getByText("Open the full forecast").getAttribute("href")).toBe("/next/forecast");
  });
  it("switches horizon", () => {
    h.Q.cash = ok(signal());
    wrap(<ForecastPanel />);
    fireEvent.click(screen.getByTestId("dash-horizon-30"));
    expect(h.horizons.at(-1)).toBe(30);
    expect(screen.getByTestId("dash-horizon-30").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("dash-horizon-180"));
    expect(h.horizons.at(-1)).toBe(180);
  });
  it("draws nothing false when there is no bank balance", () => {
    h.Q.cash = ok(signal({ status: "no_data" }));
    wrap(<ForecastPanel />);
    expect(screen.getByTestId("dash-forecast-empty")).toBeTruthy();
    expect(screen.queryByTestId("dash-forecast-chart")).toBeNull();
  });
});

describe("debt", () => {
  it("shows total balance, % paid, paid down, new charges, milestone", () => {
    h.Q.debts = ok([{ status: "active", balance: "1500.25" }, { status: "active", balance: "500.00" }, { status: "archived", balance: "999.00" }]);
    wrap(<DebtPanel />);
    expect(screen.getByTestId("dash-debt-total").textContent).toContain("$2,000.25");
    expect(screen.getByTestId("dash-debt-total").textContent).toContain("2 accounts");
    expect(screen.getByTestId("dash-debt-paid").textContent).toContain("42%");
    expect(screen.getByTestId("dash-debt-month").textContent).toContain("Paid down $300.00 this month, confirmed by the bank.");
    expect(screen.getByTestId("dash-debt-month").textContent).toContain("$80.00");
    expect(screen.getByTestId("dash-debt-milestone").textContent).toContain("Visa paid off · Mar 2027");
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/avalanche", "/reports/debt"]));
  });
  it("blanks % paid and milestone when the spine has none", () => {
    h.Q.debts = ok([]);
    h.spine.data = spine({ debt: { payoffPct: null, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 } });
    wrap(<DebtPanel />);
    expect(screen.getByTestId("dash-debt-total").textContent).toContain("—");
    expect(screen.getByTestId("dash-debt-paid").textContent).toContain("—");
    expect(screen.getByTestId("dash-debt-milestone").textContent).toContain("—");
  });
});

describe("recent activity", () => {
  it("renders rows with identity, status and category, linking to the account page", () => {
    h.Q.items = ok([item("a", "Chase", "chase", [acct("c1", { name: "Total Checking", mask: "4821" })])]);
    h.Q.cats = ok([{ id: "cat1", name: "Groceries" }]);
    h.Q.txns = ok([
      { id: "t1", occurredOn: "2026-10-07", description: "Aldi", amount: "-32.10", plaidAccountId: "c1", pending: false, categoryId: "cat1" },
      { id: "t2", occurredOn: "2026-10-07", description: "Cash deposit", amount: "50.00", plaidAccountId: null, account: "Manual", pending: true, categoryId: null },
    ]);
    wrap(<ActivityPanel />);
    const rows = screen.getAllByTestId("txn-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Aldi");
    expect(rows[0]!.textContent).toContain("Groceries");
    expect(rows[0]!.textContent).toContain("••4821");
    expect(rows[0]!.textContent).toContain("Posted");
    expect(rows[0]!.textContent).toContain("-$32.10");
    expect(rows[1]!.textContent).toContain("Pending");
    expect(rows[1]!.textContent).toContain("Uncategorized");
    expect(screen.getByText("All accounts").getAttribute("href")).toBe("/next/accounts");
  });
});

describe("needs review", () => {
  it("lists only the sources with something waiting, each a link", () => {
    h.Q.queue = ok({ total: 7 });
    h.Q.dups = ok({ duplicateCount: 0 });
    wrap(<ReviewPanel />);
    expect(screen.getByTestId("dash-review-forecast").textContent).toContain("3");
    expect(screen.getByTestId("dash-review-forecast").getAttribute("href")).toBe("/review");
    expect(screen.getByTestId("dash-review-cats").textContent).toContain("7");
    expect(screen.queryByTestId("dash-review-dups")).toBeNull();
  });
  it("shows duplicates when present and an all-clear when nothing waits", () => {
    h.Q.queue = ok({ total: 0 });
    h.Q.dups = ok({ duplicateCount: 2 });
    const { unmount } = wrap(<ReviewPanel />);
    expect(screen.getByTestId("dash-review-dups").textContent).toContain("2");
    unmount();
    h.spine.data = spine({ reviewCount: 0 });
    h.Q.dups = ok({ duplicateCount: 0 });
    wrap(<ReviewPanel />);
    expect(screen.getByText("Nothing is waiting on a decision.")).toBeTruthy();
  });
});

describe("briefing", () => {
  const recap = (model: unknown) => ok({ model, template: { text: "Template summary." }, facts: {} });
  it("shows the template text with a Template badge and the one next action", () => {
    h.Q.recap = recap(null);
    h.Q.bills = ok({ bills: [], debtMins: [], income: [], monthly: {} });
    wrap(<BriefingPanel />);
    expect(screen.getByTestId("dash-recap-text").textContent).toBe("Template summary.");
    expect(screen.getByTestId("dash-recap-badge").textContent).toBe("Template");
    expect(screen.getByTestId("dash-action").getAttribute("data-kind")).toBe("review");
    expect(screen.getByTestId("dash-action-link").getAttribute("href")).toBe("/review");
  });
  it("strips the trailing link and shows the date quietly", () => {
    h.Q.recap = ok({ model: null, template: { text: "You spent $40.\nhttps://h2budget.onrender.com/?d=2026-10-04" }, facts: {} });
    h.Q.bills = ok({ bills: [], debtMins: [], income: [], monthly: {} });
    wrap(<BriefingPanel />);
    expect(screen.getByTestId("dash-recap-text").textContent).toBe("You spent $40.");
    expect(screen.getByTestId("dash-recap-for").textContent).toBe("for Oct 4");
    expect(cleanRecap("No link here.").forDate).toBeNull();
  });
  it("badges a demo model draft and prefers its text", () => {
    h.Q.recap = recap({ text: "Model words.", source: "model", demo: true });
    h.Q.bills = ok({ bills: [], debtMins: [], income: [], monthly: {} });
    wrap(<BriefingPanel />);
    expect(screen.getByTestId("dash-recap-text").textContent).toBe("Model words.");
    expect(screen.getByTestId("dash-recap-badge").textContent).toBe("Demo");
  });
  it("picks reconnect, over, bill due and nothing in order", () => {
    h.Q.recap = recap(null);
    h.Q.bills = ok({ bills: [{ item: { name: "Rent", amount: "1200", active: "true" }, nextOccurrence: "2026-10-09" }], debtMins: [], income: [], monthly: {} });
    h.spine.data = spine({ reviewCount: 0, bank: { ...spine().bank, stale: true, staleReason: "refresh_failed" } });
    const a = wrap(<BriefingPanel />);
    expect(screen.getByTestId("dash-action").getAttribute("data-kind")).toBe("reconnect");
    a.unmount();
    h.spine.data = spine({ reviewCount: 0, position: { ...spine().position, withinPlan: "over", remainingWeek: "-25.00" } });
    const b = wrap(<BriefingPanel />);
    expect(screen.getByTestId("dash-action").textContent).toContain("Over this week's limit by $25.00");
    b.unmount();
    h.spine.data = spine({ reviewCount: 0 });
    const c = wrap(<BriefingPanel />);
    expect(screen.getByTestId("dash-action").getAttribute("data-kind")).toBe("bill");
    c.unmount();
    h.Q.bills = ok({ bills: [], debtMins: [], income: [], monthly: {} });
    wrap(<BriefingPanel />);
    expect(screen.getByTestId("dash-action").textContent).toContain("Nothing needs you today");
  });
});
