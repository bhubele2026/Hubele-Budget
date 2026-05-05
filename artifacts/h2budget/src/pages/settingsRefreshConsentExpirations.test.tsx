import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Hoisted spies/state so the per-test "mode" can drive what the mocked
// useRefreshPlaidConsentExpirations.mutate does (success-only, partial
// failure, network error) and so the test body can assert against the
// toast + queryClient.invalidateQueries calls.
const h = vi.hoisted(() => {
  type Mode =
    | { kind: "success"; result: unknown }
    | { kind: "error"; err: unknown };
  return {
    mode: { current: null as Mode | null },
    toast: vi.fn(),
    invalidateQueries: vi.fn(),
    refreshMutate: vi.fn(),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: h.toast }),
}));
vi.mock("@/components/owner-invitations", () => ({
  OwnerInvitationsSection: () => null,
}));
vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));
vi.mock("react-plaid-link", () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false }),
}));
vi.mock("@/hooks/use-plaid-sync", () => ({
  usePlaidSync: () => ({ runSync: vi.fn(), isPending: false }),
  formatPlaidErrorForDisplay: (s: string) => s,
}));

// Force every useQueryClient() consumer in SettingsPage to share the spy
// for invalidateQueries so the test can assert the cache key without
// having to thread a real QueryClient through.
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
  };
});

vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = { mutate: noop, mutateAsync: asyncNoop, isPending: false };

  const SETTINGS = {
    weeklyAllowanceAmount: "0",
    monthlyAllowanceAmount: "0",
    unplannedAllowanceAmount: "0",
    primaryAccount: "",
    preferences: { daysSinceTrackers: [] as unknown[] },
  };
  const SETTINGS_RESULT = { data: SETTINGS, isLoading: false };

  // At least one linked item so the "Refresh disconnect dates" row
  // actually renders — SettingsPage hides it when there are zero items.
  const PLAID_ITEMS = [
    {
      id: "item-1",
      institutionName: "Chase",
      lastSyncedAt: "2026-04-01T00:00:00.000Z",
      lastSyncError: null,
      lastSyncErrorCode: null,
      stillPreparing: false,
      stillPreparingSince: null,
      accounts: [],
    },
  ];
  const PLAID_ITEMS_RESULT = { data: PLAID_ITEMS };
  const PLAID_ENV_RESULT = {
    data: {
      env: "production",
      configured: true,
      nonProdItemCount: 0,
      nonProdItems: [] as unknown[],
    },
  };
  const CATEGORIES_RESULT = { data: [] as unknown[] };

  // Drive the per-test mode through h.mode.current. Mutate calls the
  // matching callback synchronously so the test doesn't have to await.
  h.refreshMutate.mockImplementation(
    (
      _vars: unknown,
      opts?: {
        onSuccess?: (res: unknown) => void;
        onError?: (err: unknown) => void;
      },
    ) => {
      const mode = h.mode.current;
      if (!mode) return;
      if (mode.kind === "success") opts?.onSuccess?.(mode.result);
      else opts?.onError?.(mode.err);
    },
  );

  return {
    useGetSettings: () => SETTINGS_RESULT,
    useUpdateSettings: () => mutation,
    useImportWorkbook: () => mutation,
    useListPlaidItems: () => PLAID_ITEMS_RESULT,
    useDeletePlaidItem: () => mutation,
    useSyncPlaidTransactions: () => mutation,
    useGetPlaidEnvironment: () => PLAID_ENV_RESULT,
    useCleanupNonProdPlaidItems: () => mutation,
    useRefreshPlaidConsentExpirations: () => ({
      mutate: h.refreshMutate,
      mutateAsync: async () => undefined,
      isPending: false,
    }),
    useListCategories: () => CATEGORIES_RESULT,
    useCreatePlaidUpdateLinkToken: () => mutation,
    getGetSettingsQueryKey: () => ["settings"],
    getListDashboardBudgetsQueryKey: () => ["dashboard-budgets"],
    getGetPlaidEnvironmentQueryKey: () => ["plaid-env"],
    getListPlaidItemsQueryKey: () => ["plaid-items"],
    getListTransactionsQueryKey: () => ["transactions"],
  };
});

import SettingsPage from "./settings";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  h.mode.current = null;
  h.toast.mockReset();
  h.invalidateQueries.mockReset();
  h.refreshMutate.mockClear();
});

describe("(#266) Settings — Refresh disconnect dates button", () => {
  it("on success-only: shows the 'Checked N banks · M cutoffs updated' toast and invalidates the items query", () => {
    h.mode.current = {
      kind: "success",
      result: {
        scanned: 4,
        updated: 2,
        items: [
          { itemId: "i1", institutionName: "Chase", error: null },
          { itemId: "i2", institutionName: "Ally", error: null },
        ],
      },
    };
    renderPage();

    fireEvent.click(screen.getByTestId("button-refresh-consent-expirations"));

    expect(h.refreshMutate).toHaveBeenCalledTimes(1);

    expect(h.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["plaid-items"],
    });

    expect(h.toast).toHaveBeenCalledTimes(1);
    const arg = h.toast.mock.calls[0][0];
    expect(arg.title).toBe("Disconnect dates refreshed");
    expect(arg.description).toBe("Checked 4 banks · 2 cutoffs updated");
    expect(arg.variant).toBeUndefined();
  });

  it("pluralizes 'bank' / 'cutoff' correctly when scanned === 1 and updated === 1", () => {
    h.mode.current = {
      kind: "success",
      result: {
        scanned: 1,
        updated: 1,
        items: [{ itemId: "i1", institutionName: "Chase", error: null }],
      },
    };
    renderPage();

    fireEvent.click(screen.getByTestId("button-refresh-consent-expirations"));

    const arg = h.toast.mock.calls[0][0];
    expect(arg.description).toBe("Checked 1 bank · 1 cutoff updated");
  });

  it("on partial failure: lists failed institution names in the toast and switches to destructive variant", () => {
    h.mode.current = {
      kind: "success",
      result: {
        scanned: 3,
        updated: 1,
        items: [
          { itemId: "i1", institutionName: "Chase", error: null },
          {
            itemId: "i2",
            institutionName: "Wells Fargo",
            error: "ITEM_LOGIN_REQUIRED",
          },
          { itemId: "i3", institutionName: null, error: "INTERNAL_SERVER_ERROR" },
        ],
      },
    };
    renderPage();

    fireEvent.click(screen.getByTestId("button-refresh-consent-expirations"));

    // The items query still gets invalidated even when some items error
    // — successful ones should re-render with their fresh cutoff line.
    expect(h.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["plaid-items"],
    });

    const arg = h.toast.mock.calls[0][0];
    expect(arg.title).toBe("Disconnect dates refreshed (with errors)");
    expect(arg.description).toBe(
      "Checked 3 banks · 1 cutoff updated. Failed: Wells Fargo, Unnamed institution.",
    );
    expect(arg.variant).toBe("destructive");
  });

  it("on network/onError path: shows a destructive 'Refresh failed' toast with the error message and does NOT invalidate the items query", () => {
    h.mode.current = {
      kind: "error",
      err: new Error("network down"),
    };
    renderPage();

    fireEvent.click(screen.getByTestId("button-refresh-consent-expirations"));

    expect(h.invalidateQueries).not.toHaveBeenCalled();

    expect(h.toast).toHaveBeenCalledTimes(1);
    const arg = h.toast.mock.calls[0][0];
    expect(arg.title).toBe("Refresh failed");
    expect(arg.description).toBe("network down");
    expect(arg.variant).toBe("destructive");
  });
});
