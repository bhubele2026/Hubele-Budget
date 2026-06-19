import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

type Item = {
  id: string;
  institutionName: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastSyncErrorCode?: string | null;
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
  // usePlaidSync (real, unmocked here) and PlaidReconnectButton invalidate
  // these query keys after a sync/reconnect, so the mock must expose them.
  getListDebtsQueryKey: () => ["/api/debts"],
  getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
  getGetForecastQueryKey: () => ["/api/forecast"],
  getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
  getGetDashboardQueryKey: () => ["/api/dashboard"],
  // Stub the update-link-token mutation used by PlaidReconnectButton so we
  // don't need to mount real react-plaid-link in these unit tests.
  useCreatePlaidUpdateLinkToken: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  // (#654) The plaid-reconnect-listener wired into the Reconnect popover
  // calls both useCreatePlaidUpdateLinkToken AND useCreatePlaidLinkToken
  // (the latter for the fresh-link fallback when the server returns
  // 409 + action:"relink"). The mock has to expose both or render fails
  // with "No 'useCreatePlaidLinkToken' export is defined".
  useCreatePlaidLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  useExchangePlaidPublicToken: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Stub react-plaid-link so PlaidReconnectButton can render without trying to
// load the real Plaid Link script.
vi.mock("react-plaid-link", () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false }),
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

  it("shows a Reconnect popover trigger when an item has lastSyncErrorCode === 'ITEM_LOGIN_REQUIRED'", async () => {
    plaidItems = [
      {
        id: "i-bad",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "the login details of this item have changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
    ];
    renderButton();
    // The trigger sits alongside the existing Sync button.
    const trigger = screen.getByTestId("button-plaid-reconnect-trigger");
    expect(trigger).toBeTruthy();
    expect(screen.getByTestId("button-sync-plaid")).toBeTruthy();
    expect(screen.getByTestId("text-sync-error")).toBeTruthy();
    // No badge for the single-broken-bank case — trigger looks identical to
    // the old inline button.
    expect(screen.queryByTestId("badge-plaid-reconnect-count")).toBeNull();
    // Opening the popover surfaces the per-item Reconnect button keyed off
    // the item id so multi-bank users get the right link_token.
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByTestId("button-plaid-reconnect-i-bad")).toBeTruthy();
    });
  });

  it("(#654) shows a Reconnect popover trigger for INVALID_ACCESS_TOKEN (env-mismatched Chase token)", async () => {
    // The user's two real Chase rows persist as INVALID_ACCESS_TOKEN
    // because their sandbox-prefixed access_tokens are rejected by
    // Plaid on every sync. The bank-chip Reconnect popover MUST treat
    // that code as a reauth state on first render — without it the
    // user has no way to recover until the next sync re-stamps the row
    // (which itself can't happen because of the same token problem).
    plaidItems = [
      {
        id: "i-envmismatch",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError:
          "This bank was linked from a different Plaid environment. Please reconnect to refresh.",
        lastSyncErrorCode: "INVALID_ACCESS_TOKEN",
      },
    ];
    renderButton();
    fireEvent.click(screen.getByTestId("button-plaid-reconnect-trigger"));
    await waitFor(() => {
      expect(
        screen.getByTestId("button-plaid-reconnect-i-envmismatch"),
      ).toBeTruthy();
    });
  });

  it("shows a Reconnect popover trigger for PENDING_EXPIRATION too (other re-auth code)", async () => {
    plaidItems = [
      {
        id: "i-pending",
        institutionName: "Wells Fargo",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "your bank requires re-auth before access expires",
        lastSyncErrorCode: "PENDING_EXPIRATION",
      },
    ];
    renderButton();
    fireEvent.click(screen.getByTestId("button-plaid-reconnect-trigger"));
    await waitFor(() => {
      expect(
        screen.getByTestId("button-plaid-reconnect-i-pending"),
      ).toBeTruthy();
    });
  });

  it("(#214) lists every broken bank in the popover, not just the first", async () => {
    plaidItems = [
      {
        id: "i-chase",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "the login details of this item have changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
      {
        id: "i-wells",
        institutionName: "Wells Fargo",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "consent expiring soon",
        lastSyncErrorCode: "PENDING_EXPIRATION",
      },
      {
        id: "i-ok",
        institutionName: "Healthy Bank",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null,
        lastSyncErrorCode: null,
      },
    ];
    renderButton();
    const trigger = screen.getByTestId("button-plaid-reconnect-trigger");
    // Multi-broken-bank case shows a count badge so the user knows there's
    // more than one item hiding inside the popover.
    const badge = screen.getByTestId("badge-plaid-reconnect-count");
    expect(badge.textContent).toBe("2");
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByTestId("row-plaid-reconnect-i-chase")).toBeTruthy();
    });
    // Both broken banks must be listed with their own per-item Reconnect
    // button so the user can fix each from one place.
    expect(screen.getByTestId("button-plaid-reconnect-i-chase")).toBeTruthy();
    expect(screen.getByTestId("button-plaid-reconnect-i-wells")).toBeTruthy();
    // The healthy item is not listed.
    expect(screen.queryByTestId("row-plaid-reconnect-i-ok")).toBeNull();
    expect(screen.queryByTestId("button-plaid-reconnect-i-ok")).toBeNull();
  });

  it("(#310) opens the Reconnect popover on hover on hover-capable devices", async () => {
    // Force the hover-capable code path: jsdom's matchMedia is undefined by
    // default, so stub it to report `(hover: hover)` matches.
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("hover: hover"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      plaidItems = [
        {
          id: "i-hover",
          institutionName: "Chase",
          lastSyncedAt: new Date().toISOString(),
          lastSyncError: "the login details of this item have changed",
          lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        },
      ];
      renderButton();
      const trigger = screen.getByTestId("button-plaid-reconnect-trigger");
      // Popover starts closed — no per-item Reconnect button rendered yet.
      expect(screen.queryByTestId("button-plaid-reconnect-i-hover")).toBeNull();
      // Hovering (no click) should open the popover after the open delay.
      fireEvent.mouseEnter(trigger);
      await waitFor(() => {
        expect(
          screen.getByTestId("button-plaid-reconnect-i-hover"),
        ).toBeTruthy();
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("does NOT show the Reconnect popover for non-reauth errors (e.g. RATE_LIMIT_EXCEEDED)", () => {
    plaidItems = [
      {
        id: "i-rate",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "rate limit exceeded",
        lastSyncErrorCode: "RATE_LIMIT_EXCEEDED",
      },
    ];
    renderButton();
    // The chip still shows, but no Reconnect trigger — re-auth wouldn't fix
    // this.
    expect(screen.queryByTestId("button-plaid-reconnect-trigger")).toBeNull();
    expect(screen.queryByTestId("button-plaid-reconnect-i-rate")).toBeNull();
    expect(screen.getByTestId("text-sync-error")).toBeTruthy();
  });

  it("does NOT show the Reconnect popover when every item is healthy (no error code)", () => {
    plaidItems = [
      {
        id: "i-ok",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null,
        lastSyncErrorCode: null,
      },
    ];
    renderButton();
    // Acceptance: when zero items need reconnect, no popover/button group is
    // rendered — chip behaves exactly as it does today.
    expect(screen.queryByTestId("button-plaid-reconnect-trigger")).toBeNull();
    expect(screen.queryByTestId("button-plaid-reconnect-i-ok")).toBeNull();
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
