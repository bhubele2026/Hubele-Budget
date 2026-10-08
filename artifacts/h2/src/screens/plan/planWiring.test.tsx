import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The four Plan pages, mounted as the app mounts them (their default exports,
 * through `planData.ts`), with only the generated query hooks answered. Holds
 * the wiring: the right hook behind each section, a member never asks for the
 * member list, and the month page asks for the month it shows.
 */
const q = (data: unknown) => ({ data, isFetching: false, isLoadingError: false, isRefetchError: false, isPlaceholderData: false, refetch: vi.fn() });
const hooks = vi.hoisted(() => ({ me: { userId: "u", isOwner: false } as unknown, listMembers: null as unknown as ReturnType<typeof vi.fn>, budgetMonth: null as unknown as ReturnType<typeof vi.fn> }));

vi.mock("@/data/useSpine", () => ({
  useSpine: () => ({
    data: { bank: { asOfDate: null, source: null, stale: false, staleReason: null, balance: null, lastContactAt: null, lastFailureAt: null }, debt: { payoffPct: 12 }, position: { withinPlan: "yes", remainingWeek: "10.00" } },
    isLoading: false, isFetching: false, state: "loaded", error: null, updatedAt: null, refetch: vi.fn(),
  }),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  hooks.listMembers = vi.fn(() => q(undefined));
  hooks.budgetMonth = vi.fn(() => q({ monthStart: "2026-10-01", lines: [], groups: [], summary: { expenses: { budget: "0", actual: "0" } } }));
  const mut = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...actual,
    useListAllowancePlans: () => q({ plans: [{ id: "p1", memberUserId: null, period: "weekly", amount: "300.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null }], suggested: { weekly: "300.00", derivation: { takeHomeMonthly: "1", committedMonthly: "1", debtMinimumsMonthly: "1", extraMonthly: "1", goalsMonthly: "1", discretionaryMonthly: "1" } } }),
    useGetMoneyPosition: () => q({ weekCap: "300.00", spentWeekDiscretionary: "10.00", remainingWeek: "290.00", withinPlan: "yes" }),
    useGetMe: () => q(hooks.me),
    useListMembers: hooks.listMembers,
    useListRecurringItems: () => q([{ id: "i1", name: "Rent", kind: "bill", amount: "1000.00", frequency: "monthly", dayOfMonth: 1, active: "true", amountKind: "fixed" }]),
    useGetBillsSummary: () => q({ income: [], bills: [], debtMins: [], monthly: {} }),
    useListCategories: () => q([]),
    useGetDebtPlan: () => q(undefined),
    useGetAvalancheSettings: () => q({ strategy: "snowball", extraSource: "manual", manualExtra: "0.00", budgetMode: "budgeted" }),
    useGetAvalancheExtra: () => q({ source: "manual", amount: "0.00", monthStart: "2026-10-01" }),
    useListDebts: () => q([]),
    useGetBudgetMonth: hooks.budgetMonth,
    useUpdateAllowancePlan: mut, useCreateRecurringItem: mut, useUpdateRecurringItem: mut, useDeleteRecurringItem: mut,
    useUpdateAvalancheSettings: mut, useCreateDebtPayment: mut, useCreateDebt: mut, useUpdateDebt: mut, useUpsertBudgetLine: mut,
  };
});

import PlanWeek from "./PlanWeek";
import PlanBills from "./PlanBills";
import PlanDebt from "./PlanDebt";
import PlanCategories from "./PlanCategories";

afterEach(cleanup);
const mount = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const NOW = new Date("2026-10-07T15:00:00Z");

describe("Plan pages, mounted through their data hooks", () => {
  it("The week: a member does not ask for the member list, and reads the limit", () => {
    mount(<PlanWeek now={NOW} />);
    expect(screen.getByTestId("figure-hero").textContent).toContain("$300");
    const opts = hooks.listMembers.mock.calls[0]![0] as { query: { enabled: boolean } };
    expect(opts.query.enabled).toBe(false);
  });

  it("Bills: the item list and the summary", () => {
    mount(<PlanBills />);
    expect(screen.getByTestId("group-bills").textContent).toContain("Rent");
  });

  it("Debt: the percent paid from the spine and the strategy from the setting", () => {
    mount(<PlanDebt now={NOW} />);
    expect(screen.getByTestId("debt-hero").textContent).toContain("12%");
    expect(screen.getByRole("radio", { name: "Snowball" }).getAttribute("aria-checked")).toBe("true");
  });

  it("Categories: asks for the month it shows", () => {
    mount(<PlanCategories now={NOW} />);
    expect(hooks.budgetMonth.mock.calls[0]![0]).toBe("2026-10-01");
    expect(screen.getByTestId("month-label").textContent).toBe("October 2026");
  });
});
