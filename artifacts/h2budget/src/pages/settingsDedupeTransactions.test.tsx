import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const h = vi.hoisted(() => {
  type Mode =
    | { kind: "success"; result: unknown }
    | { kind: "error"; err: unknown };
  return {
    mode: { current: null as Mode | null },
    toast: vi.fn(),
    invalidateQueries: vi.fn(),
    dedupeMutate: vi.fn(),
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

  // The dedupe row only renders when at least one Plaid item exists, so
  // give it one — same gating as the consent-refresh row's test.
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

  h.dedupeMutate.mockImplementation(
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
    useRefreshPlaidConsentExpirations: () => mutation,
    useUpdatePlaidImportCutoffDate: () => mutation,
    useDedupeTransactions: () => ({
      mutate: h.dedupeMutate,
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
    getGetForecastQueryKey: () => ["forecast"],
    useListPlaidSyncAttempts: () => ({ data: undefined, isLoading: false, isError: false }),
    getListPlaidSyncAttemptsQueryKey: (id: string) => ["plaid-sync-attempts", id],
    // Hooks SettingsPage (and its unconditionally-rendered children) call at
    // render time that were added after this test was first written.
    useClearPlaidItemRefreshDisabled: () => mutation,
    // The Clean-up button is gated behind `duplicateCount > 0`, so the
    // read-only count must report a non-zero number for the row to render.
    useGetDuplicateTransactionCount: () => ({ data: { duplicateCount: 3 } }),
    getGetDuplicateTransactionCountQueryKey: () => ["duplicate-count"],
    // OwnerBankHealthSweepSection renders unconditionally in SettingsPage.
    useGetMe: () => ({ data: { isOwner: false }, isLoading: false }),
    useRunPlaidMalformedTokenSweep: () => mutation,
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

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cleanup();
  h.mode.current = null;
  h.toast.mockReset();
  h.invalidateQueries.mockReset();
  h.dedupeMutate.mockClear();
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe("(#458) Settings — Clean up duplicate transactions button", () => {
  it("on success with merges: invalidates transactions + forecast and toasts the merged-count copy", () => {
    h.mode.current = {
      kind: "success",
      result: {
        duplicatesRemoved: 3,
        accountsScanned: 4,
        resolutionsRepointed: 2,
      },
    };
    renderPage();

    fireEvent.click(screen.getByTestId("button-dedupe-transactions"));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.dedupeMutate).toHaveBeenCalledTimes(1);

    expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["transactions"] });
    expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["forecast"] });

    expect(h.toast).toHaveBeenCalledTimes(1);
    const arg = h.toast.mock.calls[0][0];
    expect(arg.title).toBe("Merged 3 duplicates");
    expect(arg.description).toBe(
      "Scanned 4 accounts and repointed 2 forecast matches.",
    );
    expect(arg.variant).toBeUndefined();
  });

  it("pluralizes correctly when removed === 1, accounts === 1, repointed === 1", () => {
    h.mode.current = {
      kind: "success",
      result: {
        duplicatesRemoved: 1,
        accountsScanned: 1,
        resolutionsRepointed: 1,
      },
    };
    renderPage();

    fireEvent.click(screen.getByTestId("button-dedupe-transactions"));

    const arg = h.toast.mock.calls[0][0];
    expect(arg.title).toBe("Merged 1 duplicate");
    expect(arg.description).toBe(
      "Scanned 1 account and repointed 1 forecast match.",
    );
  });

  it("on no-op (zero duplicates): toasts the 'already clean' copy", () => {
    h.mode.current = {
      kind: "success",
      result: {
        duplicatesRemoved: 0,
        accountsScanned: 5,
        resolutionsRepointed: 0,
      },
    };
    renderPage();

    fireEvent.click(screen.getByTestId("button-dedupe-transactions"));

    expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["transactions"] });
    expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["forecast"] });

    const arg = h.toast.mock.calls[0][0];
    expect(arg.title).toBe("No duplicates found");
    expect(arg.description).toBe(
      "Scanned 5 accounts — your ledger is already clean.",
    );
    expect(arg.variant).toBeUndefined();
  });

  it("when the user cancels the confirm prompt: does NOT call the mutation, invalidate caches, or toast", () => {
    confirmSpy.mockReturnValue(false);
    renderPage();

    fireEvent.click(screen.getByTestId("button-dedupe-transactions"));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.dedupeMutate).not.toHaveBeenCalled();
    expect(h.invalidateQueries).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("on network/onError path: shows a destructive 'Cleanup failed' toast and does NOT invalidate caches", () => {
    h.mode.current = { kind: "error", err: new Error("network down") };
    renderPage();

    fireEvent.click(screen.getByTestId("button-dedupe-transactions"));

    expect(h.invalidateQueries).not.toHaveBeenCalled();

    expect(h.toast).toHaveBeenCalledTimes(1);
    const arg = h.toast.mock.calls[0][0];
    expect(arg.title).toBe("Cleanup failed");
    expect(arg.description).toBe("network down");
    expect(arg.variant).toBe("destructive");
  });
});
