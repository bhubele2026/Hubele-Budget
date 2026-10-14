import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * (W5) /spending/week and /spending/month: the plan, what counts toward it, left
 * or over, the categories behind it and the rows behind those. Synthetic fixtures
 * only. Every figure on the page is the server's string.
 */
const h = vi.hoisted(() => ({
  bd: {} as Record<string, unknown>,
  calls: [] as Array<Record<string, unknown>>,
  plans: undefined as unknown,
  items: undefined as unknown,
  me: { isOwner: true } as unknown,
  budget: undefined as unknown,
  create: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react")>()),
  useListPlaidItems: () => ({ data: h.items, isError: false, isLoading: false }),
  useGetMe: () => ({ data: h.me, isLoading: false }),
  useGetBudgetMonth: () => ({ data: h.budget, isError: false }),
}));
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react/features")>()),
  useListAllowancePlans: () => ({ data: h.plans, isLoading: false }),
  useCreateAllowancePlan: () => ({ mutate: h.create, isPending: false }),
  useGetPeriodBreakdown: (params: Record<string, unknown>) => {
    h.calls.push(params);
    const key = `${params.period}:${params.start}`;
    const base = (h.bd[key] ?? h.bd[String(params.period)]) as Record<string, unknown> | undefined;
    // The server marks the period it was asked for; the fixture follows the request.
    const data = base && { ...base, start: params.start, isCurrent: params.start === "2026-10-11" || params.start === "2026-10-01" };
    return { data, isError: false, isLoading: false, refetch: vi.fn() };
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import SpendingPeriodPage from "./spending-period";

const TODAY = new Date("2026-10-14T17:00:00Z"); // Wed 12:00 Central; this week starts Sun 2026-10-11

const acct = { id: "r-1", institution: "American Express", name: "Platinum", mask: "1001" };
const row = (id: string, amount: string, o: Record<string, unknown> = {}) => ({
  id, date: "2026-10-12", displayName: `Shop ${id}`, amount, account: acct, pending: false,
  category: null, reason: { coverage: "allowance_weekly", nets: null, rule: "weekly_flag" }, splitPart: null, ...o,
});
const cat = (id: string, name: string, amount: string, o: Record<string, unknown> = {}) => ({
  categoryId: id, name, amount, shareBp: 1000, count: 1, usual: "40.00", aboveUsual: "0.00",
  rows: [row(`${id}-1`, amount)], truncated: false, ...o,
});
const group = (amount: string, count: number, rows: unknown[] = []) => ({ amount, count, rows, truncated: false, countsAgainstPlan: true });
const bd = (o: Record<string, unknown> = {}) => ({
  period: "week", basis: "weekly_allowance", start: "2026-10-11", end: "2026-10-17", isCurrent: true, timezone: "America/Chicago",
  scope: { kind: "household", id: null, institution: null, name: null, mask: null }, planScope: "household",
  plan: { status: "set", amount: "300.00", source: "plan", planId: "p1", effectiveFrom: "2026-05-03" },
  carryOver: null, actual: "324.50", remaining: "-24.50", over: "24.50", withinPlan: false,
  categories: [cat("c-gro", "Groceries", "156.60", { usual: "45.00", aboveUsual: "111.60" }), cat("c-gas", "Gas", "92.40"), cat("c-home", "Home", "50.00")],
  needsClassification: group("25.50", 1, [row("u1", "25.50", { reason: { coverage: "needs_classification", nets: null, rule: "unfiled" } })]),
  refundFloorAdjustment: "0.00",
  beside: { unplanned: "85.00", weekly: null, monthly: "30.00", billMatched: "0.00", reimbursable: "0.00", householdSpend: "439.50" },
  limitations: [], ...o,
});
const notSet = () =>
  bd({ plan: { status: "not_set", amount: null, source: "plan", planId: null, effectiveFrom: null }, remaining: null, over: null, withinPlan: null, actual: "125.50",
    categories: [cat("c-gro", "Groceries", "100.00")], needsClassification: group("25.50", 1, []) });

const prefills = [
  { period: "weekly", amount: "380.00", source: "hook_stored", label: "Weekly Spend reserve" },
  { period: "weekly", amount: "350.00", source: "suggested", label: "Suggested" },
  { period: "monthly", amount: "600.00", source: "settings", label: "Saved allowance" },
];

function mount(path: string, view: "week" | "month" = "week") {
  window.history.replaceState(null, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={qc}>
      <SpendingPeriodPage view={view} />
    </QueryClientProvider>
  );
  return { ...render(ui), ui };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  h.bd = { week: bd(), month: bd({ period: "month", basis: "monthly_allowance", start: "2026-10-01", end: "2026-10-31" }) };
  h.calls = [];
  h.plans = { plans: [], prefills };
  h.items = [
    {
      id: "i1", itemId: "pi-1", institutionName: "American Express", institutionSlug: "amex", lastSyncedAt: "2026-10-14T12:00:00Z",
      lastSyncError: null, lastSyncErrorCode: null,
      accounts: [{ id: "r-1", accountId: "p-r-1", name: "Platinum", mask: "1001", type: "credit", subtype: "credit card" }],
    },
  ];
  h.me = { isOwner: true };
  h.budget = undefined;
  h.create.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const cents = (s: string) => Math.round(Number(s.replace(/[^0-9.-]/g, "")) * 100);

describe("This week", () => {
  it("names the period and the scope", () => {
    mount("/spending/week");
    expect(screen.getByTestId("sp-title").textContent).toBe("This week · Sun Oct 11 – Sat Oct 17");
    expect(screen.getByTestId("sp-scope").textContent).toBe("Household · weekly plan");
  });

  it("plan not set: says so, never $0 or Over, and offers the stored amount", () => {
    h.bd.week = notSet();
    mount("/spending/week");
    expect(screen.getByTestId("sp-plan").textContent).toBe("Plan not set");
    expect(screen.getByTestId("sp-left").textContent).toBe("—");
    const summary = screen.getByTestId("sp-summary").textContent ?? "";
    expect(summary).not.toMatch(/Over/);
    expect(summary).not.toMatch(/\$0\.00/);
    expect(screen.getByTestId("plan-use-primary").textContent).toBe("Use $380.00 as the weekly plan from this week");
    expect(screen.queryByText("Why over?")).toBeNull();
    expect(screen.getByText("Where it went")).toBeTruthy();
  });

  it("one tap, then confirm: POST is sent only after Confirm, from this Sunday", () => {
    h.bd.week = notSet();
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-use-primary"));
    expect(h.create).not.toHaveBeenCalled();
    const dlg = screen.getByTestId("plan-confirm");
    expect(within(dlg).getByTestId("plan-confirm-amount").textContent).toBe("$380.00");
    expect(within(dlg).getByTestId("plan-confirm-start").textContent).toBe("Sun Oct 11");
    expect(dlg.textContent).toMatch(/Past weeks keep their plan/);
    fireEvent.click(within(dlg).getByTestId("plan-confirm-go"));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]![0]).toEqual({ data: { period: "weekly", amount: "380.00", effectiveFrom: "2026-10-11" } });
  });

  it("cancel sends nothing", () => {
    h.bd.week = notSet();
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-use-primary"));
    fireEvent.click(screen.getByTestId("plan-cancel"));
    expect(h.create).not.toHaveBeenCalled();
    expect(screen.queryByTestId("plan-confirm")).toBeNull();
  });

  it("a different amount is typed and sent the same way", () => {
    h.bd.week = notSet();
    mount("/spending/week");
    fireEvent.click(screen.getByTestId("plan-different"));
    fireEvent.change(screen.getByTestId("plan-input"), { target: { value: "275.5" } });
    fireEvent.click(screen.getByTestId("plan-confirm-go"));
    expect(h.create.mock.calls[0]![0]).toEqual({ data: { period: "weekly", amount: "275.50", effectiveFrom: "2026-10-11" } });
  });

  it("over: says Over $X, sorts categories by amount, chips what is above usual", () => {
    h.bd.week = bd({ categories: [cat("c-home", "Home", "50.00"), cat("c-gro", "Groceries", "156.60", { usual: "45.00", aboveUsual: "111.60" }), cat("c-gas", "Gas", "92.40")] });
    mount("/spending/week");
    expect(screen.getByTestId("sp-left").textContent).toBe("$24.50");
    expect(screen.getByTestId("sp-summary").textContent).toMatch(/Over/);
    expect(screen.getByText("Why over?")).toBeTruthy();
    const order = screen.getAllByTestId(/^sp-group-amount-c-/).map((n) => n.textContent);
    expect(order).toEqual(["$156.60", "$92.40", "$50.00"]);
    expect(screen.getByTestId("sp-usual-c-gro").textContent).toBe("usual $45.00");
    expect(screen.getByTestId("sp-above-c-gro").textContent).toBe("above usual $111.60");
    expect(screen.queryByTestId("sp-above-c-gas")).toBeNull();
  });

  it("the visible groups plus the refund adjustment add up to the visible Counts toward plan, to the cent", () => {
    h.bd.week = bd({
      actual: "175.00", remaining: "125.00", over: "0.00", withinPlan: true,
      categories: [cat("c-a", "A", "100.10"), cat("c-b", "B", "49.90")],
      needsClassification: group("20.00", 1, []),
      refundFloorAdjustment: "5.00",
    });
    mount("/spending/week");
    const groups = screen.getAllByTestId(/^sp-group-amount-/).map((n) => cents(n.textContent!));
    expect(groups).toHaveLength(3);
    fireEvent.click(screen.getByText("Details"));
    const floor = cents(screen.getByTestId("sp-d-floor").textContent!);
    expect(groups.reduce((a, b) => a + b, 0) + floor).toBe(cents(screen.getByTestId("sp-actual").textContent!));
    expect(screen.getByTestId("sp-left").textContent).toBe("$125.00");
  });

  it("expanded group and period live in the URL and survive a remount", () => {
    const { unmount, ui } = mount("/spending/week?start=2026-10-04");
    expect(h.calls.at(-1)).toMatchObject({ period: "week", start: "2026-10-04" });
    fireEvent.click(screen.getByTestId("sp-group-c-gro"));
    expect(window.location.search).toContain("open=c-gro");
    expect(window.location.search).toContain("start=2026-10-04");
    expect(screen.getAllByTestId("sp-row")).toHaveLength(1);
    unmount();
    render(ui);
    expect(screen.getByTestId("sp-title").textContent).toBe("Week · Sun Oct 4 – Sat Oct 10");
    expect(screen.getAllByTestId("sp-row")).toHaveLength(1);
  });

  it("arrows move one week; next stops at this week", () => {
    mount("/spending/week");
    expect((screen.getByTestId("sp-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("sp-prev"));
    expect(window.location.search).toContain("start=2026-10-04");
    expect(h.calls.at(-1)).toMatchObject({ start: "2026-10-04" });
    fireEvent.click(screen.getByTestId("sp-next"));
    expect(window.location.search).not.toContain("start=");
  });

  it("a row shows its account chip and opens its register", () => {
    mount("/spending/week?open=c-gro");
    expect(screen.getByTestId("sp-row-account").textContent).toBe("Platinum ••1001");
    expect(screen.getByTestId("sp-row-link").getAttribute("href")).toMatch(/^\/amex\?card=p-r-1&month=2026-10-01&tx=c-gro-1/);
  });

  it("Not filed yet is its own group, with its words and a link to Categories", () => {
    mount("/spending/week");
    const u = screen.getByTestId("sp-unfiled");
    expect(u.textContent).toMatch(/Counts toward the weekly plan until filed/);
    expect(within(u).getByTestId("sp-file-link").getAttribute("href")).toBe("/review/categories");
  });

  it("Details names the other figures and the one-sentence rule", () => {
    mount("/spending/week");
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByTestId("sp-d-household").textContent).toBe("$439.50");
    expect(screen.getByTestId("sp-d-unplanned").textContent).toBe("$85.00");
    expect(screen.getByTestId("sp-d-other").textContent).toBe("$30.00");
    expect(screen.getByTestId("sp-d-why").textContent).toMatch(/weekly purchases and ones not filed yet/);
  });
});

describe("This month", () => {
  const month = () => bd({
    period: "month", basis: "monthly_allowance", start: "2026-10-01", end: "2026-10-31",
    plan: { status: "set", amount: "400.00", source: "plan", planId: "p2", effectiveFrom: "2026-05-01" },
    actual: "440.00", remaining: "-40.00", over: "40.00", categories: [cat("c-home", "Home", "380.00"), cat("c-health", "Health", "60.00")],
    needsClassification: { amount: "0.00", count: 0, rows: [], truncated: false, countsAgainstPlan: false },
    beside: { unplanned: "85.00", weekly: "324.50", monthly: null, billMatched: "0.00", reimbursable: "0.00", householdSpend: "849.50" },
  });

  it("keeps the monthly allowance and the household budget apart, both labelled", () => {
    h.bd.month = month();
    h.budget = { summary: { expenses: { budget: "5200.00", actual: "4100.00" } }, spendingReconciliation: null };
    mount("/spending/month", "month");
    expect(screen.getByTestId("sp-title").textContent).toBe("This month · October 2026");
    expect(screen.getByTestId("sp-scope").textContent).toBe("Household · monthly plan");
    expect(screen.getByTestId("sp-plan").textContent).toBe("$400.00");
    expect(screen.getByTestId("sp-left").textContent).toBe("$40.00");
    const hb = screen.getByTestId("sp-household-budget");
    expect(hb.textContent).toMatch(/Household budget/);
    expect(hb.textContent).toMatch(/includes debt payments/);
    expect(within(hb).getByTestId("sp-hb-planned").textContent).toBe("$5,200.00");
    expect(within(hb).getByTestId("sp-hb-actual").textContent).toBe("$4,100.00");
    expect(within(hb).getByTestId("sp-hb-link").getAttribute("href")).toBe("/budget?month=2026-10-01");
    // the allowance summary does not carry the budget's figures
    expect(screen.getByTestId("sp-summary").textContent).not.toMatch(/5,200/);
    expect(screen.queryByTestId("sp-unfiled")).toBeNull();
  });

  it("monthly not set: Plan not set, saved allowance offered, no default primary", () => {
    h.bd.month = { ...month(), plan: { status: "not_set", amount: null, source: "plan", planId: null, effectiveFrom: null }, remaining: null, over: null, withinPlan: null };
    mount("/spending/month", "month");
    expect(screen.getByTestId("sp-plan").textContent).toBe("Plan not set");
    expect(screen.queryByTestId("plan-use-primary")).toBeNull();
    fireEvent.click(screen.getByTestId("plan-use-settings"));
    fireEvent.click(screen.getByTestId("plan-confirm-go"));
    expect(h.create.mock.calls[0]![0]).toEqual({ data: { period: "monthly", amount: "600.00", effectiveFrom: "2026-10-01" } });
  });
});
