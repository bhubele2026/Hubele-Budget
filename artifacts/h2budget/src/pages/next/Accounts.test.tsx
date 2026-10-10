import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  items: [] as unknown[], debts: [] as unknown[], payoff: null as unknown,
  liabs: [] as unknown[], liabEnabled: [] as boolean[],
  bank: null as unknown,
  amexProps: vi.fn(), chaseProps: vi.fn(),
  extraTxns: [] as unknown[],
  /** (WP7 review) The linked accounts' read: "ok", "loading" or "failed". */
  itemsState: "ok" as "ok" | "loading" | "failed",
  refetchItems: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<object>()),
  useListPlaidItems: () =>
    h.itemsState === "failed"
      ? { data: undefined, isLoading: false, isError: true, refetch: h.refetchItems }
      : h.itemsState === "loading"
        ? { data: undefined, isLoading: true, isError: false, refetch: h.refetchItems }
        : { data: h.items, isLoading: false, isError: false, refetch: h.refetchItems },
  useListDebts: () => ({ data: h.debts }),
  useGetAmexWeeklyPayoff: () => ({ data: h.payoff }),
  // (WP3) A card with no debt row reads Plaid's stored liability figures; the
  // page asks only when such a card exists.
  useListPlaidLiabilityAccounts: (_p: unknown, o: { query: { enabled: boolean } }) => {
    h.liabEnabled.push(o.query.enabled);
    return { data: o.query.enabled ? h.liabs : undefined };
  },
  useListTransactions: () => ({ data: [
    { id: "t1", occurredOn: "2026-10-07", description: "COFFEE", amount: "-4.50", plaidAccountId: "ext-amex", pending: true, categoryId: "c1" },
    { id: "t2", occurredOn: "2026-10-06", description: "PAYROLL", amount: "900", plaidAccountId: "ext-chk", pending: false, categoryId: null },
    ...h.extraTxns,
  ], isLoading: false }),
  useListCategories: () => ({ data: [{ id: "c1", name: "Dining" }] }),
}));
// (WP3) The checking balance is the spine's bank view (WP1), no request of its own.
vi.mock("@/hooks/useBankBalanceView", () => ({ useBankBalanceView: () => ({ view: h.bank, state: "loaded", refetch: () => {} }) }));
// (C10) The Amex page renders the host's `lead` (the Summary panel) itself.
vi.mock("@/pages/amex", () => ({ default: (p: { lead?: ReactNode }) => { h.amexProps(p); return <div data-testid="amex-ledger">{p.lead}</div>; } }));
// (C9) The Chase page renders the host's `lead` (the Summary panel) itself.
vi.mock("@/pages/transactions", () => ({ default: (p: { lead?: ReactNode }) => { h.chaseProps(p); return <div data-testid="chase-ledger">{p.lead}</div>; } }));

import NextAccountsPage from "./Accounts";
import { buildEntries } from "./accounts/entries";
import { AccountSummary, money } from "./accounts/AccountSummary";
import { ForecastLegend } from "./accounts/ForecastLegend";
import { identityOf } from "@/lib/accountIdentity";

afterEach(() => {
  cleanup(); h.amexProps.mockClear(); h.chaseProps.mockClear(); h.extraTxns = [];
  h.liabs = []; h.liabEnabled = []; h.itemsState = "ok"; h.refetchItems.mockClear();
});

const item = (id: string, inst: string, slug: string, accounts: object[], extra: object = {}) =>
  ({ id, itemId: id, institutionName: inst, institutionSlug: slug, accounts, lastSyncedAt: "2026-10-08T10:00:00Z", lastBankTxOn: "2026-10-07", ...extra });
