import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (C6, AV-15) The Amex card config and "Add to Avalanche" had no test that
 * reached them: every avalanche page test stubs the weekly payoff. This one
 * renders them for real over mocked hooks.
 */

const m = vi.hoisted(() => ({
  updateSettings: vi.fn(async (_a: unknown) => ({})),
  bulk: vi.fn(async (_a: unknown) => ({ results: [{ debtId: "d9" }] })),
  updateDebt: vi.fn(async (_a: unknown) => ({})),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetAmexWeeklyPayoff: () => ({
    data: {
      cards: [
        { accountId: "a1", brand: "blue", statementBalance: 800, plaidAccountId: "p1", debtId: null, displayName: "Blue Cash" },
        { accountId: "a2", brand: "silver", statementBalance: 300, plaidAccountId: "p2", debtId: "d2", displayName: "Platinum" },
        { accountId: "a3", brand: "blue", statementBalance: 50, plaidAccountId: null, debtId: null, displayName: "Sky" },
      ],
    },
  }),
  useGetSettings: () => ({ data: { preferences: { amexCardNames: { a1: "Mine" } } } }),
  useUpdateSettings: () => ({ mutateAsync: m.updateSettings }),
  useBulkCreateDebtsFromPlaidAccounts: () => ({ mutateAsync: m.bulk }),
  useUpdateDebt: () => ({ mutateAsync: m.updateDebt }),
}));

import { AvalancheCardConfig } from "./avalanche-card-config";

function mount() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AvalancheCardConfig />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Avalanche card config + Add to Avalanche (AV-15)", () => {
  it("lists every card with its state: In avalanche, Not linked, or the add button", () => {
    mount();
    expect(screen.getByText("In avalanche")).toBeTruthy();
    expect(screen.getByText("Not linked")).toBeTruthy();
    expect(screen.getAllByTestId("amex-add-to-avalanche").length).toBe(1);
    expect(screen.getAllByText("Monthly").length).toBe(2);
    expect(screen.getAllByText("Weekly").length).toBe(1);
  });

  it("setting a tier writes the tier and its cadence into preferences", async () => {
    mount();
    fireEvent.click(screen.getAllByTestId("amex-tier-set-silver")[0]);
    await waitFor(() => expect(m.updateSettings).toHaveBeenCalled());
    const prefs = (m.updateSettings.mock.calls[0][0] as { data: { preferences: Record<string, Record<string, string>> } }).data.preferences;
    expect(prefs.amexCardBrands.a1).toBe("silver");
    expect(prefs.amexCardCadence.a1).toBe("weekly");
    expect(prefs.amexCardNames.a1).toBe("Mine"); // existing preferences are kept
  });

  it("adds a card: creates the debt from the Plaid account, then sets APR percent→decimal and the minimum", async () => {
    mount();
    fireEvent.click(screen.getByTestId("amex-add-to-avalanche"));
    fireEvent.change(screen.getByLabelText("APR percent"), { target: { value: "24.99" } });
    fireEvent.change(screen.getByLabelText("Minimum payment"), { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("amex-add-to-avalanche-confirm"));
    await waitFor(() => expect(m.updateDebt).toHaveBeenCalled());
    expect(m.bulk).toHaveBeenCalledWith({
      data: { accounts: [{ plaidAccountId: "p1", name: "Blue Cash" }] },
    });
    expect(m.updateDebt).toHaveBeenCalledWith({ id: "d9", data: { apr: "0.2499", minPayment: "40.00" } });
  });

  it("shows the server's reason when the card could not be added", async () => {
    m.bulk.mockResolvedValueOnce({ results: [{ debtId: null, error: "Already linked" } as never] } as never);
    mount();
    fireEvent.click(screen.getByTestId("amex-add-to-avalanche"));
    fireEvent.click(screen.getByTestId("amex-add-to-avalanche-confirm"));
    await waitFor(() => expect(screen.getByText("Already linked")).toBeTruthy());
    expect(m.updateDebt).not.toHaveBeenCalled();
  });
});
