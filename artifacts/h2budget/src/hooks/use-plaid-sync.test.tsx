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
type SyncItem = {
  added: number;
  modified: number;
  removed: number;
  error: string | null;
  stillPreparing?: boolean;
  ruleAttributions?: RuleAttr[];
};

let syncResponse: { items: SyncItem[] } = { items: [] };
const toastFn = vi.fn();
const navigateFn = vi.fn();
const mutateMock = vi.fn(
  (
    _vars: { data: { itemId?: string } },
    opts: { onSuccess?: (r: { items: SyncItem[] }) => void },
  ) => {
    opts.onSuccess?.(syncResponse);
  },
);

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastFn }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/", navigateFn] as const,
}));

vi.mock("@workspace/api-client-react", () => ({
  useSyncPlaidTransactions: () => ({ mutate: mutateMock, isPending: false }),
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

import { usePlaidSync } from "./use-plaid-sync";

function Harness() {
  const { runSync } = usePlaidSync();
  return (
    <button data-testid="run-sync" onClick={() => void runSync()}>
      Sync
    </button>
  );
}

function renderHarness() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  toastFn.mockClear();
  navigateFn.mockClear();
  mutateMock.mockClear();
  syncResponse = { items: [] };
});

describe("usePlaidSync — rule-attribution toast", () => {
  it("includes the per-rule attribution line in the success toast description", async () => {
    syncResponse = {
      items: [
        {
          added: 5,
          modified: 0,
          removed: 0,
          error: null,
          ruleAttributions: [
            { ruleId: "rule-1", pattern: "STARBUCKS", count: 3 },
            { ruleId: "rule-2", pattern: "AMAZON", count: 2 },
          ],
        },
      ],
    };
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalled();
    });
    const arg = toastFn.mock.calls[0][0] as {
      title: string;
      description: string;
    };
    expect(arg.title).toBe("Sync complete");
    expect(arg.description).toContain("Added 5");
    expect(arg.description).toContain(
      "Auto-categorized 5 new transactions: 3 via 'STARBUCKS', 2 via 'AMAZON'.",
    );
  });

  it("renders a 'View' ToastAction whose click navigates to /mapping-rules?focus=<ids>", async () => {
    syncResponse = {
      items: [
        {
          added: 4,
          modified: 0,
          removed: 0,
          error: null,
          ruleAttributions: [
            { ruleId: "rule-a", pattern: "STARBUCKS", count: 3 },
            { ruleId: "rule-b", pattern: "AMAZON", count: 1 },
          ],
        },
      ],
    };
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalled();
    });
    const arg = toastFn.mock.calls[0][0] as {
      action?: React.ReactElement;
    };
    expect(arg.action).toBeTruthy();
    // Mount the action element so we can fire a real click on the rendered
    // button. This proves both that the ToastAction is wired up and that
    // its onClick navigates to the deep link with all touched rule ids.
    render(<>{arg.action}</>);
    const viewBtn = screen.getByTestId("button-toast-view-matched-rules");
    fireEvent.click(viewBtn);
    expect(navigateFn).toHaveBeenCalledTimes(1);
    expect(navigateFn).toHaveBeenCalledWith("/mapping-rules?focus=rule-a,rule-b");
  });

  it("aggregates per-rule counts across multiple items so two banks sharing a rule collapse into one row", async () => {
    syncResponse = {
      items: [
        {
          added: 2,
          modified: 0,
          removed: 0,
          error: null,
          ruleAttributions: [
            { ruleId: "rule-shared", pattern: "STARBUCKS", count: 2 },
          ],
        },
        {
          added: 3,
          modified: 0,
          removed: 0,
          error: null,
          ruleAttributions: [
            { ruleId: "rule-shared", pattern: "STARBUCKS", count: 3 },
          ],
        },
      ],
    };
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalled();
    });
    const arg = toastFn.mock.calls[0][0] as { description: string };
    // 2+3 collapsed into one "5 via 'STARBUCKS'" row, NOT two separate rows.
    expect(arg.description).toContain(
      "Auto-categorized 5 new transactions: 5 via 'STARBUCKS'.",
    );
  });

  it("URL-encodes rule ids that contain reserved characters in the focus deep link", async () => {
    syncResponse = {
      items: [
        {
          added: 1,
          modified: 0,
          removed: 0,
          error: null,
          ruleAttributions: [
            { ruleId: "rule with space", pattern: "X", count: 1 },
          ],
        },
      ],
    };
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalled();
    });
    const arg = toastFn.mock.calls[0][0] as { action?: React.ReactElement };
    render(<>{arg.action}</>);
    fireEvent.click(screen.getByTestId("button-toast-view-matched-rules"));
    expect(navigateFn).toHaveBeenCalledWith(
      "/mapping-rules?focus=rule%20with%20space",
    );
  });

  it("omits the ToastAction when the sync produced no rule attributions", async () => {
    syncResponse = {
      items: [{ added: 2, modified: 0, removed: 0, error: null }],
    };
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalled();
    });
    const arg = toastFn.mock.calls[0][0] as {
      description: string;
      action?: React.ReactElement;
    };
    expect(arg.action).toBeUndefined();
    expect(arg.description).toBe("Added 2.");
  });
});
