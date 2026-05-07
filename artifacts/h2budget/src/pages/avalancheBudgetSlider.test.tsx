import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

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
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
];

const updateSettingsMutate = vi.fn();

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
    useUpdateAvalancheSettings: () => ({
      mutate: updateSettingsMutate,
      mutateAsync: asyncNoop,
      isPending: false,
    }),
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

beforeEach(() => {
  cleanup();
  updateSettingsMutate.mockReset();
});

describe("Avalanche page — Avalanche budget slider commit behavior", () => {
  it("each keyboard step commits the latest value to the server (one commit per tick, with the running value)", () => {
    renderPage();

    const slider = screen.getByRole("slider");
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });

    // Each keyboard tick is its own committed step, so we expect exactly
    // one mutation per arrow press — and the last call carries the
    // user's landing value ($75 = 3 * $25).
    expect(updateSettingsMutate).toHaveBeenCalledTimes(3);
    expect(updateSettingsMutate).toHaveBeenLastCalledWith({
      data: { manualExtra: "75.00" },
    });

    // The live "Room left" text reflects the local draft (3 * $25 = $75
    // taken out of the $1000 available money) immediately, even before
    // the persisted `manualExtra` settings prop refreshes.
    const roomLeft = screen.getByTestId("text-room-left");
    expect(roomLeft.textContent ?? "").toContain("$925.00");
  });

  it("'Reset to $0' still persists immediately", () => {
    renderPage();
    const reset = screen.getByText("Reset to $0");
    fireEvent.click(reset);
    expect(updateSettingsMutate).toHaveBeenCalledWith({
      data: { manualExtra: "0" },
    });
  });
});
