import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  type UseQueryOptions,
} from "@tanstack/react-query";
import React from "react";

// Inert stubs for noisy side-effects pulled in by the Settings page —
// matches the pattern used by `settingsBankReconnect.test.tsx`.
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
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

// Module-level mutable state the fake `queryFn` reads from. Defined OUTSIDE
// the `vi.mock` factory so the test body can flip the data between phases.
type PlaidItemFixture = {
  id: string;
  institutionName: string;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastSyncErrorCode: string | null;
  stillPreparing: boolean;
  stillPreparingSince: string | null;
  accounts: unknown[];
};
const ITEMS_REF: { current: PlaidItemFixture[] } = { current: [] };
let plaidFetchCount = 0;

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
    // The whole point of this test: route useListPlaidItems through a REAL
    // useQuery so the function-form `refetchInterval` option supplied by
    // SettingsPage is actually exercised end-to-end. The sibling
    // `settingsBankReconnect.test.tsx` mock returns static data and ignores
    // options, which would silently let any regression on this gating slip
    // through.
    useListPlaidItems: (
      options?: { query?: Partial<UseQueryOptions<PlaidItemFixture[]>> },
    ) =>
      useQuery({
        queryKey: ["plaid-items"],
        queryFn: async () => {
          plaidFetchCount++;
          return ITEMS_REF.current;
        },
        ...(options?.query ?? {}),
      } as UseQueryOptions<PlaidItemFixture[]>),
    useDeletePlaidItem: () => mutation,
    useGetPlaidEnvironment: () => PLAID_ENV_RESULT,
    useCleanupNonProdPlaidItems: () => mutation,
    useListCategories: () => CATEGORIES_RESULT,
    getGetSettingsQueryKey: () => ["settings"],
    getListDashboardBudgetsQueryKey: () => ["dashboard-budgets"],
    getGetPlaidEnvironmentQueryKey: () => ["plaid-env"],
    getListPlaidItemsQueryKey: () => ["plaid-items"],
  };
});

import SettingsPage from "./settings";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: Infinity },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe("(#224) Settings — useListPlaidItems polling self-gates on stillPreparing", () => {
  beforeEach(() => {
    cleanup();
    plaidFetchCount = 0;
    vi.useFakeTimers();
    // Pin the clock so `new Date().toISOString()` and the in-page `nowTick`
    // helpers are deterministic across test runs.
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
    ITEMS_REF.current = [
      {
        id: "item-prep",
        institutionName: "Chase",
        lastSyncedAt: null,
        lastSyncError: null,
        lastSyncErrorCode: null,
        stillPreparing: true,
        stillPreparingSince: new Date().toISOString(),
        accounts: [],
      },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refetches every 90s while an item is still preparing, and stops once the server clears the flag", async () => {
    renderPage();

    // Flush the initial useQuery fetch + state propagation.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(plaidFetchCount).toBe(1);

    // First 90s window — server still says "still preparing", so we should
    // see a background refetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(plaidFetchCount).toBe(2);

    // Second 90s window — same gating, another refetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(plaidFetchCount).toBe(3);

    // Server finishes preparing the historical batch — flip the fixture so
    // the NEXT fetch returns an item with stillPreparing === false.
    ITEMS_REF.current = [
      {
        id: "item-prep",
        institutionName: "Chase",
        lastSyncedAt: "2026-05-04T12:05:00.000Z",
        lastSyncError: null,
        lastSyncErrorCode: null,
        stillPreparing: false,
        stillPreparingSince: null,
        accounts: [],
      },
    ];

    // Third 90s window — the interval was already scheduled before the flag
    // cleared, so we expect one more refetch that pulls the cleared state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(plaidFetchCount).toBe(4);

    // Now `refetchInterval` should evaluate to `false` and polling must
    // stop. Burn through several more 90s windows; the count must NOT grow.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 90_000);
    });
    expect(plaidFetchCount).toBe(4);
  });

  it("never starts polling when no linked item is preparing on first load", async () => {
    ITEMS_REF.current = [
      {
        id: "item-healthy",
        institutionName: "Ally",
        lastSyncedAt: "2026-05-01T00:00:00.000Z",
        lastSyncError: null,
        lastSyncErrorCode: null,
        stillPreparing: false,
        stillPreparingSince: null,
        accounts: [],
      },
    ];

    renderPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(plaidFetchCount).toBe(1);

    // Advance well past several would-be polling windows. With no preparing
    // item the function-form refetchInterval returns `false` immediately,
    // so no further fetches should fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 90_000);
    });
    expect(plaidFetchCount).toBe(1);
  });
});
