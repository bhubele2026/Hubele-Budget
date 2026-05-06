import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (#370) Capture Plaid Link onSuccess so the test can drive it
// directly (the real react-plaid-link iframe never opens in jsdom).
let capturedOnSuccess:
  | ((publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } | null }) => Promise<void> | void)
  | null = null;

vi.mock("react-plaid-link", () => ({
  usePlaidLink: ({
    onSuccess,
  }: {
    onSuccess: (
      publicToken: string,
      metadata: { institution?: { institution_id?: string; name?: string } | null },
    ) => Promise<void> | void;
  }) => {
    capturedOnSuccess = onSuccess;
    return { open: vi.fn(), ready: false };
  },
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

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

// (#370) Hook mocks. We make `mutate` user-controllable per-test
// via these spies so we can drive the 409→relink branch precisely.
type MutOpts<TData = unknown> = {
  onSuccess?: (data: TData) => void;
  onError?: (err: unknown) => void;
};
const updateLinkTokenMutate = vi.fn();
const linkTokenMutate = vi.fn();
const exchangeMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useCreatePlaidUpdateLinkToken: () => ({
    mutate: updateLinkTokenMutate,
    isPending: false,
  }),
  useCreatePlaidLinkToken: () => ({
    mutate: linkTokenMutate,
    isPending: false,
  }),
  useExchangePlaidPublicToken: () => ({
    mutate: exchangeMutate,
    isPending: false,
  }),
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
  toastMock.mockClear();
  runSyncMock.mockClear();
  updateLinkTokenMutate.mockReset();
  linkTokenMutate.mockReset();
  exchangeMutate.mockReset();
});

function renderButton() {
  const qc = new QueryClient();
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <PlaidReconnectButton itemId="item-1" institutionName="Chase" />
      </QueryClientProvider>,
    ),
  };
}

describe("(#370) PlaidReconnectButton 409→fresh-link fallback (no reconnect loop)", () => {
  it("falls through to /plaid/link-token (and does NOT toast) when /plaid/link-token/update returns 409 + action:'relink'", async () => {
    // The update-mode token mint rejects with the server's "this item
    // can't be repaired in update mode — re-link" signal.
    updateLinkTokenMutate.mockImplementation(
      (_vars: unknown, opts: MutOpts) => {
        opts.onError?.({ status: 409, data: { action: "relink" } });
      },
    );
    // The fresh-link mint succeeds (we never need to actually open
    // Plaid Link in jsdom — just prove the call was made).
    linkTokenMutate.mockImplementation((_vars: unknown, opts: MutOpts) => {
      opts.onSuccess?.({ linkToken: "link-sandbox-fresh" });
    });

    renderButton();
    fireEvent.click(screen.getByTestId("button-plaid-reconnect-item-1"));

    // Update-mode endpoint was tried first with the right item id...
    expect(updateLinkTokenMutate).toHaveBeenCalledTimes(1);
    expect(updateLinkTokenMutate.mock.calls[0][0]).toEqual({
      data: { itemId: "item-1" },
    });
    // ...and on 409 the component silently routed to the fresh-link
    // mint instead of toasting "Could not start reconnect" — this is
    // what stops the previous reconnect loop.
    await waitFor(() => expect(linkTokenMutate).toHaveBeenCalledTimes(1));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("DOES toast 'Could not start reconnect' for non-409 errors (regression guard so the fallback is targeted)", async () => {
    updateLinkTokenMutate.mockImplementation(
      (_vars: unknown, opts: MutOpts) => {
        opts.onError?.(new Error("network down"));
      },
    );

    renderButton();
    fireEvent.click(screen.getByTestId("button-plaid-reconnect-item-1"));

    expect(linkTokenMutate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not start reconnect",
          variant: "destructive",
        }),
      ),
    );
  });

  it("after the 409→fresh-link fallback, completing Plaid Link routes the public_token through /plaid/exchange (which clears lastSyncErrorCode server-side)", async () => {
    updateLinkTokenMutate.mockImplementation(
      (_vars: unknown, opts: MutOpts) => {
        opts.onError?.({ status: 409, data: { action: "relink" } });
      },
    );
    linkTokenMutate.mockImplementation((_vars: unknown, opts: MutOpts) => {
      opts.onSuccess?.({ linkToken: "link-sandbox-fresh" });
    });
    exchangeMutate.mockImplementation((_vars: unknown, opts: MutOpts) => {
      opts.onSuccess?.({});
    });

    renderButton();
    fireEvent.click(screen.getByTestId("button-plaid-reconnect-item-1"));
    await waitFor(() => expect(linkTokenMutate).toHaveBeenCalled());
    expect(capturedOnSuccess).not.toBeNull();

    // Simulate the user finishing Plaid Link in the (fresh) brand-new
    // mode — this is what the previous loop never reached.
    await capturedOnSuccess!("public-sandbox-abc", {
      institution: { institution_id: "ins_56", name: "Chase" },
    });

    // Exchange must have been invoked with the fresh public_token.
    // Server-side (plaidExchangeRelink.integration.test.ts) already
    // proves this clears lastSyncError + lastSyncErrorCode on the row;
    // wiring it here proves the client actually sends the token.
    expect(exchangeMutate).toHaveBeenCalledTimes(1);
    expect(exchangeMutate.mock.calls[0][0]).toEqual({
      data: {
        publicToken: "public-sandbox-abc",
        institutionId: "ins_56",
        institutionName: "Chase",
      },
    });
    // Then the silent post-link sync runs against the now-healthy item.
    await waitFor(() =>
      expect(runSyncMock).toHaveBeenCalledWith({
        itemId: "item-1",
        silent: true,
      }),
    );
  });
});
