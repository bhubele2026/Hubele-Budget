import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { formatRelativeTime } from "@/lib/utils";

/**
 * "Why this number?" on Banking's bank balance.
 *
 * Pinned:
 * - nothing is fetched until the popover opens, and it is always asked afresh;
 * - it never shows an older explanation as current (refreshing reads "Loading…",
 *   a failed refresh keeps the last answer under a banner);
 * - every line is the server's, including the snapshot's household day;
 * - the lines are never presented as adding up unless they do, to the cent,
 *   including when the rows figure is absent;
 * - loading and failure say so.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;

const state = vi.hoisted(() => ({
  calls: [] as Array<{ query?: { enabled?: boolean; staleTime?: number } }>,
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

const NOW = new Date("2026-09-11T17:00:00.000Z");

function explain(over: Record<string, unknown> = {}) {
  return {
    asOf: NOW.toISOString(),
    displayed: { bankToday: "1960.00" },
    freshness: {
      source: "plaid",
      lastContactAt: null,
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
const lastQuery = () => state.calls[state.calls.length - 1]?.query;
const popoverText = () => screen.getByTestId("bank-why").textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.calls = [];
  state.result = { data: undefined };
  state.refetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Why this number? — fetched only when asked, never older than the tile", () => {
  it("asks for nothing while closed", () => {
    render(<BankBalanceWhy />);
    expect(lastQuery()?.enabled).toBe(false);
    expect(screen.queryByTestId("bank-why")).toBeNull();
  });

  it("asks afresh once it opens, and says it is loading", () => {
    render(<BankBalanceWhy />);
    open();
    expect(lastQuery()?.enabled).toBe(true);
    expect(lastQuery()?.staleTime).toBe(0);
    expect(popoverText()).toContain("Loading…");
  });

  it("while a newer answer is on its way, says Loading… rather than showing the older one", () => {
    state.result = { data: explain(), isFetching: true };
    render(<BankBalanceWhy />);
    open();
    expect(popoverText()).toContain("Loading…");
    expect(screen.queryByTestId("bank-why-displayed")).toBeNull();
  });

  it("after a failed refresh, keeps the last answer under a banner that says so", () => {
    state.result = {
      data: explain(),
      isRefetchError: true,
      dataUpdatedAt: NOW.getTime() - 5 * 60 * 1000,
    };
    render(<BankBalanceWhy />);
    open();
    expect(screen.getByTestId("bank-why-refresh-banner").textContent).toContain("Couldn't refresh");
    expect(screen.getByTestId("bank-why-displayed").textContent).toBe("$1,960.00");
  });

  it("after a failed load, says so and offers a Retry that retries", () => {
    state.result = { data: undefined, isLoadingError: true };
    render(<BankBalanceWhy />);
    open();
    expect(popoverText()).toContain("Couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("Why this number? — the server's lines", () => {
  it("shows the balance, the snapshot and the rows since, with the next Sync's attempt", () => {
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
    expect(screen.getByTestId("bank-why-next-sync").textContent).toBe(
      "The next Sync asks the bank for this balance.",
    );
  });

  it("dates the snapshot with the server's household day, not a UTC slice", () => {
    // 02:30Z on the 11th is 21:30 on the 10th in Chicago.
    state.result = {
      data: explain({
        snapshot: { ...explain().snapshot, at: "2026-09-11T02:30:00.000Z" },
        ledger: { ...explain().ledger, anchorDay: "2026-09-10" },
      }),
    };
    render(<BankBalanceWhy />);
    open();
    const snap = screen.getByTestId("bank-why-snapshot").textContent ?? "";
    expect(snap).toContain("Sep 10, 2026");
    expect(snap).not.toContain("Sep 11");
  });

  it("dates the freshness line from the snapshot, not from when the answer was made", () => {
    state.result = { data: explain() };
    render(<BankBalanceWhy />);
    open();
    const fromSnapshot = formatRelativeTime("2026-09-10T14:00:00.000Z", NOW);
    expect(fromSnapshot).not.toBe(formatRelativeTime(NOW.toISOString(), NOW));
    expect(screen.getByTestId("text-bank-snapshot-freshness").textContent).toContain(fromSnapshot);
  });

  it("adds no note, and no equation, when the lines add up to the cent (even 0.10 + 0.20 = 0.30)", () => {
    state.result = {
      data: explain({
        displayed: { bankToday: "0.30" },
        snapshot: { ...explain().snapshot, balance: "0.10" },
        ledger: { ...explain().ledger, sinceAnchor: { rowCount: 1, net: "0.20" } },
      }),
    };
    render(<BankBalanceWhy />);
    open();
    expect(screen.queryByTestId("bank-why-mismatch")).toBeNull();
    expect(popoverText()).not.toContain("=");
  });

  it("says the lines don't add up when they don't, still with no equation", () => {
    // (PR4e) Both lines follow one rule now, so the note names no cause.
    state.result = { data: explain({ displayed: { bankToday: "1925.10" } }) };
    render(<BankBalanceWhy />);
    open();
    expect(screen.getByTestId("bank-why-mismatch").textContent).toContain("do not add up to the cent");
    expect(screen.getByTestId("bank-why-mismatch").textContent).not.toContain("different rules");
    expect(popoverText()).not.toContain("=");
  });

  it("with no rows figure (unresolved account), still says so when the snapshot and balance differ", () => {
    state.result = {
      data: explain({ ledger: { anchorDay: "2026-09-10", sinceAnchor: null, recentRows: [] } }),
    };
    render(<BankBalanceWhy />);
    open();
    expect(screen.queryByTestId("bank-why-since")).toBeNull();
    expect(screen.getByTestId("bank-why-mismatch")).toBeTruthy();
  });

  it("with no rows figure and a snapshot equal to the balance, adds no note", () => {
    state.result = {
      data: explain({
        displayed: { bankToday: "2000.00" },
        ledger: { anchorDay: "2026-09-10", sinceAnchor: null, recentRows: [] },
      }),
    };
    render(<BankBalanceWhy />);
    open();
    expect(screen.queryByTestId("bank-why-mismatch")).toBeNull();
  });

  it("gives the server's reason when the next Sync won't ask the bank", () => {
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
      "The next Sync won't ask the bank for it: the resolved account is no longer on file for this household.",
    );
  });

  it("with no snapshot, says the forecast runs off the starting balance, and nothing about the next Sync", () => {
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
        nextSync: {
          willRefreshBalance: false,
          whyNot: "no bank snapshot is set, so there is no anchor to refresh",
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
    expect(screen.queryByTestId("bank-why-next-sync")).toBeNull();
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
