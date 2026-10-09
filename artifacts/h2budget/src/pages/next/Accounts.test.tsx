import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  items: [] as unknown[], debts: [] as unknown[], payoff: null as unknown, forecast: null as unknown,
  amexProps: vi.fn(), chaseProps: vi.fn(),
  extraTxns: [] as unknown[],
}));

vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<object>()),
  useListPlaidItems: () => ({ data: h.items, isLoading: false }),
  useListDebts: () => ({ data: h.debts }),
  useGetAmexWeeklyPayoff: () => ({ data: h.payoff }),
  useGetForecast: () => ({ data: h.forecast }),
  useListTransactions: () => ({ data: [
    { id: "t1", occurredOn: "2026-10-07", description: "COFFEE", amount: "-4.50", plaidAccountId: "ext-amex", pending: true, categoryId: "c1" },
    { id: "t2", occurredOn: "2026-10-06", description: "PAYROLL", amount: "900", plaidAccountId: "ext-chk", pending: false, categoryId: null },
    ...h.extraTxns,
  ], isLoading: false }),
  useListCategories: () => ({ data: [{ id: "c1", name: "Dining" }] }),
}));
// (C10) The Amex page renders the host's `lead` (the Summary panel) itself.
vi.mock("@/pages/amex", () => ({ default: (p: { lead?: ReactNode }) => { h.amexProps(p); return <div data-testid="amex-ledger">{p.lead}</div>; } }));
// (C9) The Chase page renders the host's `lead` (the Summary panel) itself.
vi.mock("@/pages/transactions", () => ({ default: (p: { lead?: ReactNode }) => { h.chaseProps(p); return <div data-testid="chase-ledger">{p.lead}</div>; } }));

import NextAccountsPage from "./Accounts";
import { buildEntries } from "./accounts/entries";
import { AccountSummary } from "./accounts/AccountSummary";
import { ForecastLegend } from "./accounts/ForecastLegend";
import { identityOf } from "@/lib/accountIdentity";

afterEach(() => { cleanup(); h.amexProps.mockClear(); h.chaseProps.mockClear(); h.extraTxns = []; });

const item = (id: string, inst: string, slug: string, accounts: object[], extra: object = {}) =>
  ({ id, itemId: id, institutionName: inst, institutionSlug: slug, accounts, lastSyncedAt: "2026-10-08T10:00:00Z", lastBankTxOn: "2026-10-07", ...extra });
const seed = () => {
  h.items = [
    item("i1", "Chase", "chase", [{ id: "r-chk", accountId: "ext-chk", name: "Total Checking", mask: "4821", type: "depository", subtype: "checking" }]),
    item("i2", "American Express", "amex", [{ id: "r-amex", accountId: "ext-amex", name: "Platinum", mask: "1005", type: "credit", subtype: "credit card" }], { lastSyncError: "x", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
  ];
  h.debts = [{ id: "d1", plaidAccountId: "r-amex", balance: "1234.50", minPayment: "35", dueDay: 14 }];
  // The API's shape: `accountId` is the external Plaid account_id, `plaidAccountId` the internal row id.
  h.payoff = { cards: [{ accountId: "ext-amex", plaidAccountId: "r-amex", weekCharges: 120, chargeCount: 3, pctOfStatementThisWeek: 10, statementBalance: 1100 }] };
  h.forecast = { bankSnapshot: { balance: "2500.00", at: "2026-10-08T09:00:00Z", source: "plaid", accountId: "r-chk" }, accountSnapshots: {}, plaidCheckingAccounts: [{ id: "r-chk", mask: "4821", institutionName: "Chase" }] };
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
    expect(within(chk).getByTestId("chip-balance").textContent).toContain("$2,500.00");
    expect(within(chk).getByTestId("chip-state").textContent).toContain("Synced");
    expect(within(chk).getByTestId("chip-through").textContent).toContain("Oct 7");
    const amex = screen.getByTestId("account-chip-ext-amex");
    expect(amex.getAttribute("data-accent")).toBe("amex");
    expect(within(amex).getByTestId("chip-balance").textContent).toContain("Owed $1,234.50");
    expect(within(amex).getByTestId("chip-state").textContent).toContain("Needs reconnect");
  });
  it("marks the selected account current and leaves 'All accounts' otherwise", () => {
    seed(); renderAt("/next/accounts/ext-amex");
    expect(screen.getByTestId("account-chip-ext-amex").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("account-chip-all").getAttribute("aria-current")).toBeNull();
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
    expect(s).toContain("$1,234.50");
    expect(s).toContain("$1,100.00");
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
  ])("matches on %s: statement balance and this week's charges show", async (_label, ids) => {
    seed();
    h.payoff = { cards: [{ ...ids, weekCharges: 120, chargeCount: 3, pctOfStatementThisWeek: 10, statementBalance: 1100 }] };
    renderAt("/next/accounts/ext-amex");
    await waitFor(() => expect(screen.getByTestId("amex-ledger")).toBeTruthy());
    const s = screen.getByTestId("account-summary").textContent!;
    expect(s).toContain("$1,100.00");
    expect(s).toContain("$120.00");
    expect(s).toContain("3 charges");
  });
  it("another card's payoff entry never lends its figures", async () => {
    seed();
    h.payoff = { cards: [{ accountId: "ext-other", plaidAccountId: "r-other", weekCharges: 120, chargeCount: 3, pctOfStatementThisWeek: 10, statementBalance: 1100 }] };
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
    expect(screen.getByTestId("account-summary").textContent).toContain("$2,500.00");
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
    ["/next/accounts/ext-chk", "chase-ledger", { accountKey: "r-chk" }, "$2,500.00"],
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

describe("blanks never become zero", () => {
  const amexId = identityOf({ id: "r", name: "Platinum", type: "credit", institutionName: "American Express", institutionSlug: "amex" });
  it("shows an em-dash for every figure the API does not carry", () => {
    const entry = { plaidAccountId: "x", rowId: "r", itemId: "i", identity: amexId, state: "synced" as const, lastSyncedAt: null, dataThrough: null };
    render(<AccountSummary entry={entry} debt={{ balance: "0", minPayment: "0" } as never} payoffCard={null} snapshot={null} />);
    const s = screen.getByTestId("account-summary").textContent!;
    expect(s).not.toContain("$0");
    expect((s.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
  it("legend uses the card's own accent for charges and payments", () => {
    render(<ForecastLegend card={identityOf({ id: "c", type: "credit", institutionName: "Citi", institutionSlug: "citi" }, { cardOrder: ["c"] })} />);
    expect(screen.getByTestId("legend-charged").getAttribute("data-accent")).toBe("card2");
  });
  it("buildEntries tolerates no items", () => { expect(buildEntries(undefined)).toEqual([]); });
});
