import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
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

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { PlaidSyncHistory } from "./plaid-sync-history";

function makeAttempt(
  overrides: Partial<PlaidSyncAttempt> & { id: string },
): PlaidSyncAttempt {
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
  toastMock.mockReset();
  mockAttempts = [];
});

describe("(#394) PlaidSyncHistory request-id copy button", () => {
  it("copies the raw request id to the clipboard when clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const attempt = makeAttempt({ id: "att-copy-1" });
    mockAttempts = [attempt];
    renderHistory();

    const btn = screen.getByTestId(
      `sync-attempt-copy-request-id-${attempt.id}`,
    );
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("req_abc123XYZ");
    // The "Request id:" label must NOT be part of what's copied.
    expect(writeText.mock.calls[0][0]).not.toContain("Request id");
  });

  it("shows an inline 'Copied' confirmation and fires a toast after a successful copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const attempt = makeAttempt({ id: "att-copy-2" });
    mockAttempts = [attempt];
    renderHistory();

    const btn = screen.getByTestId(
      `sync-attempt-copy-request-id-${attempt.id}`,
    );
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(btn.textContent).toContain("Copied");
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Request id copied" }),
    );
  });

  it("does not render the copy button when there is no request id", () => {
    const attempt = makeAttempt({ id: "att-copy-3", requestId: null });
    mockAttempts = [attempt];
    renderHistory();

    expect(
      screen.queryByTestId(`sync-attempt-copy-request-id-${attempt.id}`),
    ).toBeNull();
  });
});
