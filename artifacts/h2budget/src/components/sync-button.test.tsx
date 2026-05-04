import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

type Item = {
  id: string;
  institutionName: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
};

let plaidItems: Item[] | undefined = [];
let syncResponse: {
  items: Array<{ added: number; modified: number; removed: number; error: string | null }>;
} = {
  items: [],
};
let syncShouldError = false;
const toastFn = vi.fn();
const mutateMock = vi.fn(
  (
    _vars: { data: { itemId?: string } },
    opts: { onSuccess?: (r: typeof syncResponse) => void; onError?: (e: Error) => void },
  ) => {
    if (syncShouldError) opts.onError?.(new Error("nope"));
    else opts.onSuccess?.(syncResponse);
  },
);

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastFn }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListPlaidItems: () => ({ data: plaidItems }),
  useSyncPlaidTransactions: () => ({ mutate: mutateMock, isPending: false }),
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

import { SyncButton } from "./sync-button";

function renderButton() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <SyncButton />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  toastFn.mockClear();
  mutateMock.mockClear();
  plaidItems = [];
  syncResponse = { items: [] };
  syncShouldError = false;
});

describe("SyncButton", () => {
  it("renders nothing when there are no linked Plaid items", () => {
    plaidItems = [];
    const { container } = renderButton();
    expect(container.firstChild).toBeNull();
  });

  it("renders the Sync button and last-synced label when items exist", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        lastSyncError: null,
      },
    ];
    renderButton();
    expect(screen.getByTestId("button-sync-plaid")).toBeTruthy();
    expect(screen.getByText(/Last synced/i)).toBeTruthy();
  });

  it("shows the empty-state toast when sync returns zero new transactions", async () => {
    plaidItems = [
      { id: "i-1", institutionName: "Chase", lastSyncedAt: null, lastSyncError: null },
    ];
    syncResponse = { items: [{ added: 0, modified: 0, removed: 0, error: null }] };
    renderButton();
    fireEvent.click(screen.getByTestId("button-sync-plaid"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ title: "No new transactions yet" }),
      );
    });
  });

  it("shows the success toast with counts when transactions are imported", async () => {
    plaidItems = [
      { id: "i-1", institutionName: "Chase", lastSyncedAt: null, lastSyncError: null },
    ];
    syncResponse = { items: [{ added: 12, modified: 3, removed: 1, error: null }] };
    renderButton();
    fireEvent.click(screen.getByTestId("button-sync-plaid"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Sync complete",
          description: "Added 12, updated 3, removed 1.",
        }),
      );
    });
  });

  it("surfaces upstream errors in the toast", async () => {
    plaidItems = [
      { id: "i-1", institutionName: "Chase", lastSyncedAt: null, lastSyncError: null },
    ];
    syncShouldError = true;
    renderButton();
    fireEvent.click(screen.getByTestId("button-sync-plaid"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Sync failed", variant: "destructive" }),
      );
    });
  });

  it("treats removed-only responses as 'still preparing' (added+modified===0)", async () => {
    plaidItems = [
      { id: "i-1", institutionName: "Chase", lastSyncedAt: null, lastSyncError: null },
    ];
    syncResponse = { items: [{ added: 0, modified: 0, removed: 4, error: null }] };
    renderButton();
    fireEvent.click(screen.getByTestId("button-sync-plaid"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ title: "No new transactions yet" }),
      );
    });
  });

  it("surfaces per-item lastSyncError under the button", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "ITEM_LOGIN_REQUIRED",
      },
    ];
    renderButton();
    expect(screen.getByTestId("text-sync-error")).toBeTruthy();
    expect(screen.getByText(/ITEM_LOGIN_REQUIRED/i)).toBeTruthy();
  });

  it("emits a 'Sync had errors' toast when an item reports an error", async () => {
    plaidItems = [
      { id: "i-1", institutionName: "Chase", lastSyncedAt: null, lastSyncError: null },
    ];
    syncResponse = {
      items: [{ added: 0, modified: 0, removed: 0, error: "ITEM_LOGIN_REQUIRED" }],
    };
    renderButton();
    fireEvent.click(screen.getByTestId("button-sync-plaid"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Sync had errors",
          description: "ITEM_LOGIN_REQUIRED",
          variant: "destructive",
        }),
      );
    });
  });
});
