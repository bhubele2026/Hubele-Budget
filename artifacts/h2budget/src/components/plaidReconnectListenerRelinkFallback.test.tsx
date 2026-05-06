import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (#370) Capture Plaid Link onSuccess so the test can drive it
// directly — react-plaid-link won't actually open in jsdom.
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

import {
  PlaidReconnectListener,
  dispatchPlaidReconnect,
} from "./plaid-reconnect-listener";

beforeEach(() => {
  cleanup();
  capturedOnSuccess = null;
  toastMock.mockClear();
  runSyncMock.mockClear();
  updateLinkTokenMutate.mockReset();
  linkTokenMutate.mockReset();
  exchangeMutate.mockReset();
});

function mount() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <PlaidReconnectListener />
    </QueryClientProvider>,
  );
}

describe("(#370) PlaidReconnectListener 409→fresh-link fallback (no reconnect loop)", () => {
  it("falls through to /plaid/link-token (and does NOT toast) when /plaid/link-token/update returns 409 + action:'relink' from a global plaid:reconnect event", async () => {
    updateLinkTokenMutate.mockImplementation(
      (_vars: unknown, opts: MutOpts) => {
        opts.onError?.({ status: 409, data: { action: "relink" } });
      },
    );
    linkTokenMutate.mockImplementation((_vars: unknown, opts: MutOpts) => {
      opts.onSuccess?.({ linkToken: "link-sandbox-fresh" });
    });

    mount();
    act(() => {
      dispatchPlaidReconnect({ itemId: "item-9", institutionName: "Chase" });
    });

    expect(updateLinkTokenMutate).toHaveBeenCalledTimes(1);
    expect(updateLinkTokenMutate.mock.calls[0][0]).toEqual({
      data: { itemId: "item-9" },
    });
    await waitFor(() => expect(linkTokenMutate).toHaveBeenCalledTimes(1));
    // The whole point of #367 — no error toast on the 409 branch.
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not start reconnect" }),
    );
  });

  it("DOES toast for non-409 errors (so the 409→relink fallback stays narrowly targeted)", async () => {
    updateLinkTokenMutate.mockImplementation(
      (_vars: unknown, opts: MutOpts) => {
        opts.onError?.(new Error("network down"));
      },
    );

    mount();
    act(() => {
      dispatchPlaidReconnect({ itemId: "item-9", institutionName: "Chase" });
    });

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

    mount();
    act(() => {
      dispatchPlaidReconnect({ itemId: "item-9", institutionName: "Chase" });
    });
    await waitFor(() => expect(linkTokenMutate).toHaveBeenCalled());
    expect(capturedOnSuccess).not.toBeNull();

    await capturedOnSuccess!("public-sandbox-abc", {
      institution: { institution_id: "ins_56", name: "Chase" },
    });

    expect(exchangeMutate).toHaveBeenCalledTimes(1);
    expect(exchangeMutate.mock.calls[0][0]).toEqual({
      data: {
        publicToken: "public-sandbox-abc",
        institutionId: "ins_56",
        institutionName: "Chase",
      },
    });
    await waitFor(() =>
      expect(runSyncMock).toHaveBeenCalledWith({
        itemId: "item-9",
        silent: true,
      }),
    );
  });
});
