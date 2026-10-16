import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
  // (Task 4, D) The linked accounts, for the one route rule (`txnRoute`): a Chase checking ••1111.
  useListPlaidItems: () => ({
    data: [
      {
        id: "item-1", institutionName: "Chase", institutionSlug: "chase", lastSyncedAt: "2026-09-10T14:00:00.000Z", lastSyncError: null,
        accounts: [{ id: "row-1", accountId: "ext-1", name: "Checking", mask: "1111", type: "depository", subtype: "checking" }],
      },
    ],
  }),
}));
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} className={rest.className as string} data-testid={rest["data-testid"] as string}>{children}</a>
  ),
}));

import { BankBalanceWhy } from "./bank-balance-why";
import { updatedWords } from "@/lib/bankFreshWords";

const NOW = new Date("2026-09-11T17:00:00.000Z");

function explain(over: Record<string, unknown> = {}) {
  return {
    asOf: NOW.toISOString(),
    displayed: { bankToday: "1960.00" },
    freshness: {
      source: "plaid",
      lastContactAt: null,
      lastFailureAt: null,
      fetchedAt: "2026-09-10T14:00:00.000Z",
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

/**
 * Open the popover and wait for its body: (WP3) the explanation is its own lazy
 * chunk, drawn behind a "Loading…" fallback for the moment it takes to arrive.
 */
const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Why this number?" }));
  await waitFor(() => expect(screen.queryByTestId("bank-why-chunk")).toBeNull());
};
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

  it("asks afresh once it opens, and says it is loading", async () => {
    render(<BankBalanceWhy />);
    await open();
    expect(lastQuery()?.enabled).toBe(true);
    expect(lastQuery()?.staleTime).toBe(0);
    expect(popoverText()).toContain("Loading…");
  });

  it("while a newer answer is on its way, says Loading… rather than showing the older one", async () => {
    state.result = { data: explain(), isFetching: true };
    render(<BankBalanceWhy />);
    await open();
    expect(popoverText()).toContain("Loading…");
    expect(screen.queryByTestId("bank-why-displayed")).toBeNull();
  });

  it("after a failed refresh, keeps the last answer under a banner that says so", async () => {
    state.result = {
      data: explain(),
      isRefetchError: true,
      dataUpdatedAt: NOW.getTime() - 5 * 60 * 1000,
    };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.getByTestId("bank-why-refresh-banner").textContent).toContain("Couldn't refresh");
    expect(screen.getByTestId("bank-why-displayed").textContent).toBe("$1,960.00");
  });

  it("after a failed load, says so and offers a Retry that retries", async () => {
    state.result = { data: undefined, isLoadingError: true };
    render(<BankBalanceWhy />);
    await open();
    expect(popoverText()).toContain("Couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("Why this number? — the server's lines", () => {
  it("shows the balance, the snapshot and the rows since, with the next Sync's attempt", async () => {
    state.result = { data: explain() };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.getByTestId("bank-why-displayed").textContent).toBe("$1,960.00");
    const snap = screen.getByTestId("bank-why-snapshot").textContent ?? "";
    expect(snap).toContain("$2,000.00");
    // (T1) Named as the bank's reading (or a typed balance), with the account it was read from.
    expect(snap).toContain("Bank's last reading");
    expect(snap).toContain("(Checking · ••1111)");
    // (Task 4) …and its time on the household clock (14:00Z = 9:00 AM Central).
    expect(snap).toContain("Sep 10, 2026, 9:00 AM");
    const since = screen.getByTestId("bank-why-since").textContent ?? "";
    expect(since).toContain("2 rows since then");
    expect(since).toContain("-$40.00");
    expect(screen.getByTestId("bank-why-next-sync").textContent).toBe(
      "The next Sync asks the bank for this balance.",
    );
  });

  it("dates the snapshot with the server's household day, not a UTC slice", async () => {
    // 02:30Z on the 11th is 21:30 on the 10th in Chicago.
    state.result = {
      data: explain({
        snapshot: { ...explain().snapshot, at: "2026-09-11T02:30:00.000Z" },
        ledger: { ...explain().ledger, anchorDay: "2026-09-10" },
      }),
    };
    render(<BankBalanceWhy />);
    await open();
    const snap = screen.getByTestId("bank-why-snapshot").textContent ?? "";
    expect(snap).toContain("Sep 10, 2026");
    expect(snap).not.toContain("Sep 11");
  });

  it("dates the freshness line from the snapshot, not from when the answer was made", async () => {
    state.result = { data: explain() };
    render(<BankBalanceWhy />);
    await open();
    // "Updated" is the server's fetchedAt (a day before the answer), in the one set of words.
    expect(screen.getByTestId("text-bank-snapshot-freshness").textContent).toBe(updatedWords("2026-09-10T14:00:00.000Z", NOW.getTime()));
  });

  it("(Task 4) adds no note, and says the sum, when the lines add up to the cent (even 0.10 + 0.20 = 0.30)", async () => {
    state.result = {
      data: explain({
        displayed: { bankToday: "0.30" },
        snapshot: { ...explain().snapshot, balance: "0.10" },
        ledger: { ...explain().ledger, sinceAnchor: { rowCount: 1, net: "0.20" } },
      }),
    };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.queryByTestId("bank-why-mismatch")).toBeNull();
    // Only a sum that ties is written as one: "Bank's last reading $0.10 + 1 row = Checking today $0.30".
    expect(screen.getByTestId("bank-why-sum").textContent).toBe("Bank's last reading $0.10 + 1 row = Checking today$0.30");
  });

  it("says the lines don't add up when they don't, still with no equation", async () => {
    // (PR4e) Both lines follow one rule now, so the note names no cause.
    state.result = { data: explain({ displayed: { bankToday: "1925.10" } }) };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.getByTestId("bank-why-mismatch").textContent).toContain("do not add up to the cent");
    expect(screen.getByTestId("bank-why-mismatch").textContent).not.toContain("different rules");
    expect(popoverText()).not.toContain("=");
  });

  it("with no rows figure (unresolved account), still says so when the snapshot and balance differ", async () => {
    state.result = {
      data: explain({ ledger: { anchorDay: "2026-09-10", sinceAnchor: null, recentRows: [] } }),
    };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.queryByTestId("bank-why-since")).toBeNull();
    expect(screen.getByTestId("bank-why-mismatch")).toBeTruthy();
  });

  it("with no rows figure and a snapshot equal to the balance, adds no note", async () => {
    state.result = {
      data: explain({
        displayed: { bankToday: "2000.00" },
        ledger: { anchorDay: "2026-09-10", sinceAnchor: null, recentRows: [] },
      }),
    };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.queryByTestId("bank-why-mismatch")).toBeNull();
  });

  it("gives the server's reason when the next Sync won't ask the bank", async () => {
    state.result = {
      data: explain({
        nextSync: {
          willRefreshBalance: false,
          whyNot: "the resolved account is no longer on file for this household",
        },
      }),
    };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.getByTestId("bank-why-next-sync").textContent).toBe(
      "The next Sync won't ask the bank for it: the resolved account is no longer on file for this household.",
    );
  });

  it("with no snapshot, says the forecast runs off the starting balance, and nothing about the next Sync", async () => {
    state.result = {
      data: explain({
        // (WP10) No snapshot, no bank balance: the server sends null, never "0.00".
        displayed: { bankToday: null },
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
    await open();
    expect(screen.getByTestId("bank-why-no-snapshot").textContent).toContain(
      "runs off the starting balance",
    );
    // (WP10) The figure is an em dash, never $0.00.
    expect(screen.getByTestId("bank-why-displayed").textContent).toBe("—");
    expect(popoverText()).not.toContain("$0.00");
    expect(screen.queryByTestId("bank-why-snapshot")).toBeNull();
    expect(screen.queryByTestId("bank-why-mismatch")).toBeNull();
    expect(screen.queryByTestId("bank-why-next-sync")).toBeNull();
  });

  it("shows a stale verdict in words when the server judges the balance stale", async () => {
    state.result = {
      data: explain({
        freshness: {
          source: "plaid",
          lastContactAt: "2026-09-10T14:00:00.000Z",
          lastFailureAt: "2026-09-11T16:00:00.000Z",
          fetchedAt: "2026-09-10T14:00:00.000Z",
          stale: true,
          staleReason: "refresh_failed",
        },
      }),
    };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.getByTestId("text-bank-freshness-stale").textContent).toBe("Last sync failed · Updated 1 d ago");
  });
});

