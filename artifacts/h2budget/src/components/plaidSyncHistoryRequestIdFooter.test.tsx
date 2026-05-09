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

const dispatchPlaidReconnectMock = vi.fn();
vi.mock("@/components/plaid-reconnect-listener", () => ({
  dispatchPlaidReconnect: (...args: unknown[]) =>
    dispatchPlaidReconnectMock(...args),
}));

import { PlaidSyncHistory } from "./plaid-sync-history";

function makeAttempt(overrides: Partial<PlaidSyncAttempt> & { id: string }): PlaidSyncAttempt {
  return {
    attemptedAt: "2026-05-01T12:00:00.000Z",
    kind: "transactions",
    success: false,
    errorCode: "ITEM_LOGIN_REQUIRED",
    errorMessage: "the login details of this item have changed",
    plaidDisplayMessage:
      "The login details for this account have changed. Please update them to continue.",
    requestId: "req_abc123XYZ",
    httpStatus: 400,
    errorKind: "reauth",
    ...overrides,
  } as PlaidSyncAttempt;
}

function renderHistory() {
  const qc = new QueryClient();
  const ui = render(
    <QueryClientProvider client={qc}>
      <PlaidSyncHistory itemId="item-1" institutionName="Chase" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId("button-toggle-sync-history-item-1"));
  return ui;
}

beforeEach(() => {
  cleanup();
  dispatchPlaidReconnectMock.mockReset();
  mockAttempts = [];
});

describe("(#359) PlaidSyncHistory failed-attempt detail + request-id footer", () => {
  it("renders the Plaid display message as the primary detail line", () => {
    const attempt = makeAttempt({ id: "att-1" });
    mockAttempts = [attempt];
    renderHistory();

    const detail = screen.getByTestId(`sync-attempt-detail-${attempt.id}`);
    expect(detail.textContent).toBe(attempt.plaidDisplayMessage);
    // The raw error_message must NOT be what the user sees as the primary
    // line — display_message is the support-friendly copy.
    expect(detail.textContent).not.toContain(attempt.errorMessage!);
  });

  it("shows both 'HTTP <status>' and 'Request id: <id>' in the meta footer", () => {
    const attempt = makeAttempt({ id: "att-2" });
    mockAttempts = [attempt];
    renderHistory();

    const meta = screen.getByTestId(`sync-attempt-meta-${attempt.id}`);
    expect(meta.textContent).toContain("HTTP 400");
    expect(meta.textContent).toContain("Request id: req_abc123XYZ");
    // The two pieces are separated by a middot so support can scan the row.
    expect(meta.textContent).toContain("·");
  });

  it("renders a Reconnect button when errorKind === 'reauth' and dispatches with the item info", () => {
    const attempt = makeAttempt({ id: "att-3" });
    mockAttempts = [attempt];
    renderHistory();

    const reconnect = screen.getByTestId(`sync-attempt-reconnect-${attempt.id}`);
    expect(reconnect).toBeTruthy();
    fireEvent.click(reconnect);
    expect(dispatchPlaidReconnectMock).toHaveBeenCalledWith({
      itemId: "item-1",
      institutionName: "Chase",
    });
  });

  it("falls back to error_message in the detail line when display_message is missing, and still shows the footer", () => {
    const attempt = makeAttempt({
      id: "att-4",
      plaidDisplayMessage: null,
    });
    mockAttempts = [attempt];
    renderHistory();

    const detail = screen.getByTestId(`sync-attempt-detail-${attempt.id}`);
    expect(detail.textContent).toBe(attempt.errorMessage);

    const meta = screen.getByTestId(`sync-attempt-meta-${attempt.id}`);
    expect(meta.textContent).toContain("HTTP 400");
    expect(meta.textContent).toContain("Request id: req_abc123XYZ");
  });

  it("omits the Reconnect button for non-reauth failures (e.g. rate_limit)", () => {
    const attempt = makeAttempt({
      id: "att-5",
      errorCode: "RATE_LIMIT_EXCEEDED",
      errorKind: "rate_limit",
    });
    mockAttempts = [attempt];
    renderHistory();

    expect(
      screen.queryByTestId(`sync-attempt-reconnect-${attempt.id}`),
    ).toBeNull();
    // The footer is still useful for triage even without Reconnect.
    const meta = screen.getByTestId(`sync-attempt-meta-${attempt.id}`);
    expect(meta.textContent).toContain("Request id: req_abc123XYZ");
  });

  it("only renders 'Request id: …' (no HTTP segment) when httpStatus is null", () => {
    const attempt = makeAttempt({ id: "att-6", httpStatus: null });
    mockAttempts = [attempt];
    renderHistory();

    const meta = screen.getByTestId(`sync-attempt-meta-${attempt.id}`);
    expect(meta.textContent).toContain("Request id: req_abc123XYZ");
    expect(meta.textContent).not.toContain("HTTP");
    // No leading separator when only one piece is present.
    expect(meta.textContent?.trim().startsWith("·")).toBe(false);
  });
});
