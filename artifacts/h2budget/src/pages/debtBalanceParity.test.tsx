import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/components/plan/DebtRangePanel", () => ({ DebtRangePanel: () => null }));
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * ⭐ TILES MUST AGREE — APPLIED TO DEBTS.
 *
 * The Debts page and the Avalanche page read the SAME `GET /api/debts`
 * payload, but until this change only Avalanche netted out tagged-but-
 * unposted payments (`effectiveDebtBalance`). Debts rendered the raw posted
 * number. The same card therefore read $8,420.55 on one screen and $8,120.55
 * on the other, and because the netted balance also feeds the payoff
 * simulation, the two pages projected different payoff months for it.
 *
 * Brad's call (2026-08-23): net the pending payments everywhere. This file is
 * the guard on that decision — it renders BOTH pages from ONE fixture and
 * asserts they derive the same balance and the same payoff month, and that
 * both disclose the netting rather than quietly showing a number the
 * creditor's statement disagrees with.
 *
 * If someone re-points either page at `Number(d.balance)`, this fails.
 */

// The exact figures from the reported defect: reported $8,420.55, one tagged
// payment of $300.00 the creditor hasn't reflected ⇒ effective $8,120.55.
const REPORTED = "8420.55";
const PENDING = "300.00";
const REPORTED_STR = "$8,420.55";
const EFFECTIVE_STR = "$8,120.55";
const PENDING_STR = "$300.00";

const SEEDED_DEBTS: Debt[] = [
  {
    id: "amex",
    name: "Amex Delta",
    apr: "0.2849",
    balance: REPORTED,
    minPayment: "250",
    payment: "250",
    status: "active",
    sortOrder: 1,
    originalBalance: "10000",
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
    pendingPaymentTotal: PENDING,
    pendingPaymentCount: 1,
  } as Debt,
  // A second, pending-free debt proves the netting is per-debt and that a
  // debt with nothing pending still renders its raw balance unchanged.
  {
    id: "chase",
    name: "Chase Visa",
    apr: "0.18",
    balance: "500",
    minPayment: "30",
    payment: "30",
    status: "active",
    sortOrder: 2,
    originalBalance: "1000",
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

vi.mock("wouter", () => ({
  useSearch: () => "",
  Link: () => null,
}));
// The dashboard case below hands the summary row a spine; the pages read none.
const spineHolder = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: spineHolder.data, isLoading: false, state: "loaded", refetch: () => {} }),
}));
vi.mock("@/components/bank-balance-why", () => ({ BankBalanceWhy: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null,
  DebtPlaidIndicator: () => null,
  DebtLastSynced: () => null,
  DebtPlaidSource: () => null,
  DebtReauthBanner: () => null,
}));
vi.mock("recharts", () => import("@/test-recharts-stub"));
vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = { mutate: noop, mutateAsync: asyncNoop, isPending: false };
  const mutation2 = () => mutation;
  return {
    useListDebts: () => ({ data: SEEDED_DEBTS, isLoading: false }),
    useListDebtBalanceHistory: () => ({ data: [], isLoading: false }),
    useCreateDebt: () => mutation,
    useUpdateDebt: () => mutation,
    useDeleteDebt: () => mutation,
    useGetAvalancheSettings: () => ({
      data: {
        strategy: "avalanche",
        manualExtra: "0",
        extraSource: "manual",
        budgetMode: "budgeted",
        extraBudgetCategoryId: null,
      },
    }),
    useUpdateAvalancheSettings: () => mutation,
    useSyncDebtMinimums: () => mutation,
    useGetAvalancheExtra: () => ({
      data: { amount: "0", source: "manual", availableMoney: 1000 },
    }),
    useCreateDebtPayment: () => mutation,
    useListCategories: () => ({ data: [] }),
    useGetSettings: () => ({ data: undefined }),
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    useGetAmexWeeklyPayoff: () => ({ data: undefined, isLoading: false }),
    // (WP4) The debt tile names cards off the plan from the linked accounts (none here).
    useListPlaidItems: () => ({ data: [], isLoading: false }),
    getListPlaidItemsQueryKey: () => ["plaid-items"],
    useListPlaidLiabilityAccounts: () => ({ data: undefined, isLoading: false }),
    getListPlaidLiabilityAccountsQueryKey: () => ["liability-accounts"],
    useUpdateSettings: mutation2,
    useBulkCreateDebtsFromPlaidAccounts: mutation2,
    getGetSettingsQueryKey: () => ["settings"],
    getGetAmexWeeklyPayoffQueryKey: () => ["amex-weekly-payoff"],
    getListDebtsQueryKey: () => ["debts"],
    getGetAvalancheSettingsQueryKey: () => ["av-settings"],
    getGetAvalancheExtraQueryKey: () => ["av-extra"],
    getGetBillsSummaryQueryKey: () => ["bills-summary"],
    getGetForecastQueryKey: () => ["forecast"],
    getGetBudgetMonthQueryKey: () => ["budget-month"],
    // The dashboard summary row's other reads (it shares the debts read above).
    useGetForecastCashSignal: () => ({ data: undefined, isLoading: true }),
    getGetForecastCashSignalQueryKey: () => ["cash-signal"],
    useGetMoneyPosition: () => ({ data: undefined, isLoading: true }),
    getGetMoneyPositionQueryKey: () => ["money-position"],
    useGetForecastBankBalanceExplain: () => ({ data: undefined, isLoading: false }),
    getGetForecastBankBalanceExplainQueryKey: () => ["bank-explain"],
  };
});

