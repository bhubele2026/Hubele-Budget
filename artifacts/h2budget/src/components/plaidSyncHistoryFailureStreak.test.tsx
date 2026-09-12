import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { PlaidSyncAttempt } from "@workspace/api-client-react";

/**
 * (PR-E review) A repeated failure is one row on the server. Recent activity
 * must still say how many times it failed and since when, and count every try.
 */

let mockAttempts: PlaidSyncAttempt[] = [];

vi.mock("@workspace/api-client-react", () => ({
  useListPlaidSyncAttempts: () => ({
    data: { attempts: mockAttempts },
    isLoading: false,
    isError: false,
  }),
  getListPlaidSyncAttemptsQueryKey: (id: string) => ["plaid-sync-attempts", id],
}));
vi.mock("@/components/plaid-reconnect-listener", () => ({
  dispatchPlaidReconnect: vi.fn(),
}));

import { PlaidSyncHistory } from "./plaid-sync-history";

function attempt(overrides: Partial<PlaidSyncAttempt> & { id: string }): PlaidSyncAttempt {
  return {
    attemptedAt: "2026-09-11T15:00:00.000Z",
    kind: "liabilities",
    success: false,
    errorCode: "INTERNAL_SERVER_ERROR",
    errorMessage: "bank down",
    plaidDisplayMessage: null,
    requestId: null,
    httpStatus: null,
    errorKind: null,
    cleanupDetails: null,
    failureCount: 1,
    firstFailedAt: "2026-09-11T15:00:00.000Z",
    ...overrides,
  } as PlaidSyncAttempt;
}

function renderHistory() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <PlaidSyncHistory itemId="item-1" institutionName="Chase" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId("button-toggle-sync-history-item-1"));
}

beforeEach(() => {
  cleanup();
  mockAttempts = [];
});

describe("PlaidSyncHistory — collapsed failure streaks (PR-E)", () => {
  it("shows how many times a row failed and when the streak began, in household (Chicago) time whatever the browser's zone", () => {
    // 09:00 UTC is 4:00 AM in Chicago on Sep 11.
    mockAttempts = [
      attempt({ id: "a1", failureCount: 7, firstFailedAt: "2026-09-11T09:00:00.000Z" }),
    ];
    renderHistory();
    const streak = screen.getByTestId("sync-attempt-streak-a1");
    expect(streak.textContent).toMatch(/^7 times · failing since Sep 11(, 2026)?, 4:00 AM$/);
  });

  it("says nothing extra for a failure that happened once", () => {
    mockAttempts = [attempt({ id: "a1" })];
    renderHistory();
    expect(screen.queryByTestId("sync-attempt-streak-a1")).toBeNull();
  });

  it("counts every try in the failure summary", () => {
    mockAttempts = [
      attempt({ id: "a1", failureCount: 7 }),
      attempt({
        id: "a2",
        kind: "transactions",
        success: true,
        errorCode: null,
        errorMessage: null,
        failureCount: null,
        firstFailedAt: null,
      }),
    ];
    renderHistory();
    expect(document.body.textContent).toContain("Failed 7 of the last 8");
  });
});
