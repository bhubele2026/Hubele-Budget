import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

/**
 * "Why this number?" on Banking's bank balance.
 *
 * Pinned: nothing is fetched until the popover opens; every line is the
 * server's; the snapshot and the rows since it are never presented as adding up
 * to the displayed balance unless they do, to the cent; and loading and failure
 * say so.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;

const state = vi.hoisted(() => ({
  calls: [] as Array<{ query?: { enabled?: boolean } }>,
  result: { data: undefined } as Record<string, unknown>,
  refetch: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetForecastBankBalanceExplain: (opts: { query?: { enabled?: boolean } }) => {
    state.calls.push(opts);
    return { refetch: state.refetch, ...state.result };
  },
  getGetForecastBankBalanceExplainQueryKey: () => ["/api/forecast/bank-balance-explain"],
}));

import { BankBalanceWhy } from "./bank-balance-why";

function explain(over: Record<string, unknown> = {}) {
  return {
    asOf: "2026-09-11T17:00:00.000Z",
    displayed: { bankToday: "1960.00" },
    freshness: {
      source: "plaid",
      lastContactAt: "2026-09-11T15:00:00.000Z",
      lastFailureAt: null,
      stale: false,
      staleReason: null,
    },
    snapshot: {
      balance: "2000.00",
      at: "2026-09-10T14:00:00.000Z",
      source: "plaid",
      storedAccountId: "acct-1",
      name: "Checking",
      mask: "1111",
    },
    account: {
      resolvedExternalId: "ext-1",
      resolvedRowId: "row-1",
      via: "pointer",
      name: "Checking",
      mask: "1111",
      belongsToItem: "item-1",
    },
    nextSync: { willRefreshBalance: true, whyNot: null },
    items: [],
    accounts: [],
    ledger: {
      anchorDay: "2026-09-10",
      sinceAnchor: { rowCount: 2, net: "-40.00" },
      recentRows: [],
    },
    ...over,
  };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "Why this number?" }));
const lastEnabled = () => state.calls[state.calls.length - 1]?.query?.enabled;

beforeEach(() => {
  state.calls = [];
  state.result = { data: undefined };
  state.refetch.mockReset();
});
afterEach(() => cleanup());

describe("Why this number? — fetched only when asked", () => {
  it("asks for nothing while closed", () => {
    render(<BankBalanceWhy />);
    expect(lastEnabled()).toBe(false);
    expect(screen.queryByTestId("bank-why")).toBeNull();
  });

  it("asks once it opens, and says it is loading", () => {
    render(<BankBalanceWhy />);
    open();
    expect(lastEnabled()).toBe(true);
    expect(screen.getByTestId("bank-why").textContent).toContain("Loading…");
  });

  it("after a failed load, says so and offers a Retry that retries", () => {
    state.result = { data: undefined, isLoadingError: true };
    render(<BankBalanceWhy />);
    open();
    expect(screen.getByTestId("bank-why").textContent).toContain("Couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("Why this number? — the server's lines", () => {
  it("shows the displayed balance, the snapshot and the rows since, and says the next Sync re-reads it", () => {
    state.result = { data: explain() };
    render(<BankBalanceWhy />);
    open();
    expect(screen.getByTestId("bank-why-displayed").textContent).toBe("$1,960.00");
    const snap = screen.getByTestId("bank-why-snapshot").textContent ?? "";
    expect(snap).toContain("$2,000.00");
    expect(snap).toContain("Plaid · Checking · ••1111");
    const since = screen.getByTestId("bank-why-since").textContent ?? "";
    expect(since).toContain("2 rows since then");
    expect(since).toContain("-$40.00");
    expect(screen.getByTestId("bank-why-next-sync").textContent).toContain(
      "The next Sync re-reads this balance",
    );
    expect(screen.getByTestId("text-bank-snapshot-freshness")).toBeTruthy();
  });

  it("adds no note when the snapshot and the rows since add up to the balance, to the cent", () => {
    state.result = { data: explain() };
    render(<BankBalanceWhy />);
    open();
    expect(screen.queryByTestId("bank-why-mismatch")).toBeNull();
  });

  it("says the lines are counted differently when they don't add up, never an equation", () => {
    state.result = {
      data: explain({ displayed: { bankToday: "1925.10" } }),
    };
    render(<BankBalanceWhy />);
    open();
    expect(screen.getByTestId("bank-why-mismatch").textContent).toContain("different rules");
    expect(screen.getByTestId("bank-why").textContent).not.toContain("=");
  });

  it("gives the server's reason when the next Sync won't re-read the balance", () => {
    state.result = {
      data: explain({
        nextSync: {
          willRefreshBalance: false,
          whyNot: "the resolved account is no longer on file for this household",
        },
      }),
    };
    render(<BankBalanceWhy />);
    open();
    expect(screen.getByTestId("bank-why-next-sync").textContent).toBe(
      "The next Sync won't re-read it: the resolved account is no longer on file for this household.",
    );
  });

  it("with no snapshot, says the forecast runs off the starting balance", () => {
    state.result = {
      data: explain({
        snapshot: {
          balance: null,
          at: null,
          source: null,
          storedAccountId: null,
          name: null,
          mask: null,
        },
        ledger: { anchorDay: null, sinceAnchor: null, recentRows: [] },
      }),
    };
    render(<BankBalanceWhy />);
    open();
    expect(screen.getByTestId("bank-why-no-snapshot").textContent).toContain(
      "runs off the starting balance",
    );
    expect(screen.queryByTestId("bank-why-snapshot")).toBeNull();
    expect(screen.queryByTestId("bank-why-mismatch")).toBeNull();
  });

  it("shows a stale verdict in words when the server judges the balance stale", () => {
    state.result = {
      data: explain({
        freshness: {
          source: "plaid",
          lastContactAt: "2026-09-10T14:00:00.000Z",
          lastFailureAt: "2026-09-11T16:00:00.000Z",
          stale: true,
          staleReason: "refresh_failed",
        },
      }),
    };
    render(<BankBalanceWhy />);
    open();
    expect(screen.getByTestId("text-bank-freshness-stale").textContent).toContain("Refresh failed");
  });
});
