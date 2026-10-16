import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * S — a failed read of the debts is not "No debts recorded" and not zero tiles.
 * Debts says it could not load them and offers Try again; the title stays.
 */
const refetch = vi.fn();
let state: { data: unknown; isLoading: boolean; isError: boolean } = { data: undefined, isLoading: false, isError: true };

vi.mock("@/components/debt-plaid-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/debt-plaid-link")>()),
  DebtReauthBanner: () => null,
}));
vi.mock("@workspace/api-client-react", () => ({
  useListDebts: () => ({ ...state, refetch }),
  useListPlaidLiabilityAccounts: () => ({ data: undefined, isLoading: false }),
  getListPlaidLiabilityAccountsQueryKey: () => ["liability-accounts"],
  useListDebtBalanceHistory: () => ({ data: [], isLoading: false }),
  useGetAvalancheSettings: () => ({ data: undefined }),
  useGetAvalancheExtra: () => ({ data: undefined }),
}));

import DebtsPage from "./debts";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DebtsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  refetch.mockClear();
});

describe("Debts — a failed read", () => {
  it("names the failure, keeps the title, shows no empty note and no zero tiles, and Try again refetches", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Debts");
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load your debts.");
    expect(screen.queryByTestId("text-debts-empty-state")).toBeNull();
    expect(screen.queryByText("Active")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a real empty answer still says there are no debts", () => {
    state = { data: [], isLoading: false, isError: false };
    renderPage();
    expect(screen.getByTestId("text-debts-empty-state").textContent).toContain("No debts recorded");
    expect(screen.queryByRole("alert")).toBeNull();
    state = { data: undefined, isLoading: false, isError: true };
  });
});