import DebtsPage from "./debts";
import AvalanchePage from "./avalanche";
import SummaryRow from "./next/dashboard/SummaryRow";
import { remainingDebtTotal, remainingDebtScope } from "@/lib/debtBalance";
import { totalsForDebts } from "@/lib/reportsAnalytics";

function renderPage(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * Read a cell by the text of its column header rather than by a hard-coded
 * index — the two pages order their columns differently, and a future column
 * insert must not silently make this assertion read the wrong cell.
 */
function cellUnderHeader(row: Element, headerText: string): string {
  const table = row.closest("table")!;
  const headers = Array.from(table.querySelectorAll("thead th"));
  const idx = headers.findIndex(
    (h) => (h.textContent ?? "").trim() === headerText,
  );
  expect(idx, `no "${headerText}" column header found`).toBeGreaterThanOrEqual(0);
  const cells = row.querySelectorAll(":scope > td");
  return (cells[idx]?.textContent ?? "").trim();
}

function debtsPageRowFor(name: string): HTMLElement {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

beforeEach(() => {
  cleanup();
});

describe("Debt balance parity — Debts page vs Avalanche page (owner-authorized, 2026-08-23)", () => {
  it("derives the SAME balance for the same debt on both pages", () => {
    renderPage(<DebtsPage />);
    const debtsBalance = cellUnderHeader(debtsPageRowFor("Amex Delta"), "Balance");
    cleanup();

    renderPage(<AvalanchePage />);
    const avalancheBalance = cellUnderHeader(
      screen.getByTestId("row-debt-amex"),
      "Balance",
    );

    // The assertion that matters: one debt, one number, both screens.
    expect(debtsBalance).toContain(EFFECTIVE_STR);
    expect(avalancheBalance).toContain(EFFECTIVE_STR);
    expect(debtsBalance).toBe(avalancheBalance);
  });

  it("nets the pending payment out of the Debts page balance (was raw before)", () => {
    renderPage(<DebtsPage />);
    const cell = cellUnderHeader(debtsPageRowFor("Amex Delta"), "Balance");
    expect(cell).toContain(EFFECTIVE_STR);
    // The regression this PR fixes: the raw posted figure must not be the
    // number on the face of the row.
    expect(cell.startsWith(REPORTED_STR)).toBe(false);
  });

  it("discloses the netting inline on BOTH pages, with the amount pending", () => {
    renderPage(<DebtsPage />);
    const debtsHint = screen.getByTestId("debt-pending-amex");
    expect(debtsHint.textContent).toContain(PENDING_STR);
    expect(debtsHint.textContent).toContain("pending");
    cleanup();

    renderPage(<AvalanchePage />);
    const avalancheHint = screen.getByTestId("debt-pending-amex");
    expect(avalancheHint.textContent).toContain(PENDING_STR);
    expect(avalancheHint.textContent).toBe(debtsHint.textContent);
  });

  it("leaves a debt with nothing pending exactly as reported, and shows no hint", () => {
    renderPage(<DebtsPage />);
    expect(cellUnderHeader(debtsPageRowFor("Chase Visa"), "Balance")).toContain(
      "$500.00",
    );
    expect(screen.queryByTestId("debt-pending-chase")).toBeNull();
    cleanup();

    renderPage(<AvalanchePage />);
    expect(
      cellUnderHeader(screen.getByTestId("row-debt-chase"), "Balance"),
    ).toContain("$500.00");
    expect(screen.queryByTestId("debt-pending-chase")).toBeNull();
  });

  it("projects the SAME payoff month on both pages (the netted balance feeds both sims)", () => {
    renderPage(<DebtsPage />);
    const debtsPayoff = within(debtsPageRowFor("Amex Delta"))
      .getByTestId("debt-card-payoff-date")
      .textContent?.trim();
    cleanup();

    renderPage(<AvalanchePage />);
    const avalanchePayoff = cellUnderHeader(
      screen.getByTestId("row-debt-amex"),
      "Payoff",
    );

    expect(debtsPayoff).toBeTruthy();
    expect(debtsPayoff).not.toBe("—");
    expect(avalanchePayoff).toBe(debtsPayoff);
  });
});

describe("⭐ The amount left — dashboard debt tile vs Avalanche vs Reports (owner's decision, 2026-10-09)", () => {
  it("the dashboard's \"$X left on your payoff plan (…)\" equals the Avalanche page's Totals row, to the cent", () => {
    renderPage(<AvalanchePage />);
    const totals = screen.getByText("Totals").closest("tr")!;
    const avalancheTotal = (totals.querySelectorAll("td")[1]?.textContent ?? "").trim();
    cleanup();

    spineHolder.data = {
      bank: { balance: "100.00", asOfDate: "2026-10-08T12:00:00Z", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null },
      forecast: { lowPoint: "100.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "not_yet" },
      position: { safeToSpendNow: null, remainingWeek: null, availableUntilPayday: null, paydayDate: null, horizonKind: "week_end", withinPlan: null, confidence: "firm", degraded: false, weekAdjustment: null },
      debt: { payoffPct: 40, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 },
      reviewCount: 0, nextBill: null, spentWeek: 0, spentMonth: 0, billsDueCount: 0, asOf: "2026-10-08T12:00:00Z",
    };
    try {
      renderPage(<SummaryRow />);
      const left = screen.getByTestId("dash-debt-left").textContent ?? "";
      // Netted: $8,120.55 + $500.00, never the raw $8,420.55 the creditor reports.
      expect(avalancheTotal).toBe("$8,620.55");
      expect(left).toContain(`${avalancheTotal} left on your payoff plan (`);
      // …and the scope is named.
      expect(left).toContain("Amex Delta");
      expect(left).toContain("Chase Visa");
    } finally {
      spineHolder.data = undefined;
    }
  });

  it("one helper, three callers: Avalanche, Reports and the dashboard read the same sum", () => {
    const mixed = [
      ...SEEDED_DEBTS,
      { ...SEEDED_DEBTS[1]!, id: "gone", name: "Archived card", status: "archived", balance: "999.00" } as Debt,
      { ...SEEDED_DEBTS[1]!, id: "zero", name: "Cleared card", balance: "0.00" } as Debt,
    ];
    const total = remainingDebtTotal(mixed);
    expect(total).toBeCloseTo(8620.55, 2);
    expect(totalsForDebts(mixed).totalBalance).toBe(total);
    const scope = remainingDebtScope(mixed);
    expect(scope.total).toBe(total);
    // A cleared or archived debt adds nothing, so it is not named in the scope.
    expect(scope.names).toEqual(["Amex Delta", "Chase Visa"]);
  });
});
