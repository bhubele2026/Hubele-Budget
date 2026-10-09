import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (C8) Settings as one area with a local tab bar (`?tab=`). Pins the tab
// model, that every old link to /settings still lands on Banks, what each tab
// holds (ST-01…19), the bank panels with an AccountChip per account, and that
// a tab change keeps the page mounted (an unsaved edit survives it).

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/owner-invitations", () => ({
  OwnerInvitationsSection: () => <div data-testid="stub-owner-invitations" />,
}));
vi.mock("@/components/owner-bank-health-sweep", () => ({
  OwnerBankHealthSweepSection: () => <div data-testid="stub-bank-health-sweep" />,
}));
vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => <button type="button" data-testid="button-link-bank">Link</button>,
}));
vi.mock("@/components/plaid-sync-history", () => ({
  PlaidSyncHistory: ({ itemId }: { itemId: string }) => <div data-testid={`stub-sync-history-${itemId}`} />,
}));
vi.mock("react-plaid-link", () => ({ usePlaidLink: () => ({ open: vi.fn(), ready: false }) }));
vi.mock("@/hooks/use-plaid-sync", () => ({
  usePlaidSync: () => ({ runSync: vi.fn(async () => undefined), isPending: false }),
  formatPlaidErrorForDisplay: (s: string) => s,
}));
// The fold-in tabs are lazy chunks with their own tests; here they are stubs.
vi.mock("./settings/AutomationTab", () => ({ default: () => <div data-testid="stub-automation" /> }));
vi.mock("./settings/MorningTextTab", () => ({ default: () => <div data-testid="stub-morning-text" /> }));
vi.mock("./settings/AiCostTab", () => ({ default: () => <div data-testid="stub-ai-cost" /> }));

const updateSettings = vi.hoisted(() => vi.fn());
vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = { mutate: noop, mutateAsync: asyncNoop, isPending: false };
  const SETTINGS = {
    weeklyAllowanceAmount: "100",
    monthlyAllowanceAmount: "400",
    unplannedAllowanceAmount: "50",
    primaryAccount: "",
    preferences: {},
  };
  const SETTINGS_RESULT = { data: SETTINGS, isLoading: false };
  const PLAID_ITEMS_RESULT = {
    data: [
      {
        id: "item-chase",
        itemId: "i1",
        institutionName: "Chase",
        institutionSlug: "chase",
        lastSyncedAt: "2026-10-07T12:00:00Z",
        accounts: [
          { id: "acc-chk", accountId: "p-chk", name: "Total Checking", mask: "4321", type: "depository", subtype: "checking", firstSyncCompletedAt: "2026-01-01T00:00:00Z" },
        ],
      },
      {
        id: "item-amex",
        itemId: "i2",
        institutionName: "American Express",
        institutionSlug: "amex",
        lastSyncedAt: "2026-10-07T12:00:00Z",
        accounts: [
          { id: "acc-amex", accountId: "p-amex", name: "Blue Cash Everyday", mask: "1009", type: "credit", subtype: "credit card", firstSyncCompletedAt: null },
        ],
      },
    ],
  };
  const PLAID_ENV_RESULT = { data: { env: "production", configured: true, nonProdItemCount: 0, nonProdItems: [] } };
  const CATEGORIES_RESULT = { data: [] as unknown[] };
  return {
    useGetSettings: () => SETTINGS_RESULT,
    useUpdateSettings: () => ({ mutate: updateSettings, isPending: false }),
    useImportWorkbook: () => mutation,
    useListPlaidItems: () => PLAID_ITEMS_RESULT,
    useDeletePlaidItem: () => mutation,
    useGetPlaidEnvironment: () => PLAID_ENV_RESULT,
    useCleanupNonProdPlaidItems: () => mutation,
    useRefreshPlaidConsentExpirations: () => mutation,
    useListCategories: () => CATEGORIES_RESULT,
    getGetSettingsQueryKey: () => ["settings"],
    getListDashboardBudgetsQueryKey: () => ["dashboard-budgets"],
    getGetPlaidEnvironmentQueryKey: () => ["plaid-env"],
    getListPlaidItemsQueryKey: () => ["plaid-items"],
    getListTransactionsQueryKey: () => ["transactions"],
    getGetForecastQueryKey: () => ["forecast"],
    useClearPlaidItemRefreshDisabled: () => mutation,
    useUpdatePlaidImportCutoffDate: () => mutation,
    useDedupeTransactions: () => mutation,
    useGetDuplicateTransactionCount: () => ({ data: undefined }),
    getGetDuplicateTransactionCountQueryKey: () => ["duplicate-count"],
    useGetMe: () => ({ data: { isOwner: true }, isLoading: false }),
  };
});

