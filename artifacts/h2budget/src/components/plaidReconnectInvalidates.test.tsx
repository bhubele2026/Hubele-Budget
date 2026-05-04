import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Capture the most recent onSuccess handed to usePlaidLink so we can
// invoke it directly (the real Plaid Link iframe never opens in jsdom).
let capturedOnSuccess: (() => Promise<void> | void) | null = null;

vi.mock("react-plaid-link", () => ({
  usePlaidLink: ({ onSuccess }: { onSuccess: () => Promise<void> | void }) => {
    capturedOnSuccess = onSuccess;
    return { open: vi.fn(), ready: false };
  },
}));

const runSyncMock = vi.fn(async () => ({
  added: 0,
  modified: 0,
  removed: 0,
  errors: [] as string[],
}));

vi.mock("@/hooks/use-plaid-sync", () => ({
  usePlaidSync: () => ({ runSync: runSyncMock, isPending: false }),
  formatPlaidErrorForDisplay: (s: string) => s,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@workspace/api-client-react", () => ({
  useCreatePlaidUpdateLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
  getListDebtsQueryKey: () => ["/api/debts"],
  getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
  getGetForecastQueryKey: () => ["/api/forecast"],
  getGetDashboardQueryKey: () => ["/api/dashboard"],
}));

import { PlaidReconnectButton } from "./plaid-reconnect-button";

beforeEach(() => {
  cleanup();
  capturedOnSuccess = null;
  runSyncMock.mockClear();
});

describe("(#211) PlaidReconnectButton invalidates debt-consuming queries on reconnect success", () => {
  it("invalidates /debts (and bills/forecast/dashboard) after sync so the page-top banner clears", async () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(
      <QueryClientProvider client={qc}>
        <PlaidReconnectButton itemId="item-1" institutionName="Chase" />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("button-plaid-reconnect-item-1")).toBeTruthy();
    // The component registered an onSuccess with usePlaidLink — fire it
    // ourselves to simulate the user completing Plaid Link in update mode.
    expect(capturedOnSuccess).not.toBeNull();
    await capturedOnSuccess!();

    // runSync clears the server-side error; we then need to invalidate the
    // queries that drive the banner (it reads off /debts).
    expect(runSyncMock).toHaveBeenCalledWith({ itemId: "item-1", silent: true });

    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown }).queryKey,
    );
    expect(invalidatedKeys).toContainEqual(["/api/plaid/items"]);
    // The critical one for the banner — without it the stale debts cache
    // keeps `plaidLastSyncErrorCode` set and the banner sticks around.
    expect(invalidatedKeys).toContainEqual(["/api/debts"]);
    // Plus the other debt consumers, mirroring the inline refresh path.
    expect(invalidatedKeys).toContainEqual(["/api/bills/summary"]);
    expect(invalidatedKeys).toContainEqual(["/api/forecast"]);
    expect(invalidatedKeys).toContainEqual(["/api/dashboard"]);

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  });
});
