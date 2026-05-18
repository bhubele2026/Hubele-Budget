import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import React from "react";
import type { SyncTotals } from "@/hooks/use-plaid-sync";

const ZERO_TOTALS: SyncTotals = {
  added: 0,
  modified: 0,
  removed: 0,
  errors: [],
  errorDetails: [],
  stillPreparing: false,
  ruleAttribution: { totalAttributed: 0, top: [], extraRules: 0, ruleIds: [] },
  importedDateRange: null,
  lastOccurredOn: null,
};

// Same backoff schedule baked into PlaidLinkButton.pollAfterLink — we
// need to advance the fake timer queue by these exact deltas to drive
// the panel through preparing → polling → ready/error/still-preparing.
const POLL_DELAYS_MS = [
  3_000, 4_000, 6_000, 8_000, 10_000, 12_000, 15_000, 15_000, 18_000,
];

let runSyncQueue: Array<Partial<SyncTotals>> = [];
const runSyncMock = vi.fn(async (): Promise<SyncTotals> => {
  const next = runSyncQueue.shift() ?? {};
  return { ...ZERO_TOTALS, ...next };
});

let capturedOnSuccess:
  | ((token: string, meta: { institution?: { institution_id?: string; name?: string } | null }) => void)
  | null = null;

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-plaid-sync", () => ({
  usePlaidSync: () => ({ runSync: runSyncMock, isPending: false }),
}));

vi.mock("react-plaid-link", () => ({
  usePlaidLink: (config: { onSuccess: typeof capturedOnSuccess }) => {
    capturedOnSuccess = config.onSuccess;
    return { open: vi.fn(), ready: false };
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  // (#706/#710) plaid-link-button reads /plaid/items to gate the
  // fresh-link guard dialog. Default to an empty list so the existing
  // post-link-progress tests below don't trip the guard.
  useListPlaidItems: () => ({ data: [], isFetched: true }),
  useCreatePlaidLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  useExchangePlaidPublicToken: () => ({
    mutate: (
      _vars: unknown,
      opts: { onSuccess?: (r: { id: string }) => void },
    ) => opts.onSuccess?.({ id: "item-1" }),
    isPending: false,
  }),
  useGetPlaidEnvironment: () => ({ data: { configured: true } }),
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
  getListPlaidLiabilityAccountsQueryKey: () => [
    "/api/plaid/liability-accounts",
  ],
  listPlaidLiabilityAccounts: vi.fn(async () => []),
  listPlaidItems: vi.fn(async () => []),
}));

import { PlaidLinkButton } from "./plaid-link-button";

function renderButton() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router base="">
        <PlaidLinkButton />
      </Router>
    </QueryClientProvider>,
  );
}

async function triggerLink() {
  await act(async () => {
    capturedOnSuccess?.("public-token", {
      institution: { institution_id: "ins_1", name: "Chase" },
    });
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  runSyncMock.mockClear();
  runSyncQueue = [];
  capturedOnSuccess = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PlaidLinkButton post-link progress panel", () => {
  it("transitions preparing → polling → ready as data arrives", async () => {
    runSyncQueue = [
      {}, // first poll: nothing yet
      {
        added: 5,
        modified: 2,
        lastOccurredOn: "2026-04-15",
        importedDateRange: { min: "2026-01-01", max: "2026-04-15" },
      },
    ];
    renderButton();
    await triggerLink();

    // Panel mounts immediately in the "preparing" phase.
    const panel = screen.getByTestId("panel-post-link-progress");
    expect(panel.getAttribute("data-phase")).toBe("preparing");
    expect(screen.getByTestId("text-post-link-title").textContent).toContain(
      "Linked Chase",
    );
    expect(screen.getByTestId("text-post-link-detail").textContent).toMatch(
      /Preparing/i,
    );
    expect(screen.getByTestId("progress-post-link")).toBeTruthy();

    // First poll fires after POLL_DELAYS_MS[0]; runSync returns zero rows
    // so the panel advances to polling with the attempt count visible.
    await advance(POLL_DELAYS_MS[0]);
    expect(
      screen.getByTestId("panel-post-link-progress").getAttribute("data-phase"),
    ).toBe("polling");
    expect(screen.getByTestId("text-post-link-title").textContent).toMatch(
      /Pulling transactions from Chase/,
    );
    expect(screen.getByTestId("text-post-link-detail").textContent).toMatch(
      /attempt 1 of 9/,
    );
    expect(screen.getByTestId("progress-post-link")).toBeTruthy();

    // Second poll: rows land — phase flips to ready with added/modified counts.
    await advance(POLL_DELAYS_MS[1]);
    expect(
      screen.getByTestId("panel-post-link-progress").getAttribute("data-phase"),
    ).toBe("ready");
    expect(screen.getByTestId("text-post-link-title").textContent).toMatch(
      /Ready — 5 added, 2 updated/,
    );
    // Progress bar disappears once we're ready.
    expect(screen.queryByTestId("progress-post-link")).toBeNull();
  });

  it("ends in still-preparing after every poll comes back empty", async () => {
    runSyncQueue = Array.from({ length: POLL_DELAYS_MS.length }, () => ({}));
    renderButton();
    await triggerLink();

    expect(
      screen.getByTestId("panel-post-link-progress").getAttribute("data-phase"),
    ).toBe("preparing");

    const total = POLL_DELAYS_MS.reduce((a, b) => a + b, 0);
    await advance(total);

    expect(
      screen.getByTestId("panel-post-link-progress").getAttribute("data-phase"),
    ).toBe("still-preparing");
    expect(screen.getByTestId("text-post-link-title").textContent).toMatch(
      /Still preparing/,
    );
    expect(runSyncMock).toHaveBeenCalledTimes(POLL_DELAYS_MS.length);
  });

  it("surfaces a per-bank error with a Plaid: prefix", async () => {
    runSyncQueue = [
      { errors: ["the login details of this item have changed"] },
    ];
    renderButton();
    await triggerLink();

    await advance(POLL_DELAYS_MS[0]);

    expect(
      screen.getByTestId("panel-post-link-progress").getAttribute("data-phase"),
    ).toBe("error");
    expect(screen.getByTestId("text-post-link-title").textContent).toMatch(
      /Sync had errors/,
    );
    expect(screen.getByTestId("text-post-link-detail").textContent).toMatch(
      /Plaid: the login details of this item have changed/,
    );
    // Hard error stops polling early — only the first attempt fired.
    expect(runSyncMock).toHaveBeenCalledTimes(1);
  });

  it("hides the panel when the dismiss button is clicked", async () => {
    runSyncQueue = [{ errors: ["boom"] }];
    renderButton();
    await triggerLink();
    await advance(POLL_DELAYS_MS[0]);

    const dismiss = screen.getByTestId("button-post-link-dismiss");
    await act(async () => {
      fireEvent.click(dismiss);
    });

    expect(screen.queryByTestId("panel-post-link-progress")).toBeNull();
  });
});
