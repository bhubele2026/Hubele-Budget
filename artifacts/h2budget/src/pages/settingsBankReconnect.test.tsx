import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Stub side-effects we don't care about for this render test.
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/owner-invitations", () => ({
  OwnerInvitationsSection: () => null,
}));
vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));
// PlaidReconnectButton pulls in react-plaid-link + use-plaid-sync at module
// eval; stub them so the render doesn't try to talk to Plaid.
vi.mock("react-plaid-link", () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false }),
}));
vi.mock("@/hooks/use-plaid-sync", () => ({
  usePlaidSync: () => ({ runSync: vi.fn(), isPending: false }),
  formatPlaidErrorForDisplay: (s: string) => s,
}));

vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = { mutate: noop, mutateAsync: asyncNoop, isPending: false };

  // Stable references — SettingsPage runs a useEffect on `settings` changes
  // that calls form.reset/setTrackers. A fresh object per render would loop.
  const SETTINGS = {
    weeklyAllowanceAmount: "0",
    monthlyAllowanceAmount: "0",
    unplannedAllowanceAmount: "0",
    primaryAccount: "",
    preferences: { daysSinceTrackers: [] as unknown[] },
  };
  const SETTINGS_RESULT = { data: SETTINGS, isLoading: false };

  // Two items in re-auth state at the same time + one healthy item. The
  // whole point of this test is the regression where only the *first* broken
  // item rendered a Reconnect button — see Task #197 / Task #205.
  const PLAID_ITEMS = [
    {
      id: "item-broken-1",
      institutionName: "Chase",
      lastSyncedAt: null,
      lastSyncError: "the login details of this item have changed",
      lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      stillPreparing: false,
      stillPreparingSince: null,
      accounts: [],
    },
    {
      id: "item-broken-2",
      institutionName: "Wells Fargo",
      lastSyncedAt: null,
      lastSyncError: "access will expire soon",
      lastSyncErrorCode: "PENDING_EXPIRATION",
      stillPreparing: false,
      stillPreparingSince: null,
      accounts: [],
    },
    {
      id: "item-healthy",
      institutionName: "Ally",
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
  return {
    useGetSettings: () => SETTINGS_RESULT,
    useUpdateSettings: () => mutation,
    useImportWorkbook: () => mutation,
    useListPlaidItems: () => PLAID_ITEMS_RESULT,
    useDeletePlaidItem: () => mutation,
    useSyncPlaidTransactions: () => mutation,
    useGetPlaidEnvironment: () => PLAID_ENV_RESULT,
    useCleanupNonProdPlaidItems: () => mutation,
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
});

describe("(#205) Settings — Reconnect button shows for EVERY broken Plaid item", () => {
  it("renders a Needs-reconnect badge AND Reconnect button for every item in a re-auth error state", () => {
    renderPage();

    // Both broken banks must surface the badge + the per-item Reconnect
    // button. The original bug only rendered for the first one, forcing
    // users to fix one bank, refresh, then fix the next.
    expect(
      screen.getByTestId("badge-needs-reconnect-item-broken-1"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("button-plaid-reconnect-item-broken-1"),
    ).toBeTruthy();

    expect(
      screen.getByTestId("badge-needs-reconnect-item-broken-2"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("button-plaid-reconnect-item-broken-2"),
    ).toBeTruthy();
  });

  it("does NOT render the badge or Reconnect button for items without a re-auth error code", () => {
    renderPage();

    expect(
      screen.queryByTestId("badge-needs-reconnect-item-healthy"),
    ).toBeNull();
    expect(
      screen.queryByTestId("button-plaid-reconnect-item-healthy"),
    ).toBeNull();
  });
});
