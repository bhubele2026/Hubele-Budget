import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";

// Radix Slider relies on ResizeObserver, which jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// dueDay === today's date so daysUntilDue() resolves to 0 ⇒ the compact
// "today" pill, deterministically, regardless of when the suite runs.
const TODAY_DAY = new Date().getDate();

// Three debts: two manual + one Plaid-linked, so the per-row source chip
// has both states to assert. APRs are spread so the avalanche sort order
// (highest APR first) is unambiguous: Mattress → Amex → Chase.
const SEEDED_DEBTS: Debt[] = [
  {
    id: "amex",
    name: "Amex Delta",
    apr: "0.2849",
    balance: "1000",
    minPayment: "50",
    payment: "50",
    status: "active",
    sortOrder: 1,
    dueDay: TODAY_DAY,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
  {
    id: "chase",
    name: "Chase Visa",
    apr: "0.18",
    balance: "500",
    minPayment: "30",
    payment: "30",
    status: "active",
    sortOrder: 2,
    plaidAccountId: "plaid-chase-123",
    balanceSource: "plaid",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
  {
    id: "mattress",
    name: "Mattress Firm",
    apr: "0.3499",
    balance: "5000",
    minPayment: "33",
    payment: "33",
    status: "active",
    sortOrder: 3,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
];

vi.mock("wouter", () => ({ useSearch: () => "" }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null,
  DebtPlaidIndicator: () => null,
  DebtLastSynced: () => null,
  DebtPlaidSource: () => null,
  DebtReauthBanner: () => null,
}));
vi.mock("recharts", () => ({
  LineChart: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: () => null,
  Legend: () => null,
}));
vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = { mutate: noop, mutateAsync: asyncNoop, isPending: false };
  return {
    useListDebts: () => ({ data: SEEDED_DEBTS, isLoading: false }),
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
    getListDebtsQueryKey: () => ["debts"],
    getGetAvalancheSettingsQueryKey: () => ["av-settings"],
    getGetAvalancheExtraQueryKey: () => ["av-extra"],
  };
});

import AvalanchePage from "./avalanche";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AvalanchePage />
    </QueryClientProvider>,
  );
}

function getRow(id: string) {
  return screen.getByTestId(`row-debt-${id}`);
}

beforeEach(() => {
  cleanup();
});

describe("Avalanche page — decluttered Debts-tab table layout (#858)", () => {
  it("renders the PLAID/MANUAL source chip exactly once per row, in the Creditor cell — never in APR/Balance/Min", () => {
    renderPage();

    for (const { id, label } of [
      { id: "mattress", label: "Manual" },
      { id: "amex", label: "Manual" },
      { id: "chase", label: "Plaid" },
    ]) {
      const row = getRow(id);
      // Exactly one source chip in the whole row.
      const chips = within(row).getAllByText(/^(Plaid|Manual)$/);
      expect(chips).toHaveLength(1);
      expect(chips[0]!.textContent).toBe(label);

      const cells = row.querySelectorAll(":scope > td");
      // Cell 0 = Creditor (chip lives here); 1 = APR, 2 = Balance, 3 = Min.
      expect(cells[0]!.textContent).toContain(label);
      expect(cells[1]!.textContent).not.toMatch(/Plaid|Manual/);
      expect(cells[2]!.textContent).not.toMatch(/Plaid|Manual/);
      expect(cells[3]!.textContent).not.toMatch(/Plaid|Manual/);
    }
  });

  it("renders the compact Due pill ('today'/'{n}d'/'overdue'), not the old 'Due in …' label", () => {
    renderPage();

    // Amex has dueDay === today ⇒ the compact "today" pill.
    const amexRow = getRow("amex");
    const dueCell = amexRow.querySelectorAll(":scope > td")[4]!;
    expect(dueCell.textContent?.trim()).toBe("today");
    // The compact format must match exactly one of the three shapes and
    // must never be the verbose "Due in N days" copy.
    expect(dueCell.textContent ?? "").toMatch(/^(today|overdue|\d+d)$/);
    expect(screen.queryByText(/Due in/i)).toBeNull();
  });

  it("has no standalone 'Type' column header", () => {
    renderPage();

    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.trim());
    expect(headers).not.toContain("Type");
    // Sanity: the streamlined header set is still present.
    expect(headers).toEqual(
      expect.arrayContaining([
        "Creditor",
        "APR",
        "Balance",
        "Min",
        "Due",
        "Actions",
      ]),
    );
  });

  it("keeps the avalanche sort order (highest APR first) unchanged", () => {
    renderPage();

    const order = screen
      .getAllByTestId(/^row-debt-/)
      .map((r) => r.getAttribute("data-testid"));
    expect(order).toEqual([
      "row-debt-mattress",
      "row-debt-amex",
      "row-debt-chase",
    ]);
  });

  it("keeps per-row APR / Balance / Min values unchanged", () => {
    renderPage();

    const expectations: Record<string, { apr: string; balance: string; min: string }> = {
      mattress: { apr: "34.99%", balance: "$5,000.00", min: "$33.00" },
      amex: { apr: "28.49%", balance: "$1,000.00", min: "$50.00" },
      chase: { apr: "18.00%", balance: "$500.00", min: "$30.00" },
    };
    for (const [id, v] of Object.entries(expectations)) {
      const cells = getRow(id).querySelectorAll(":scope > td");
      expect(cells[1]!.textContent).toContain(v.apr);
      expect(cells[2]!.textContent).toContain(v.balance);
      expect(cells[3]!.textContent).toContain(v.min);
    }
  });

  it("keeps the footer totals unchanged (sum of balances and minimums)", () => {
    renderPage();

    const totalsRow = screen.getByText("Totals").closest("tr")!;
    const text = totalsRow.textContent ?? "";
    // 5000 + 1000 + 500 = 6500; 33 + 50 + 30 = 113.
    expect(text).toContain("$6,500.00");
    expect(text).toContain("$113.00");
  });
});
