import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/** (F11) The weekly-plan panel (Allowances) and the debt-range panel (Avalanche). */

const m = vi.hoisted(() => ({
  plans: undefined as unknown,
  isOwner: true as boolean | undefined,
  members: [] as unknown[],
  update: vi.fn(),
  debtPlan: undefined as unknown,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({ data: m.isOwner === undefined ? undefined : { isOwner: m.isOwner }, isLoading: false }),
  useListMembers: () => ({ data: m.members }),
}));
vi.mock("@workspace/api-client-react/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react/features")>()),
  useListAllowancePlans: () => ({ data: m.plans, isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateAllowancePlan: () => ({ mutate: m.update, isPending: false }),
  useGetDebtPlan: () => ({ data: m.debtPlan, isLoading: false, isError: false, refetch: vi.fn() }),
}));

import { WeekPlanPanel } from "./WeekPlanPanel";
import { DebtRangePanel } from "./DebtRangePanel";

const mount = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const plan = (id: string, memberUserId: string | null, period: string, amount: string, source = "owner") => ({
  id, memberUserId, period, amount, effectiveFrom: "2026-09-27", source, derivation: null, createdAt: "2026-09-27T00:00:00Z",
});
const suggested = (weekly = "350.00") => ({
  weekly,
  derivation: {
    takeHomeMonthly: "6000.00", committedMonthly: "2500.00", debtMinimumsMonthly: "800.00",
    extraMonthly: "300.00", goalsMonthly: "0.00", discretionaryMonthly: "2400.00",
  },
});

beforeEach(() => {
  m.isOwner = true;
  m.members = [{ id: "u1", isOwner: true, displayName: "Alex" }, { id: "u2", isOwner: false, displayName: "Sam" }];
  m.plans = { plans: [plan("p1", null, "weekly", "300.00"), plan("p2", null, "monthly", "1300.00"), plan("p3", "u2", "weekly", "40.00")], suggested: suggested() };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Weekly plan panel", () => {
  it("shows the limit, its source, the monthly figure and the server's ledger", () => {
    mount(<WeekPlanPanel />);
    expect(screen.getByTestId("plan-limit-figure").textContent).toBe("$300.00");
    expect(screen.getByTestId("limit-source-word").textContent).toBe("set by you");
    expect(screen.getByTestId("plan-limit").textContent).toContain("$1,300.00 a month");
    const rows = within(screen.getByTestId("suggestion-ledger")).getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    expect(rows[6].textContent).toContain("$350.00");
  });

  it("'Use the suggestion' PUTs the plan to the suggested amount; hidden once it matches", () => {
    mount(<WeekPlanPanel />);
    fireEvent.click(screen.getByTestId("use-suggestion"));
    expect(m.update.mock.calls[0][0]).toEqual({ id: "p1", data: { amount: "350.00" } });
    cleanup();
    m.plans = { plans: [plan("p1", null, "weekly", "350.00")], suggested: suggested() };
    mount(<WeekPlanPanel />);
    expect(screen.queryByTestId("use-suggestion")).toBeNull();
    expect(screen.getByTestId("matches-suggestion")).toBeTruthy();
  });

  it("set your own: needs dollars above $0, then saves the shared plan", () => {
    mount(<WeekPlanPanel />);
    fireEvent.click(screen.getByTestId("save-own"));
    expect(screen.getByRole("alert").textContent).toContain("above $0");
    expect(m.update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("input-own"), { target: { value: "$425" } });
    fireEvent.click(screen.getByTestId("save-own"));
    expect(m.update.mock.calls[0][0]).toEqual({ id: "p1", data: { amount: "425.00" } });
  });

  it("per-member allowances save by their own plan id", () => {
    mount(<WeekPlanPanel />);
    const row = screen.getByTestId("member-plan");
    expect(row.textContent).toContain("Sam, a week");
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "55" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save Sam's allowance" }));
    expect(m.update.mock.calls[0][0]).toEqual({ id: "p3", data: { amount: "55.00" } });
  });

  it("a member only reads: no inputs, no suggestion button, and who set it", () => {
    m.isOwner = false;
    mount(<WeekPlanPanel />);
    expect(screen.queryByTestId("input-own")).toBeNull();
    expect(screen.queryByTestId("use-suggestion")).toBeNull();
    expect(screen.getByTestId("limit-source-word").textContent).toBe("set by Alex");
    expect(screen.getByTestId("member-plan").querySelector("input")).toBeNull();
  });

  it("a derived plan reads 'suggested'", () => {
    m.plans = { plans: [plan("p1", null, "weekly", "350.00", "derived")], suggested: suggested() };
    mount(<WeekPlanPanel />);
    expect(screen.getByTestId("limit-source-word").textContent).toBe("suggested");
  });
});

