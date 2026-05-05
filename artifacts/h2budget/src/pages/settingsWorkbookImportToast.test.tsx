import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

type RuleAttr = { ruleId: string; pattern: string; count: number };
type ImportResponse = {
  counts: Record<string, number>;
  ruleAttributions?: RuleAttr[];
};

let importResponse: ImportResponse = { counts: { transactions: 0 } };
const toastFn = vi.fn();
const navigateFn = vi.fn();
const importMutate = vi.fn(
  (
    _vars: { data: { file: File } },
    opts: { onSuccess?: (r: ImportResponse) => void },
  ) => {
    opts.onSuccess?.(importResponse);
  },
);

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastFn }) }));
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

vi.mock("wouter", () => ({
  useLocation: () => ["/settings", navigateFn] as const,
}));

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
  return {
    useGetSettings: () => ({ data: SETTINGS, isLoading: false }),
    useUpdateSettings: () => mutation,
    useImportWorkbook: () => ({ mutate: importMutate, isPending: false }),
    useListPlaidItems: () => ({ data: [] }),
    useDeletePlaidItem: () => mutation,
    useSyncPlaidTransactions: () => mutation,
    useGetPlaidEnvironment: () => ({
      data: {
        env: "production",
        configured: true,
        nonProdItemCount: 0,
        nonProdItems: [] as unknown[],
      },
    }),
    useCleanupNonProdPlaidItems: () => mutation,
    useRefreshPlaidConsentExpirations: () => mutation,
    useListCategories: () => ({ data: [] }),
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

function uploadWorkbook() {
  // The Upload .xlsx button has a hidden <input type="file"> sibling.
  // Grab it directly off the document since there's no testid on it.
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  if (!input) throw new Error("file input not found");
  const file = new File(["x"], "budget.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  cleanup();
  toastFn.mockClear();
  navigateFn.mockClear();
  importMutate.mockClear();
  importResponse = { counts: { transactions: 0 } };
});

describe("Settings — workbook-import rule-attribution toast", () => {
  it("includes the per-rule attribution line in the Import complete toast", async () => {
    importResponse = {
      counts: { transactions: 100 },
      ruleAttributions: [
        { ruleId: "rule-1", pattern: "STARBUCKS", count: 7 },
        { ruleId: "rule-2", pattern: "AMAZON", count: 3 },
      ],
    };
    renderPage();
    uploadWorkbook();

    await waitFor(() => {
      // The first toast is "Importing workbook..."; we want the success one.
      const completeCalls = toastFn.mock.calls.filter(
        ([a]) => (a as { title: string }).title === "Import complete",
      );
      expect(completeCalls.length).toBe(1);
    });
    const completeArg = toastFn.mock.calls.find(
      ([a]) => (a as { title: string }).title === "Import complete",
    )![0] as { description: string; action?: React.ReactElement };
    expect(completeArg.description).toContain("Processed 100 transactions.");
    expect(completeArg.description).toContain(
      "Auto-categorized 10 transactions: 7 via 'STARBUCKS', 3 via 'AMAZON'.",
    );
  });

  it("renders a 'View' ToastAction whose click navigates to /mapping-rules?focus=<ids>", async () => {
    importResponse = {
      counts: { transactions: 50 },
      ruleAttributions: [
        { ruleId: "rule-a", pattern: "STARBUCKS", count: 4 },
        { ruleId: "rule-b", pattern: "AMAZON", count: 2 },
      ],
    };
    renderPage();
    uploadWorkbook();

    await waitFor(() => {
      expect(
        toastFn.mock.calls.some(
          ([a]) => (a as { title: string }).title === "Import complete",
        ),
      ).toBe(true);
    });
    const completeArg = toastFn.mock.calls.find(
      ([a]) => (a as { title: string }).title === "Import complete",
    )![0] as { action?: React.ReactElement };
    expect(completeArg.action).toBeTruthy();

    render(<>{completeArg.action}</>);
    fireEvent.click(screen.getByTestId("button-toast-view-import-matched-rules"));
    expect(navigateFn).toHaveBeenCalledTimes(1);
    expect(navigateFn).toHaveBeenCalledWith("/mapping-rules?focus=rule-a,rule-b");
  });

  it("omits the View ToastAction when the workbook produced no rule attributions", async () => {
    importResponse = {
      counts: { transactions: 5 },
      ruleAttributions: [],
    };
    renderPage();
    uploadWorkbook();

    await waitFor(() => {
      expect(
        toastFn.mock.calls.some(
          ([a]) => (a as { title: string }).title === "Import complete",
        ),
      ).toBe(true);
    });
    const completeArg = toastFn.mock.calls.find(
      ([a]) => (a as { title: string }).title === "Import complete",
    )![0] as { description: string; action?: React.ReactElement };
    expect(completeArg.action).toBeUndefined();
    expect(completeArg.description).not.toContain("Auto-categorized");
  });
});