const seed = () => {
  h.items = [
    item("i1", "Chase", "chase", [{ id: "r-chk", accountId: "ext-chk", name: "Total Checking", mask: "4821", type: "depository", subtype: "checking" }]),
    item("i2", "American Express", "amex", [{ id: "r-amex", accountId: "ext-amex", name: "Platinum", mask: "1005", type: "credit", subtype: "credit card" }], { lastSyncError: "x", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
  ];
  // The API's shape: `plaidAccountId` is the INTERNAL row id; every debt has a status.
  h.debts = [{ id: "d1", plaidAccountId: "r-amex", balance: "1234.50", minPayment: "35", dueDay: 14, status: "active" }];
  // The API's shape: `accountId` is the external Plaid account_id, `plaidAccountId` the internal row id.
  h.payoff = { cards: [{ accountId: "ext-amex", plaidAccountId: "r-amex", weekCharges: 120, chargeCount: 3, pctOfStatementThisWeek: 10, statementBalance: 1100 }] };
  // The spine's bank view: $3,458.98 read Oct 2, 20 entries since, $2,156.55 today — on account r-chk BY ID.
  h.bank = {
    balance: "2156.55",
    snapshot: { balance: "3458.98", at: "2026-10-02T15:00:00Z", day: "2026-10-02", source: "plaid" },
    since: { net: "-1302.43", count: 20, through: "2026-10-09" },
    account: { rowId: "r-chk", externalId: "ext-chk", name: "Total Checking", mask: "4821", subtype: "checking", via: "pointer" },
  };
};
const renderAt = (path: string) => {
  const { hook } = memoryLocation({ path });
  return render(<Router hook={hook}><NextAccountsPage /></Router>);
};

describe("accounts selector", () => {
  it("shows identity words, accents, balances and connection state per account", () => {
    seed(); renderAt("/next/accounts");
    const chk = screen.getByTestId("account-chip-ext-chk");
    expect(chk.getAttribute("data-accent")).toBe("checking");
    expect(chk.textContent).toContain("Chase Total Checking");
    expect(chk.textContent).toContain("4821");
    // (WP3) The dashboard's figure (the snapshot rolled forward), with the bank's
    // own snapshot under it, dated — it was the raw snapshot, undated.
    expect(within(chk).getByTestId("chip-balance").textContent).toBe("Balance $2,156.55");
    expect(within(chk).getByTestId("chip-snapshot").textContent).toBe("Snapshot $3,458.98 · Oct 2 · +20 entries");
    // (WP3) Three stamps, each named: synced · balance read · data through
    // (the newest bank row, never the sync day).
    expect(within(chk).getByTestId("chip-stamps").textContent).toMatch(/^synced .+ · balance read .+ · data through Oct 7$/);
    expect(within(chk).queryByTestId("chip-state")).toBeNull(); // "synced …" already says it
    const amex = screen.getByTestId("account-chip-ext-amex");
    expect(amex.getAttribute("data-accent")).toBe("amex");
    expect(within(amex).getByTestId("chip-balance").textContent).toBe("Owed $1,234.50");
    expect(within(amex).getByTestId("chip-state").textContent).toContain("Needs reconnect");
  });
  it("marks the selected account current and leaves 'All accounts' otherwise", () => {
    seed(); renderAt("/next/accounts/ext-amex");
    expect(screen.getByTestId("account-chip-ext-amex").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("account-chip-all").getAttribute("aria-current")).toBeNull();
  });
});

describe("the checking account is picked BY ID (WP3, on WP1's ids)", () => {
  it("a second checking account with the same mask is not the spine's: it shows its own reading, not rolled forward", () => {
    seed();
    h.items = [
      item("i1", "Chase", "chase", [
        { id: "r-chk", accountId: "ext-chk", name: "Total Checking", mask: "4821", type: "depository", subtype: "checking" },
        { id: "r-twin", accountId: "ext-twin", name: "Total Checking", mask: "4821", type: "depository", subtype: "checking",
          snapshot: { balance: "812.40", at: "2026-10-05T14:00:00Z", source: "plaid" } },
      ]),
    ];
    renderAt("/next/accounts");
    expect(within(screen.getByTestId("account-chip-ext-chk")).getByTestId("chip-balance").textContent).toBe("Balance $2,156.55");
    const twin = screen.getByTestId("account-chip-ext-twin");
    expect(within(twin).getByTestId("chip-balance").textContent).toBe("Snapshot $812.40 · as of Oct 5 · not rolled forward");
    expect(within(twin).queryByTestId("chip-snapshot")).toBeNull();
  });
  it("accounts without a mask are never 'the checking account' because \"\" equals \"\"", () => {
    seed();
    h.items = [item("i1", "Chase", "chase", [
      { id: "r-chk", accountId: "ext-chk", name: "Total Checking", mask: null, type: "depository", subtype: "checking" },
      { id: "r-other", accountId: "ext-other", name: "Everyday", mask: null, type: "depository", subtype: "checking" },
    ])];
    h.bank = { ...(h.bank as object), account: { rowId: "r-chk", externalId: "ext-chk", name: "Total Checking", mask: null, subtype: "checking", via: "pointer" } };
    renderAt("/next/accounts");
    expect(within(screen.getByTestId("account-chip-ext-chk")).getByTestId("chip-balance").textContent).toBe("Balance $2,156.55");
    expect(within(screen.getByTestId("account-chip-ext-other")).getByTestId("chip-balance").textContent).toBe("Balance is not tracked for this account.");
  });
});

describe("combined view", () => {
  it("lists recent rows from every account with identity, status and category", () => {
    seed(); renderAt("/next/accounts");
    const panel = screen.getByTestId("combined-activity");
    expect(panel.textContent).toContain("COFFEE");
    expect(panel.querySelector('[title="American Express Platinum"]')).toBeTruthy();
    expect(panel.textContent).toContain("Pending");
    expect(panel.textContent).toContain("Dining");
    expect(panel.querySelector('[title="Chase Total Checking"]')).toBeTruthy();
    expect(panel.textContent).toContain("Posted");
  });
  it("(dash-accuracy) a row with no linked account says where it came from, not 'Manual entry' for all", () => {
    seed();
    h.extraTxns = [
      { id: "t3", occurredOn: "2026-10-05", description: "WORKBOOK", amount: "12.00", plaidAccountId: null, source: "amex", pending: false, categoryId: null },
      { id: "t4", occurredOn: "2026-10-05", description: "CASH", amount: "-5.00", plaidAccountId: null, source: "manual", pending: false, categoryId: null },
      { id: "t5", occurredOn: "2026-10-04", description: "OLD CARD", amount: "-9.00", plaidAccountId: "ext-gone", source: "plaid:chase", pending: false, categoryId: null },
    ];
    renderAt("/next/accounts");
    const panel = screen.getByTestId("combined-activity");
    expect(panel.querySelector('[title="Amex (imported)"]')).toBeTruthy();
    expect(panel.querySelector('[title="Manual entry"]')).toBeTruthy();
    expect(panel.querySelector('[title="Chase (no longer linked)"]')).toBeTruthy();
  });
});

describe("(WP7) combined view: where each row opens", () => {
  it("a linked row opens its account's page on its month; a workbook row All cards; a manual row the checking ledger; a gone account says why", () => {
    seed();
    h.extraTxns = [
      { id: "t3", occurredOn: "2026-09-05", description: "WORKBOOK", amount: "12.00", plaidAccountId: null, source: "amex", pending: false, categoryId: null },
      { id: "t4", occurredOn: "2026-10-05", description: "CASH", amount: "-5.00", plaidAccountId: null, source: "manual", pending: false, categoryId: null },
      { id: "t5", occurredOn: "2026-10-04", description: "OLD CARD", amount: "-9.00", plaidAccountId: "ext-gone", source: "plaid:chase", pending: false, categoryId: null },
    ];
    renderAt("/next/accounts");
    const panel = screen.getByTestId("combined-activity");
    const hrefOf = (name: string) => within(panel).queryByRole("link", { name })?.getAttribute("href") ?? null;
    expect(hrefOf("COFFEE")).toBe("/next/accounts/ext-amex?tx=t1&month=2026-10-01");
    expect(hrefOf("PAYROLL")).toBe("/next/accounts/ext-chk?tx=t2&month=2026-10-01");
    expect(hrefOf("WORKBOOK")).toBe("/amex?tx=t3&month=2026-09-01");
    expect(hrefOf("CASH")).toBe("/transactions?tx=t4&month=2026-10-01");
    expect(hrefOf("OLD CARD")).toBeNull();
    const notes = within(panel).getAllByTestId("txn-note");
    expect(notes.map((n) => n.textContent)).toEqual(["No ledger: Chase (no longer linked)"]);
  });
  it("a full window says it shows the newest 100 rows of the last 30 days; a short one says nothing", () => {
    seed();
    h.extraTxns = Array.from({ length: 98 }, (_, i) => ({
      id: `f${i}`, occurredOn: "2026-09-20", description: `ROW ${i}`, amount: "-1.00", plaidAccountId: "ext-chk", source: "plaid:chase", pending: false, categoryId: null,
    }));
    const full = renderAt("/next/accounts");
    expect(screen.getByTestId("combined-activity-cap").textContent).toBe("Showing the newest 100 rows of the last 30 days.");
    full.unmount();
    h.extraTxns = Array.from({ length: 97 }, (_, i) => ({
      id: `f${i}`, occurredOn: "2026-09-20", description: `ROW ${i}`, amount: "-1.00", plaidAccountId: "ext-chk", source: "plaid:chase", pending: false, categoryId: null,
    }));
    renderAt("/next/accounts");
    expect(screen.queryByTestId("combined-activity-cap")).toBeNull();
  });
  it("the account chips link by the external account id", () => {
    seed(); renderAt("/next/accounts");
    expect(screen.getByTestId("account-chip-ext-chk").getAttribute("href")).toBe("/next/accounts/ext-chk");
    expect(screen.getByTestId("account-chip-ext-amex").getAttribute("href")).toBe("/next/accounts/ext-amex");
    expect(screen.getByTestId("account-chip-all").getAttribute("href")).toBe("/next/accounts");
  });
});

describe("(WP7 review) a failed or loading read of the linked accounts is unknown, never 'none'", () => {
  it("failed: says the accounts did not load with Try again, never 'No linked accounts yet.', and no row reads 'no longer linked'", () => {
    seed();
    h.itemsState = "failed";
    renderAt("/next/accounts");
    const alert = screen.getByTestId("accounts-failed");
    expect(alert.textContent).toContain("did not load");
    expect(screen.queryByText("No linked accounts yet.")).toBeNull();
    within(alert).getByRole("button", { name: "Try again" }).click();
    expect(h.refetchItems).toHaveBeenCalled();
    const panel = screen.getByTestId("combined-activity");
    expect(panel.textContent).not.toContain("no longer linked");
    expect(within(panel).queryAllByTestId("txn-note")).toHaveLength(0);
    expect(within(panel).queryByRole("link", { name: "COFFEE" })).toBeNull();
  });
  it("failed on an account's own page: not 'That account is not linked here'", () => {
    seed();
    h.itemsState = "failed";
    renderAt("/next/accounts/ext-amex");
    expect(screen.queryByText(/not linked here/)).toBeNull();
  });
  it("loading: the combined view's Plaid rows wait unlinked and unlabelled", () => {
    seed();
    h.itemsState = "loading";
    renderAt("/next/accounts");
    const panel = screen.getByTestId("combined-activity");
    expect(panel.textContent).not.toContain("no longer linked");
    expect(within(panel).queryAllByTestId("txn-note")).toHaveLength(0);
  });
});

describe("route id", () => {
  it("accepts the items response row id as well as the Plaid account_id", async () => {
    seed(); renderAt("/next/accounts/r-amex");
    await waitFor(() => expect(screen.getByTestId("amex-ledger")).toBeTruthy());
    expect(h.amexProps).toHaveBeenCalledWith(expect.objectContaining({ accountId: "ext-amex" }));
    expect(screen.queryByText(/not linked here/)).toBeNull();
    expect(screen.getByTestId("account-chip-ext-amex").getAttribute("aria-current")).toBe("page");
  });
  it("shows card purchases as spending in the combined view", () => {
    seed(); renderAt("/next/accounts");
    expect(screen.getByTestId("combined-activity").textContent).toContain("-$4.50");
  });
});

describe("card variant", () => {
  it("renders the existing Amex ledger scoped to the card, with summary figures and the legend", async () => {
    seed(); renderAt("/next/accounts/ext-amex");
    await waitFor(() => expect(screen.getByTestId("amex-ledger")).toBeTruthy());
    expect(h.amexProps).toHaveBeenCalledWith(expect.objectContaining({ embedded: true, accountId: "ext-amex" }));
    expect(screen.queryByTestId("chase-ledger")).toBeNull();
    const s = screen.getByTestId("account-summary").textContent!;
    expect(within(screen.getByTestId("summary-owed")).getByText("$1,234.50")).toBeTruthy();
    expect(within(screen.getByTestId("summary-creditor")).getByText("$1,234.50")).toBeTruthy();
    // (WP3) The weekly payoff's `statementBalance` is the card's CURRENT balance
    // under another name: it never fills "Statement balance" (a real statement
    // only, once the API sends one).
    expect(s).not.toContain("$1,100.00");
    expect(within(screen.getByTestId("summary-statement")).getByText("—")).toBeTruthy();
    expect(s).toContain("$35.00");
    expect(s).toContain("14th of the month");
    expect(screen.getByTestId("legend-charged").textContent).toContain("Charged to this card");
    expect(screen.getByTestId("legend-paid").getAttribute("data-accent")).toBe("checking");
    expect(screen.getByTestId("legend-payment").textContent).toContain("Payment to this card");
  });
});

describe("card Summary reads the weekly-payoff card on the ids the API sends", () => {
  /**
   * The payoff card's `plaidAccountId` is the INTERNAL row id and its
   * `accountId` the external one; the old match compared the internal id with
   * the external route id, so the Summary's statement balance and this week's
   * charges were always dashes. Either id now matches.
   */
  it.each([
    ["the external id (accountId)", { accountId: "ext-amex", plaidAccountId: null }],
    ["the internal row id (plaidAccountId)", { accountId: "other-ext", plaidAccountId: "r-amex" }],
  ])("matches on %s: this week's charges show", async (_label, ids) => {
    seed();
    h.payoff = { cards: [{ ...ids, weekCharges: 120, chargeCount: 3, pctOfStatementThisWeek: 0.1, statementBalance: 1100 }] };
    renderAt("/next/accounts/ext-amex");
    await waitFor(() => expect(screen.getByTestId("amex-ledger")).toBeTruthy());
    const s = screen.getByTestId("account-summary").textContent!;
    expect(s).toContain("$120.00");
    // The share is a 0–1 fraction of the card's current balance (it read "0%").
    expect(s).toContain("3 charges · 10% of the card's current balance");
  });
  it("another card's payoff entry never lends its figures", async () => {
    seed();
    h.payoff = { cards: [{ accountId: "ext-other", plaidAccountId: "r-other", weekCharges: 120, chargeCount: 3, pctOfStatementThisWeek: 0.1, statementBalance: 1100 }] };
    renderAt("/next/accounts/ext-amex");
    await waitFor(() => expect(screen.getByTestId("amex-ledger")).toBeTruthy());
    const s = screen.getByTestId("account-summary").textContent!;
    expect(s).not.toContain("$1,100.00");
    expect(s).not.toContain("$120.00");
  });
});

describe("checking variant", () => {
  it("renders the existing Chase ledger for that account, with a balance and no card legend", async () => {
    seed(); renderAt("/next/accounts/ext-chk");
    await waitFor(() => expect(screen.getByTestId("chase-ledger")).toBeTruthy());
    expect(h.chaseProps).toHaveBeenCalledWith(expect.objectContaining({ embedded: true, accountKey: "r-chk" }));
    expect(screen.queryByTestId("amex-ledger")).toBeNull();
    // (WP3) "Balance today" is the rolled-forward figure; the bank snapshot sits under it.
    expect(within(screen.getByTestId("summary-balance")).getByText("$2,156.55")).toBeTruthy();
    expect(screen.getByTestId("summary-balance").textContent).toContain("Includes 20 entries since the Oct 2 snapshot");
    const snap = screen.getByTestId("summary-bank-snapshot");
    expect(within(snap).getByText("$3,458.98")).toBeTruthy();
    expect(snap.textContent).toContain("Oct 2 · +20 entries");
    expect(screen.queryByTestId("forecast-legend")).toBeNull();
  });
});

describe("an account = its page's own layout (C9 checking, C10 card)", () => {
  /**
   * One account experience: `/next/accounts/:id` renders the same layout as
   * `/transactions` (checking) or `/amex` (card), embedded (no title), full
   * width, with the account Summary as the first panel of its figures row.
   * The ledger's own panel is sticky-safe (pinned in `chaseLayout.test.tsx`
   * and `amexLayout.test.tsx`), so nothing between this cell and the page may
   * be a scroll container either.
   */
  it.each([
    ["/next/accounts/ext-chk", "chase-ledger", { accountKey: "r-chk" }, "$2,156.55"],
    ["/next/accounts/ext-amex", "amex-ledger", { accountId: "ext-amex" }, "$1,234.50"],
  ])("%s spans the grid, passes the Summary as the lead, and adds no scroll container", async (path, ledger, props, figure) => {
    seed(); renderAt(path);
    await waitFor(() => expect(screen.getByTestId(ledger)).toBeTruthy());
    const cell = screen.getByTestId("account-activity");
    expect(cell.className).toContain("span-12");
    expect(cell.className).not.toContain("panel");
    const spy = ledger === "chase-ledger" ? h.chaseProps : h.amexProps;
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ embedded: true, ...props, lead: expect.anything() }));
    // The Summary is inside the account's layout (its lead), not beside it.
    expect(within(screen.getByTestId(ledger)).getByTestId("account-summary").textContent).toContain(figure);
    let el: HTMLElement | null = screen.getByTestId(ledger);
    while (el && el !== document.body) {
      expect(el.className ?? "").not.toMatch(/\boverflow-(hidden|auto|scroll)\b|panel-link|\bpanel\b/);
      el = el.parentElement;
    }
  });
});

