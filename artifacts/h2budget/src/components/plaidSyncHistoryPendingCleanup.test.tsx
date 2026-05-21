import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { PlaidSyncAttempt } from "@workspace/api-client-react";

let mockAttempts: PlaidSyncAttempt[] = [];

vi.mock("@workspace/api-client-react", () => ({
  useListPlaidSyncAttempts: () => ({
    data: { attempts: mockAttempts },
    isLoading: false,
    isError: false,
  }),
  getListPlaidSyncAttemptsQueryKey: (id: string) => [
    "plaid-sync-attempts",
    id,
  ],
}));

vi.mock("@/components/plaid-reconnect-listener", () => ({
  dispatchPlaidReconnect: vi.fn(),
}));

import { PlaidSyncHistory } from "./plaid-sync-history";

function makeCleanupAttempt(): PlaidSyncAttempt {
  return {
    id: "att-cleanup-1",
    attemptedAt: "2026-05-20T12:00:00.000Z",
    kind: "pending_cleanup",
    success: true,
    errorCode: null,
    errorMessage:
      "Cleared 2 dropped pending charges from Amex Gold — totaling $42.18 (2026-05-15 – 2026-05-17).",
    plaidDisplayMessage: null,
    requestId: null,
    httpStatus: null,
    errorKind: null,
    cleanupDetails: {
      accountName: "Amex Gold",
      plaidAccountId: "acct-abc",
      count: 2,
      totalAmount: "-42.18",
      minOccurredOn: "2026-05-15",
      maxOccurredOn: "2026-05-17",
      items: [
        {
          description: "Metro pre-auth A",
          amount: "-12.34",
          occurredOn: "2026-05-15",
          plaidTransactionId: "plaid-vanish-a",
        },
        {
          description: "Metro pre-auth B",
          amount: "-29.84",
          occurredOn: "2026-05-17",
          plaidTransactionId: "plaid-vanish-b",
        },
      ],
    },
  } as PlaidSyncAttempt;
}

function renderHistory() {
  const qc = new QueryClient();
  const ui = render(
    <QueryClientProvider client={qc}>
      <PlaidSyncHistory itemId="item-1" institutionName="Amex" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId("button-toggle-sync-history-item-1"));
  return ui;
}

beforeEach(() => {
  cleanup();
  mockAttempts = [];
});

describe("(#733) PlaidSyncHistory pending_cleanup row", () => {
  it("shows the quiet summary line and a 'Tidied up' status instead of OK/Failed", () => {
    const attempt = makeCleanupAttempt();
    mockAttempts = [attempt];
    renderHistory();

    const summary = screen.getByTestId(
      `sync-attempt-cleanup-summary-${attempt.id}`,
    );
    expect(summary.textContent).toContain(
      "Cleared 2 dropped pending charges from Amex Gold",
    );
    expect(summary.textContent).toContain("$42.18");

    const status = screen.getByTestId(
      `sync-attempt-cleanup-status-${attempt.id}`,
    );
    expect(status.textContent).toBe("Tidied up");
    // Definitely not the generic green-OK badge — the audit row is a
    // distinct kind of "success".
    expect(screen.queryByText("OK")).toBeNull();
  });

  it("hides the per-deletion detail table by default and reveals it on 'View details' click", () => {
    const attempt = makeCleanupAttempt();
    mockAttempts = [attempt];
    renderHistory();

    expect(
      screen.queryByTestId(`sync-attempt-cleanup-details-${attempt.id}`),
    ).toBeNull();

    fireEvent.click(
      screen.getByTestId(`sync-attempt-cleanup-toggle-${attempt.id}`),
    );

    const details = screen.getByTestId(
      `sync-attempt-cleanup-details-${attempt.id}`,
    );
    // Each per-deletion row carries description / amount / occurredOn /
    // plaid_transaction_id verbatim so a power user can audit the sweep.
    expect(details.textContent).toContain("Metro pre-auth A");
    expect(details.textContent).toContain("-12.34");
    expect(details.textContent).toContain("2026-05-15");
    expect(details.textContent).toContain("plaid-vanish-a");
    expect(details.textContent).toContain("Metro pre-auth B");
    expect(details.textContent).toContain("plaid-vanish-b");
  });
});