// ⭐ (Task 4, D) THE ROWS BEHIND THE FIGURE: every row the server's rule counted
// (date · description · signed amount · Pending/Posted · a link to the row), the
// sum line, the estimate head, and the rows it left out behind "Not counted (n)"
// with the rule's word. Synthetic figures: a reading of $0.00 and two pending rows.
describe("(Task 4) Why this number? — the counted rows, the sum, what was left out", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "t", date: "2026-09-11", description: "ROW", amount: "0.00", pending: false, accountExternalId: "ext-1", source: "plaid:chase", onAccount: true,
    counted: true, contribution: "0.00", reason: "counted", replacedId: null, ...over,
  });
  const zeroRowsToday = (rows: unknown[], net = "3374.60", bankToday = "3374.60") =>
    explain({
      displayed: { bankToday },
      snapshot: { ...explain().snapshot, balance: "0.00", at: "2026-09-10T12:02:00.000Z" },
      ledger: {
        anchorDay: "2026-09-10",
        sinceAnchor: { rowCount: (rows as Array<{ counted: boolean }>).filter((r) => r.counted).length, net },
        rows,
        recentRows: [],
      },
    });
  const pay = row({ id: "t-pay", description: "PAYROLL DEPOSIT", amount: "3500.00", contribution: "3500.00", pending: true });
  const hw = row({ id: "t-hw", description: "HARDWARE DEPOT 0099", amount: "-125.40", contribution: "-125.40", pending: true });

  it("lists every counted row with its date, description, signed figure and Pending chip; the sum line ties to Checking today", async () => {
    state.result = { data: zeroRowsToday([pay, hw]) };
    render(<BankBalanceWhy />);
    await open();
    const list = screen.getByTestId("bank-why-rows");
    const items = Array.from(list.querySelectorAll("[data-testid=bank-why-row]"));
    expect(items.map((li) => li.getAttribute("data-row-id"))).toEqual(["t-pay", "t-hw"]);
    expect(items[0]!.textContent).toBe("Sep 11PAYROLL DEPOSITPendingmay still change+$3,500.00");
    expect(items[1]!.textContent).toBe("Sep 11HARDWARE DEPOT 0099Pendingmay still change-$125.40");
    // ⭐ Sum line: the reading + the counted rows = Checking today, to the cent (the server's figures, summed once to check).
    expect(screen.getByTestId("bank-why-sum").textContent).toBe("Bank's last reading $0.00 + 2 rows = Checking today$3,374.60");
    // A reading of $0.00 is a real $0.00, plain.
    expect(screen.getByTestId("bank-why-snapshot").textContent).toContain("$0.00");
  });

  it("⭐ a pending counted row makes the head an Estimate — never 'confirmed'; posted rows only: no estimate", async () => {
    state.result = { data: zeroRowsToday([pay, hw]) };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.getByTestId("bank-why-estimate").textContent).toBe("Estimate: 2 pending rows");
    expect(popoverText().toLowerCase()).not.toContain("confirmed");
    cleanup();
    state.result = { data: zeroRowsToday([{ ...pay, pending: false }, { ...hw, pending: false }]) };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.queryByTestId("bank-why-estimate")).toBeNull();
    expect(screen.queryAllByTestId("bank-why-row-may-change")).toHaveLength(0);
    expect(screen.getByTestId("bank-why-rows").textContent).toContain("Posted");
  });

  it("each row links to itself on its ledger (the one route rule: ?tx= lands on it); a manual row opens the checking ledger", async () => {
    const manual = row({ id: "t-man", description: "Cash deposit", amount: "20.00", contribution: "20.00", accountExternalId: null, source: "manual" });
    state.result = { data: zeroRowsToday([pay, manual], "3520.00", "3520.00") };
    render(<BankBalanceWhy />);
    await open();
    const links = screen.getAllByTestId("bank-why-row-link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/transactions?account=row-1&month=2026-09-01&tx=t-pay", "/transactions?tx=t-man&month=2026-09-01"]);
  });

  it("rows the rule left out sit behind 'Not counted (n)' with the rule's word; other accounts are one line", async () => {
    const held = row({ id: "t-held", date: "2026-09-10", description: "CORNER BISTRO", amount: "-30.00", counted: false, reason: "held" });
    const replaced = row({ id: "t-pend", date: "2026-09-09", description: "TST* BISTRO", amount: "-48.20", pending: true, counted: false, reason: "superseded" });
    const card1 = row({ id: "t-c1", description: "GREEN GROCER", amount: "-90.00", accountExternalId: "card-9", source: "plaid:amex", onAccount: false, counted: false, reason: "not_bank" });
    // The rule says "held" first: a card row dated before the reading's day is another account's all the same.
    const card2 = row({ id: "t-c2", date: "2026-09-09", description: "FUEL STOP", amount: "-45.00", accountExternalId: "card-9", source: "plaid:amex", onAccount: false, counted: false, reason: "held" });
    state.result = { data: zeroRowsToday([pay, hw, held, replaced, card1, card2]) };
    render(<BankBalanceWhy />);
    await open();
    const box = screen.getByTestId("bank-why-not-counted");
    expect(box.tagName).toBe("DETAILS");
    expect(box.querySelector("summary")!.textContent).toBe("Not counted (4)");
    const left = Array.from(screen.getByTestId("bank-why-not-counted-rows").querySelectorAll("[data-testid=bank-why-row-reason]")).map((e) => e.textContent);
    expect(left).toEqual(["In the bank's reading", "Replaced by its posted row"]);
    expect(screen.getByTestId("bank-why-other-accounts").textContent).toBe("2 rows · Another account");
    // Never "In the bank's reading" beside another account's row.
    expect(screen.getByTestId("bank-why-not-counted-rows").textContent).not.toContain("FUEL STOP");
    // Left-out rows show their own amount, never as counted, and never in the counted list.
    expect(Array.from(screen.getByTestId("bank-why-rows").querySelectorAll("[data-testid=bank-why-row]")).map((li) => li.getAttribute("data-row-id"))).toEqual(["t-pay", "t-hw"]);
  });

  it("a posted row whose pending charge was in the reading counts only the change, and says so", async () => {
    const tip = row({ id: "t-tip", description: "CORNER BISTRO", amount: "-55.00", contribution: "-6.80", reason: "adjusted", replacedId: "t-p" });
    state.result = { data: zeroRowsToday([tip], "-6.80", "-6.80") };
    render(<BankBalanceWhy />);
    await open();
    const li = screen.getByTestId("bank-why-rows").querySelector("[data-testid=bank-why-row]")!;
    expect(li.textContent).toContain("Adds the change from its pending charge");
    expect(li.querySelector("[data-testid=bank-why-row-amount]")!.textContent).toBe("-$6.80");
  });

  it("⚠️ rows that do not add up to the server's own figure: no sum line, the 'do not add up' note instead", async () => {
    // The rows say +3,374.60; the server's since-figure says +3,000.00.
    state.result = { data: zeroRowsToday([pay, hw], "3000.00", "3000.00") };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.queryByTestId("bank-why-sum")).toBeNull();
    expect(screen.getByTestId("bank-why-mismatch").textContent).toContain("do not add up to the cent");
  });

  it("an older server (no rows): the lines as before, no list, no estimate", async () => {
    state.result = { data: explain() };
    render(<BankBalanceWhy />);
    await open();
    expect(screen.queryByTestId("bank-why-rows")).toBeNull();
    expect(screen.queryByTestId("bank-why-not-counted")).toBeNull();
    expect(screen.queryByTestId("bank-why-estimate")).toBeNull();
    expect(screen.getByTestId("bank-why-since").textContent).toContain("2 rows since then");
  });
});