describe("blanks never become zero, and a real zero is never a blank (WP3)", () => {
  const amexId = identityOf({ id: "r", name: "Platinum", type: "credit", institutionName: "American Express", institutionSlug: "amex" });
  const entry = { plaidAccountId: "x", rowId: "r", itemId: "i", identity: amexId, state: "synced" as const, lastSyncedAt: null, dataThrough: null };
  it("shows an em-dash for every figure the API does not carry", () => {
    // No debt row and no liability figures: nothing is known.
    render(<AccountSummary entry={entry} debt={null} payoffCard={null} />);
    const s = screen.getByTestId("account-summary").textContent!;
    expect(s).not.toContain("$0");
    expect((s.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(screen.getByTestId("summary-plan").textContent).toBe("Not on the payoff plan");
  });
  it("a real zero balance is $0.00, while an unknown \"0\" minimum stays a dash", () => {
    render(<AccountSummary entry={entry} debt={{ balance: "0.00", minPayment: "0", status: "active" }} payoffCard={null} />);
    expect(within(screen.getByTestId("summary-owed")).getByText("$0.00")).toBeTruthy();
    expect(within(screen.getByTestId("summary-creditor")).getByText("$0.00")).toBeTruthy();
    expect(within(screen.getByTestId("summary-min")).getByText("—")).toBeTruthy();
  });
  it("money(): zero is a figure, missing or unreadable is a dash", () => {
    expect(money(0)).toBe(0);
    expect(money("0.00")).toBe(0);
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money("")).toBe("—");
    expect(money("abc")).toBe("—");
  });
  it("legend uses the card's own accent for charges and payments", () => {
    render(<ForecastLegend card={identityOf({ id: "c", type: "credit", institutionName: "Citi", institutionSlug: "citi" }, { cardOrder: ["c"] })} />);
    expect(screen.getByTestId("legend-charged").getAttribute("data-accent")).toBe("card2");
  });
  it("buildEntries tolerates no items", () => { expect(buildEntries(undefined)).toEqual([]); });
});
