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
  itemId?: string | null;
  plaidItemRowId?: string | null;
  institutionName?: string | null;
  plaidErrorCode?: string | null;
  plaidErrorMessage?: string | null;
  plaidDisplayMessage?: string | null;
  requestId?: string | null;
  httpStatus?: number | null;
  kind?:
    | "reauth"
    | "rate_limit"
    | "institution_down"
    | "transient"
    | "unknown"
    | null;
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

// (#357) The Reconnect ToastAction now dispatches a window event instead of
// navigating to /settings. Mock the listener module so we can spy on it.
const dispatchPlaidReconnectMock = vi.fn();
vi.mock("@/components/plaid-reconnect-listener", () => ({
  dispatchPlaidReconnect: (
    detail: { itemId: string; institutionName?: string | null },
  ) => dispatchPlaidReconnectMock(detail),
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
  dispatchPlaidReconnectMock.mockClear();
  syncResponse = { items: [] };
});

describe("usePlaidSync — empty-fleet toast", () => {
  it("shows 'No banks connected' with an Open Settings CTA when the response has zero items", async () => {
    // (#671 follow-up) Reproduces the real bug the user hit: their
    // household had 0 linked Plaid items but 95 leftover transactions
    // from a previously-deleted item. The old code fell through to
    // "Your bank is still preparing the initial batch" — a lie, since
    // no Plaid call was even made. Verify the new branch wins and
    // surfaces an actionable CTA.
    syncResponse = { items: [] };
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalled();
    });
    const arg = toastFn.mock.calls[0][0] as {
      title: string;
      description: string;
      action?: React.ReactElement;
    };
    expect(arg.title).toBe("No banks connected");
    expect(arg.description).toContain("Connect a bank in Settings");
    expect(arg.description).not.toContain("still preparing");
    expect(arg.action).toBeTruthy();
    const { getByTestId, unmount } = render(arg.action as React.ReactElement);
    fireEvent.click(getByTestId("button-toast-open-settings"));
    expect(navigateFn).toHaveBeenCalledWith("/settings");
    unmount();
  });
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

// (#357) — Surface real Plaid errors instead of bare axios strings.
describe("usePlaidSync — #357 institution-named error toast", () => {
  it("composes '<Institution>: <displayMessage>' and adds a Reconnect ToastAction for kind=reauth", async () => {
    syncResponse = {
      items: [
        {
          added: 0,
          modified: 0,
          removed: 0,
          error: "the login details of this item have changed",
          itemId: "item-chase-1",
          plaidItemRowId: "row-chase-1",
          institutionName: "Chase",
          plaidErrorCode: "ITEM_LOGIN_REQUIRED",
          plaidErrorMessage: "the login details of this item have changed",
          plaidDisplayMessage:
            "Please reconnect your account to continue syncing.",
          requestId: "req-abc",
          httpStatus: 400,
          kind: "reauth",
        },
      ],
    };
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => expect(toastFn).toHaveBeenCalled());
    const arg = toastFn.mock.calls[0][0] as {
      title: string;
      description: string;
      variant?: string;
      action?: React.ReactElement;
    };
    expect(arg.title).toBe("Sync had errors");
    expect(arg.variant).toBe("destructive");
    // Institution prefix + Plaid's display_message — never the raw axios
    // "Request failed with status code 400" string.
    expect(arg.description).toBe(
      "Chase: Please reconnect your account to continue syncing.",
    );
    expect(arg.description).not.toMatch(/status code 400/i);
    expect(arg.action).toBeDefined();
    render(<>{arg.action}</>);
    fireEvent.click(screen.getByTestId("button-toast-plaid-reconnect"));
    // (#357) Reconnect must open Plaid Link in update mode for the
    // failing item — never navigate to /settings.
    expect(navigateFn).not.toHaveBeenCalledWith("/settings");
    expect(dispatchPlaidReconnectMock).toHaveBeenCalledWith({
      itemId: "row-chase-1",
      institutionName: "Chase",
    });
  });

  it("falls back to plaidErrorMessage when displayMessage is absent and omits Reconnect for non-reauth kinds", async () => {
    syncResponse = {
      items: [
        {
          added: 0,
          modified: 0,
          removed: 0,
          error: "rate limit exceeded",
          itemId: "item-amex-1",
          institutionName: "American Express",
          plaidErrorCode: "RATE_LIMIT_EXCEEDED",
          plaidErrorMessage: "rate limit exceeded",
          plaidDisplayMessage: null,
          requestId: "req-xyz",
          httpStatus: 429,
          kind: "rate_limit",
        },
      ],
    };
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => expect(toastFn).toHaveBeenCalled());
    const arg = toastFn.mock.calls[0][0] as {
      description: string;
      action?: React.ReactElement;
    };
    expect(arg.description).toBe("American Express: rate limit exceeded");
    expect(arg.action).toBeUndefined();
  });

  it("uses a friendly description (not axios internals) when the request itself fails", async () => {
    // Force the mutate to invoke onError instead of onSuccess so we
    // exercise the network-failure branch.
    mutateMock.mockImplementationOnce(
      ((
        _vars: { data: { itemId?: string } },
        opts: { onError?: (e: Error) => void },
      ) => {
        opts.onError?.(new Error("Request failed with status code 400"));
      }) as never,
    );
    renderHarness();
    fireEvent.click(screen.getByTestId("run-sync"));
    await waitFor(() => expect(toastFn).toHaveBeenCalled());
    const arg = toastFn.mock.calls[0][0] as {
      title: string;
      description: string;
      variant?: string;
    };
    expect(arg.title).toBe("Sync failed");
    expect(arg.variant).toBe("destructive");
    expect(arg.description).not.toMatch(/status code 400/i);
    expect(arg.description).toMatch(/couldn't reach the server/i);
  });
});