import SettingsPage from "./settings";
import { SETTINGS_TABS, tabHref, tabOf } from "./settings/settingsTabs";

function open(path: string) {
  window.history.replaceState(null, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => cleanup());
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("(C8) the tab model", () => {
  it("seven tabs; Banks is plain /settings; anything unknown is Banks", () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual([
      "Banks",
      "Household",
      "Data",
      "Automation",
      "Morning text",
      "AI cost",
      "Privacy",
    ]);
    expect(tabHref("banks")).toBe("/settings");
    expect(tabHref("morning-text")).toBe("/settings?tab=morning-text");
    expect(tabOf("")).toBe("banks");
    expect(tabOf("?tab=ai")).toBe("ai");
    expect(tabOf("tab=household&x=1")).toBe("household");
    expect(tabOf("tab=nope")).toBe("banks");
  });
});

describe("(C8) Settings — tabs", () => {
  it("/settings opens on Banks, with the env chip, the tab bar and the bank panels", () => {
    open("/settings");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.getByTestId("badge-plaid-env").textContent).toBe("Plaid: production");
    const links = within(screen.getByTestId("settings-tabs")).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(SETTINGS_TABS.map((t) => t.label));
    expect(links.map((l) => l.getAttribute("href"))).toEqual(SETTINGS_TABS.map((t) => tabHref(t.key)));
    expect(screen.getByTestId("settings-tab-link-banks").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("settings-tab-link-household").getAttribute("aria-current")).toBeNull();

    const banks = screen.getByTestId("panel-banks");
    expect(within(banks).getByTestId("button-link-bank")).toBeTruthy();
    expect(within(banks).getByTestId("row-refresh-consent-expirations")).toBeTruthy();
    // One panel per bank, half width on desktop, with the account's identity edge.
    const chase = screen.getByTestId("plaid-item-item-chase");
    expect(chase.className).toContain("span-6");
    expect(chase.className).toContain("panel-accent-checking");
    expect(screen.getByTestId("plaid-item-item-amex").className).toContain("panel-accent-amex");
    // Every account as a chip with its masked digits.
    expect(within(chase).getByText("••4321")).toBeTruthy();
    expect(within(screen.getByTestId("plaid-item-item-amex")).getByText("••1009")).toBeTruthy();
    // The cutoff picker only until the first sync.
    expect(within(chase).queryByLabelText("Import after")).toBeNull();
    expect(within(screen.getByTestId("plaid-item-item-amex")).getByLabelText("Import after")).toBeTruthy();
    expect(screen.getByTestId("button-sync-item-chase")).toBeTruthy();
    expect(screen.getByTestId("button-force-refresh-item-chase")).toBeTruthy();
    expect(screen.getByTestId("button-unlink-item-chase")).toBeTruthy();
    expect(screen.getByTestId("stub-sync-history-item-chase")).toBeTruthy();
    expect(screen.getByTestId("stub-bank-health-sweep")).toBeTruthy();
    // Other tabs' sections are not on this one.
    expect(screen.queryByTestId("panel-allowances")).toBeNull();
    expect(screen.queryByTestId("panel-workbook-import")).toBeNull();
  });

  it("Household holds members, allowances, bucket names (five) and trackers", () => {
    open("/settings?tab=household");
    expect(screen.getByTestId("settings-tab-link-household").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("stub-owner-invitations")).toBeTruthy();
    expect(screen.getByTestId("panel-allowances").className).toContain("span-6");
    expect((screen.getByLabelText("Weekly allowance") as HTMLInputElement).value).toBe("100");
    const buckets = screen.getByTestId("panel-bucket-names");
    expect(within(buckets).getAllByRole("textbox")).toHaveLength(5);
    expect(buckets.querySelector('[role="note"]')?.getAttribute("aria-label")).toContain("five weekly spending buckets");
    expect(screen.getByTestId("panel-trackers").className).toContain("span-12");
    expect(screen.queryByTestId("panel-banks")).toBeNull();
  });

  it("ST-05: the allowance form saves the three amounts, and refuses an empty one", async () => {
    updateSettings.mockClear();
    open("/settings?tab=household");
    const form = screen.getByTestId("panel-allowances").querySelector("form")!;
    fireEvent.change(screen.getByLabelText("Weekly allowance"), { target: { value: "125" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0]![0]).toEqual({
      data: {
        weeklyAllowanceAmount: "125",
        monthlyAllowanceAmount: "400",
        unplannedAllowanceAmount: "50",
        primaryAccount: "",
      },
    });
    fireEvent.change(screen.getByLabelText("Monthly allowance"), { target: { value: "" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByTestId("allowance-form-error").textContent).toBe("Every allowance needs an amount.");
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it("ST-16: bucket names save all five, blanks fall back to the defaults", () => {
    updateSettings.mockClear();
    open("/settings?tab=household");
    const buckets = screen.getByTestId("panel-bucket-names");
    const boxes = within(buckets).getAllByRole("textbox");
    fireEvent.change(boxes[0]!, { target: { value: "Food" } });
    fireEvent.change(boxes[1]!, { target: { value: "  " } });
    fireEvent.click(within(buckets).getByRole("button", { name: "Save" }));
    const sent = updateSettings.mock.calls[0]![0] as { data: { preferences: { weeklyBucketLabels: Record<string, string> } } };
    const labels = sent.data.preferences.weeklyBucketLabels;
    expect(Object.keys(labels)).toHaveLength(5);
    expect(labels.groceries).toBe("Food");
    expect(labels.dining).toBe("Dining");
  });

  it("Data holds the workbook import; Privacy the privacy words", () => {
    open("/settings?tab=data");
    expect(within(screen.getByTestId("panel-workbook-import")).getByLabelText("Upload workbook")).toBeTruthy();
    cleanup();
    open("/settings?tab=privacy");
    expect(screen.getByTestId("panel-privacy").textContent).toContain("Plaid brokers the bank connection.");
  });

  it("the three fold-in tabs load their own chunks", async () => {
    open("/settings?tab=automation");
    expect(await screen.findByTestId("stub-automation")).toBeTruthy();
    cleanup();
    open("/settings?tab=morning-text");
    expect(await screen.findByTestId("stub-morning-text")).toBeTruthy();
    cleanup();
    open("/settings?tab=ai");
    expect(await screen.findByTestId("stub-ai-cost")).toBeTruthy();
  });

  it("an unknown tab is Banks, never a blank page", () => {
    open("/settings?tab=wat");
    expect(screen.getByTestId("panel-banks")).toBeTruthy();
  });

  it("a tab change keeps the page mounted: an unsaved allowance edit survives a look at Banks", () => {
    open("/settings?tab=household");
    fireEvent.change(screen.getByLabelText("Weekly allowance"), { target: { value: "125" } });
    act(() => {
      fireEvent.click(screen.getByTestId("settings-tab-link-banks"));
    });
    expect(screen.getByTestId("panel-banks")).toBeTruthy();
    expect(window.location.search).toBe("");
    act(() => {
      fireEvent.click(screen.getByTestId("settings-tab-link-household"));
    });
    expect(window.location.search).toBe("?tab=household");
    expect((screen.getByLabelText("Weekly allowance") as HTMLInputElement).value).toBe("125");
  });
});