const plan60 = (over: Record<string, unknown> = {}) => ({
  asOf: "2026-10-09",
  strategy: "avalanche",
  extraMonthly: 300,
  comparison: {
    avalanche: { monthsToFreedom: 30, debtFreeMonth: "2029-04", totalInterest: 5400, firstKill: { debtId: "d1", month: "2027-01" } },
    snowball: { monthsToFreedom: 31, debtFreeMonth: "2029-05", totalInterest: 5900, firstKill: null },
    delta: {}, killMonths: [], detail: { debts: [{ debtId: "d1", name: "Visa" }] },
  },
  range: {
    earliestMonth: "2029-02", latestMonth: "2029-08", interestLow: 5100, interestHigh: 6200, newChargesPerMonth: 0, runs: [],
    assumptions: [{ key: "a", text: "Minimums are paid on time." }],
  },
  milestones: {
    achieved: [{ key: "m1", label: "First debt cleared", debtId: null, achievedOn: "2026-08-10" }],
    next: { key: "m2", label: "Halfway", estimatedMonth: "2027-06" },
    upcoming: [],
  },
  planned60d: [], confirmedMtd: 0, paidDownGenuineMtd: 0, newChargesMtd: 0, assumptions: [],
  ...over,
});

describe("Debt range panel", () => {
  it("says a range, never one date, with the interest range and the assumptions disclosure", () => {
    m.debtPlan = plan60();
    mount(<DebtRangePanel />);
    expect(screen.getByTestId("range-line").textContent).toBe("Debt-free around Feb 2029 to Aug 2029");
    expect(screen.getByTestId("interest-range").textContent).toBe("Projected interest $5,100.00 to $6,200.00");
    const d = screen.getByTestId("assumptions");
    expect(d.textContent).toContain("What this assumes");
    expect(d.textContent).toContain("Minimums are paid on time.");
  });

  it("an open-ended finish reads 'or later'", () => {
    m.debtPlan = plan60({ range: { ...plan60().range, latestMonth: null } });
    mount(<DebtRangePanel />);
    expect(screen.getByTestId("range-line").textContent).toBe("Debt-free around Feb 2029 or later");
  });

  it("compares avalanche and snowball, marking the chosen plan; no balances are shown", () => {
    m.debtPlan = plan60({ strategy: "snowball" });
    mount(<DebtRangePanel />);
    const t = screen.getByTestId("comparison");
    expect(t.textContent).toContain("30");
    expect(t.textContent).toContain("Apr 2029");
    expect(t.textContent).toContain("Visa, Jan 2027");
    expect(t.querySelector('[aria-current="true"]')?.textContent).toContain("Snowball");
    expect(t.textContent).toContain("your plan");
  });

  it("lists achieved and next milestones", () => {
    m.debtPlan = plan60();
    mount(<DebtRangePanel />);
    expect(screen.getByTestId("milestone-achieved").textContent).toContain("First debt cleared");
    expect(screen.getByTestId("milestone-next").textContent).toContain("Halfway");
    expect(screen.getByTestId("milestone-next").textContent).toContain("Jun 2027");
  });

  it("with nothing to project it says so", () => {
    m.debtPlan = plan60({ range: { ...plan60().range, earliestMonth: null, latestMonth: null } });
    mount(<DebtRangePanel />);
    expect(screen.getByText("Not enough on file to project a finish yet.")).toBeTruthy();
  });
});
