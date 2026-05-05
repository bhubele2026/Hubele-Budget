import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/owner-invitations", () => ({
  OwnerInvitationsSection: () => null,
}));
vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));

vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = { mutate: noop, mutateAsync: asyncNoop, isPending: false };
  // Stable references — SettingsPage runs a useEffect on `settings` changes
  // that calls form.reset/setTrackers, so a fresh object per render would
  // loop forever.
  const SETTINGS = {
    weeklyAllowanceAmount: "0",
    monthlyAllowanceAmount: "0",
    unplannedAllowanceAmount: "0",
    primaryAccount: "",
    preferences: {
      daysSinceTrackers: [
        {
          id: "tracker-1",
          label: "Coffee",
          matchType: "keyword",
          matchValue: "coffee",
        },
      ],
    },
  };
  const SETTINGS_RESULT = { data: SETTINGS, isLoading: false };
  const PLAID_ITEMS_RESULT = { data: [] as unknown[] };
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
    useRefreshPlaidConsentExpirations: () => mutation,
    useListCategories: () => CATEGORIES_RESULT,
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

describe("Settings — Behavior Tracker rule validation blocks save", () => {
  it("shows inline error and disables Save when a tracker pattern is an invalid regex, then re-enables once fixed", () => {
    renderPage();

    const valueInput = screen.getByTestId(
      "input-tracker-value-tracker-1",
    ) as HTMLInputElement;
    const saveButton = screen.getByTestId(
      "button-save-trackers",
    ) as HTMLButtonElement;

    // Baseline: a valid keyword rule means no inline error and Save is enabled.
    expect(
      screen.queryByTestId("tracker-value-error-tracker-1"),
    ).toBeNull();
    expect(screen.queryByTestId("tracker-save-blocked")).toBeNull();
    expect(saveButton.disabled).toBe(false);

    // Type a malformed regex (unclosed group). compileMatcher should fail
    // to construct a RegExp and surface an error.
    fireEvent.change(valueInput, { target: { value: "(unclosed" } });

    const inlineError = screen.getByTestId("tracker-value-error-tracker-1");
    expect(inlineError.textContent ?? "").toContain("Couldn't read this rule");
    expect(valueInput.getAttribute("aria-invalid")).toBe("true");
    expect(saveButton.disabled).toBe(true);
    expect(screen.getByTestId("tracker-save-blocked")).toBeTruthy();

    // Fix the pattern — Save should re-enable and the inline error clears.
    fireEvent.change(valueInput, { target: { value: "coffee" } });

    expect(
      screen.queryByTestId("tracker-value-error-tracker-1"),
    ).toBeNull();
    expect(screen.queryByTestId("tracker-save-blocked")).toBeNull();
    expect(saveButton.disabled).toBe(false);
  });
});
