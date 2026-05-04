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
  items: Array<{
    added: number;
    modified: number;
    removed: number;
    error: string | null;
    stillPreparing?: boolean;
  }>;
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

  it("surfaces per-item lastSyncError under the button with a 'Plaid:' prefix", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "the login details of this item have changed",
      },
    ];
    renderButton();
    const chip = screen.getByTestId("text-sync-error");
    expect(chip).toBeTruthy();
    // The chip text should be prefixed with "Plaid: " so the user can tell
    // where the message originated.
    expect(chip.textContent).toMatch(/^Plaid: the login details/);
  });

  it("does not double-prefix a lastSyncError that already starts with 'Plaid:'", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "Plaid: already prefixed",
      },
    ];
    renderButton();
    const chip = screen.getByTestId("text-sync-error");
    expect(chip.textContent).toBe("Plaid: already prefixed");
  });

  it("emits a 'Sync had errors' toast prefixed with 'Plaid:' when an item reports an error", async () => {
    plaidItems = [
      { id: "i-1", institutionName: "Chase", lastSyncedAt: null, lastSyncError: null },
    ];
    syncResponse = {
      items: [
        {
          added: 0,
          modified: 0,
          removed: 0,
          error: "the login details of this item have changed",
        },
      ],
    };
    renderButton();
    fireEvent.click(screen.getByTestId("button-sync-plaid"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Sync had errors",
          description: "Plaid: the login details of this item have changed",
          variant: "destructive",
        }),
      );
    });
  });

  it("shows a neutral 'Still preparing' toast (NOT destructive) when the per-item stillPreparing flag is set", async () => {
    plaidItems = [
      { id: "i-1", institutionName: "Chase", lastSyncedAt: null, lastSyncError: null },
    ];
    syncResponse = {
      items: [
        { added: 0, modified: 0, removed: 0, error: null, stillPreparing: true },
      ],
    };
    renderButton();
    fireEvent.click(screen.getByTestId("button-sync-plaid"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Still preparing",
          description: expect.stringContaining("still preparing the initial batch"),
        }),
      );
    });
    // Critically: the toast for PRODUCT_NOT_READY must NOT be destructive,
    // and we must NOT also fire the "Sync had errors" destructive toast.
    const destructiveCalls = toastFn.mock.calls.filter(
      ([arg]) => (arg as { variant?: string }).variant === "destructive",
    );
    expect(destructiveCalls).toHaveLength(0);
  });
});
