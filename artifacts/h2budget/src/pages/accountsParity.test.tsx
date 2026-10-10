import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/components/plan/DebtRangePanel", () => ({ DebtRangePanel: () => null }));
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as F from "./__fixture__/accountsScenario";

/**
 * ⭐ ONE CONCEPT, ONE STRING, EVERY SURFACE (WP3, financial-consistency audit).
 *
 * Amex Platinum read "Owed $1,227.27" on the dashboard and "Current balance
 * $3,842.98" on its own page; Chase read $2,156.55 on the dashboard and
 * $3,458.98 on the account chip. Each page chose its own basis and its own
 * words. This test renders the dashboard's summary row and Accounts panel, the
 * accounts page (chips and every card's Summary), the Debts page and the
 * Avalanche page from ONE fixture (`__fixture__/accountsScenario.ts`) and
 * asserts that each concept prints the identical string wherever it appears:
 *   - Owed (netted, on the payoff plan only) — never the creditor's figure;
 *   - the card's own current balance — named, never as "Owed";
 *   - the payments not posted yet;
 *   - a real zero as $0.00; missing data as words, never $0;
 *   - an archived debt as "Archived · not on the payoff plan" while it carries a balance ("Paid off" only at $0), never in a total;
 *   - a card with no debt row as "Not on the payoff plan";
 *   - savings as its last reading, "not rolled forward";
 *   - the amount left = the Avalanche total, without the archived or off-plan cards.
 *   - checking as the spine's balance today, with its snapshot dated under it (WP1).
 */

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

vi.mock("@/hooks/useSpine", async () => {
  const fx = await import("./__fixture__/accountsScenario");
  return { useSpine: () => ({ data: fx.SPINE, isLoading: false, state: "loaded", refetch: () => {} }) };
});
vi.mock("@/hooks/use-plaid-sync", () => ({ usePlaidSync: () => ({ runSync: vi.fn(), isPending: false }) }));
vi.mock("@/components/bank-balance-why", () => ({ BankBalanceWhy: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null, DebtPlaidIndicator: () => null, DebtLastSynced: () => null, DebtPlaidSource: () => null, DebtReauthBanner: () => null,
}));
vi.mock("recharts", () => import("@/test-recharts-stub"));
// The ledgers are their own pages (tested on their own); each renders the host's Summary lead.
vi.mock("@/pages/amex", () => ({ default: (p: { lead?: ReactNode }) => <div data-testid="amex-ledger">{p.lead}</div> }));
vi.mock("@/pages/transactions", () => ({ default: (p: { lead?: ReactNode }) => <div data-testid="chase-ledger">{p.lead}</div> }));

vi.mock("@workspace/api-client-react", async (orig) => {
  const fx = await import("./__fixture__/accountsScenario");
  const noop = () => {};
  const mutation = { mutate: noop, mutateAsync: async () => undefined, isPending: false };
  const ok = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: noop });
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // Accounts (dashboard queries + accounts page)
    useListPlaidItems: () => ok(fx.ITEMS),
    useListDebts: () => ok(fx.DEBTS),
    useListPlaidLiabilityAccounts: (_p: unknown, o?: { query?: { enabled?: boolean } }) => ok(o?.query?.enabled === false ? undefined : fx.LIABILITIES),
    useGetAmexWeeklyPayoff: () => ok(fx.PAYOFF),
    useGetForecastCashSignal: () => ok(undefined),
    useGetForecastBankBalanceExplain: () => ok(undefined),
    useGetMoneyPosition: () => ok({ reservesHeld: "0.00" }),
    useListTransactions: () => ok([]),
    useListCategories: () => ok([]),
    // Debts + Avalanche pages
    useListDebtBalanceHistory: () => ok([]),
    useCreateDebt: () => mutation,
    useUpdateDebt: () => mutation,
    useDeleteDebt: () => mutation,
    useGetAvalancheSettings: () => ok({ strategy: "avalanche", manualExtra: "0", extraSource: "manual", budgetMode: "budgeted", extraBudgetCategoryId: null }),
    useUpdateAvalancheSettings: () => mutation,
    useSyncDebtMinimums: () => mutation,
    useGetAvalancheExtra: () => ok({ amount: "0", source: "manual", availableMoney: 1000 }),
    useCreateDebtPayment: () => mutation,
    useGetSettings: () => ok(undefined),
    useGetForecastAvalancheSchedule: () => ok(undefined),
    useUpdateSettings: () => mutation,
    useBulkCreateDebtsFromPlaidAccounts: () => mutation,
  };
});

import AccountsPanel from "./next/dashboard/AccountsPanel";
import SummaryRow from "./next/dashboard/SummaryRow";
import NextAccountsPage from "./next/Accounts";
import DebtsPage from "./debts";
import AvalanchePage from "./avalanche";

function renderIn(node: ReactNode, path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider><Router hook={hook}>{node}</Router></TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The dashboard row of an account, by its link (`/next/accounts/<external or internal id>`). */
function dashRow(ext: string): HTMLElement {
  const rowId = ext.replace(/^ext-/, "row-");
  const hrefs = [`/next/accounts/${ext}`, `/next/accounts/${rowId}`];
  const link = screen.getAllByTestId("dash-account-link").find((a) => hrefs.includes(a.getAttribute("href") ?? ""));
  expect(link, `no dashboard row for ${ext}`).toBeTruthy();
  return link!.closest("[data-testid='dash-account']") as HTMLElement;
}
const chip = (ext: string) => screen.getByTestId(`account-chip-${ext}`);
/** The account's Summary on its own page (a card's sits inside its lazy ledger). */
async function summaryOf(ext: string): Promise<HTMLElement> {
  cleanup();
  renderIn(<NextAccountsPage />, `/next/accounts/${ext}`);
  return screen.findByTestId("account-summary");
}
/** A cell of the Debts page row for a debt, by column header. */
function debtsCell(name: string, header: string): string {
  const row = screen.getAllByText(name).map((n) => n.closest("tr")).find(Boolean) as HTMLElement;
  const table = row.closest("table")!;
  const idx = Array.from(table.querySelectorAll("thead th")).findIndex((h) => (h.textContent ?? "").trim() === header);
  return (row.querySelectorAll(":scope > td")[idx]?.textContent ?? "").trim();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(F.NOW));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("the live case: Owed $1,227.27 = $3,842.98 reported − $2,615.71 not posted", () => {
  const E = F.EXPECT.live;
  it("dashboard row: Owed is the netted figure; the card's own balance and the pending payments sit beside it, each named", () => {
    renderIn(<AccountsPanel />);
    const row = dashRow(E.ext);
    expect(within(row).getByTestId("dash-account-balance").textContent).toBe(E.owed);
    expect(within(row).getByTestId("dash-account-creditor").textContent).toBe(`Card's current balance${E.creditor}`);
    expect(within(row).getByTestId("dash-account-pending").textContent).toBe(`Paid, not posted${E.pending}`);
  });
  it("account chip: the same Owed, never the creditor's figure", () => {
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe(`Owed ${E.owed}`);
    expect(chip(E.ext).textContent).not.toContain(E.creditor);
  });
  it("the card's Summary: the same three strings, under the same words", async () => {
    const s = await summaryOf(E.ext);
    expect(within(within(s).getByTestId("summary-owed")).getByText(E.owed)).toBeTruthy();
    expect(within(within(s).getByTestId("summary-creditor")).getByText(E.creditor)).toBeTruthy();
    expect(within(s).getByTestId("summary-creditor").textContent).toContain("Card's current balance");
    expect(within(within(s).getByTestId("summary-pending")).getByText(E.pending)).toBeTruthy();
    expect(within(s).getByTestId("summary-pending").textContent).toContain("Paid, not posted");
  });
  it("Debts and Avalanche: the same Owed in the Balance column, the same pending hint", () => {
    renderIn(<DebtsPage />);
    expect(debtsCell("Amex Platinum", "Balance")).toContain(E.owed);
    expect(screen.getByTestId(`debt-pending-${E.debtId}`).textContent).toBe(`−${E.pending} pending`);
    cleanup();
    renderIn(<AvalanchePage />);
    expect(within(screen.getByTestId(`row-debt-${E.debtId}`)).getByText(E.owed)).toBeTruthy();
    expect(screen.getByTestId(`debt-pending-${E.debtId}`).textContent).toBe(`−${E.pending} pending`);
  });
  it("the creditor's figure is never labelled Owed or Balance anywhere", () => {
    renderIn(<><SummaryRow /><AccountsPanel /></>);
    const row = dashRow(E.ext);
    expect(within(row).getByTestId("dash-account-balance").textContent).not.toBe(E.creditor);
    cleanup();
    renderIn(<DebtsPage />);
    expect(debtsCell("Amex Platinum", "Balance").startsWith(E.creditor)).toBe(false);
  });
});

describe("other card cases, one string per surface", () => {
  it("duplicate mask: each twin reads ITS OWN debt (matched by internal id, never by ••1005)", async () => {
    renderIn(<AccountsPanel />);
    expect(within(dashRow(F.EXPECT.live.ext)).getByTestId("dash-account-balance").textContent).toBe(F.EXPECT.live.owed);
    expect(within(dashRow(F.EXPECT.twin.ext)).getByTestId("dash-account-balance").textContent).toBe(F.EXPECT.twin.owed);
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(F.EXPECT.twin.ext)).getByTestId("chip-balance").textContent).toBe(`Owed ${F.EXPECT.twin.owed}`);
    expect(within(await summaryOf(F.EXPECT.twin.ext)).getByTestId("summary-owed").textContent).toContain(F.EXPECT.twin.owed);
  });
  it("zero: a real $0.00 on every surface, never a dash", async () => {
    const E = F.EXPECT.zero;
    renderIn(<AccountsPanel />);
    expect(within(dashRow(E.ext)).getByTestId("dash-account-balance").textContent).toBe(E.owed);
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe(`Owed ${E.owed}`);
    const s = await summaryOf(E.ext);
    expect(within(within(s).getByTestId("summary-owed")).getByText(E.owed)).toBeTruthy();
    expect(within(within(s).getByTestId("summary-creditor")).getByText(E.owed)).toBeTruthy();
    cleanup();
    renderIn(<DebtsPage />);
    expect(debtsCell("Amex Blue Cash", "Balance")).toBe(E.owed);
  });
  it("archived, still owing: 'Archived · not on the payoff plan' everywhere — never Owed, never 'Paid off', never in a total", async () => {
    const E = F.EXPECT.archived;
    renderIn(<AccountsPanel />);
    const row = dashRow(E.ext);
    expect(within(row).getByTestId("dash-account-plan").textContent).toBe(E.words);
    expect(within(row).queryByTestId("dash-account-balance")).toBeNull();
    expect(row.textContent).not.toContain("Owed");
    expect(within(row).getByTestId("dash-account-creditor").textContent).toBe(`Card's current balance${E.creditor}`);
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-plan").textContent).toBe(E.words);
    expect(chip(E.ext).textContent).not.toContain("Owed");
    const s = await summaryOf(E.ext);
    expect(within(s).getByTestId("summary-plan").textContent).toBe(E.words);
    expect(within(s).queryByTestId("summary-owed")).toBeNull();
    cleanup();
    // Debts: the paid-off layout, no plan balance, and the words.
    renderIn(<DebtsPage />);
    const gold = screen.getAllByTestId("debt-card-paid-off").find((r) => r.getAttribute("data-debt-id") === E.debtId)!;
    expect(within(gold).getByTestId("debt-card-paid-off-headline").textContent).toBe("Archived");
    expect(gold.textContent).not.toContain("Paid off");
    expect(within(gold).getByTestId("debt-card-paid-off-month").textContent).toBe("Not on the payoff plan");
    expect(gold.textContent).not.toContain(E.creditor);
    cleanup();
    // Avalanche: off the Debts table and out of the total, in its Archived tab.
    renderIn(<AvalanchePage />);
    expect(screen.queryByTestId(`row-debt-${E.debtId}`)).toBeNull();
    expect(screen.getByText(/Archived \(1\)/)).toBeTruthy();
  });
  it("missing mask: no ••, and still its own debt's figure", () => {
    const E = F.EXPECT.noMask;
    renderIn(<AccountsPanel />);
    const row = dashRow(E.ext);
    expect(within(row).getByTestId("dash-account-link").textContent).not.toContain("••");
    expect(within(row).getByTestId("dash-account-balance").textContent).toBe(E.owed);
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe(`Owed ${E.owed}`);
  });
  it("off-plan: Plaid's stored figure as the card's own balance, 'Not on the payoff plan' on every surface", async () => {
    const E = F.EXPECT.offPlan;
    renderIn(<AccountsPanel />);
    const row = dashRow(E.ext);
    expect(within(row).getByTestId("dash-account-plan").textContent).toBe(E.words);
    expect(within(row).getByTestId("dash-account-creditor").textContent).toBe(`Card's current balance${E.creditor}`);
    expect(row.textContent).not.toContain("Owed");
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe(`Card's current balance ${E.creditor}`);
    expect(within(chip(E.ext)).getByTestId("chip-plan").textContent).toBe(E.words);
    const s = await summaryOf(E.ext);
    expect(within(s).getByTestId("summary-plan").textContent).toBe(E.words);
    expect(within(within(s).getByTestId("summary-creditor")).getByText(E.creditor)).toBeTruthy();
    expect(within(s).queryByTestId("summary-owed")).toBeNull();
  });
  it("missing: words on the dashboard, dashes on the Summary, never $0", async () => {
    const E = F.EXPECT.missing;
    renderIn(<AccountsPanel />);
    const row = dashRow(E.ext);
    expect(within(row).getByTestId("dash-account-nodebt").textContent).toBe(E.words);
    expect(row.textContent).not.toContain("$0");
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe("—");
    expect(chip(E.ext).textContent).not.toContain("$0");
    const s = await summaryOf(E.ext);
    expect(s.textContent).not.toContain("$0");
    expect(within(within(s).getByTestId("summary-creditor")).getByText("—")).toBeTruthy();
  });
  it("stale: the figure stays, the row says out of date, and the stamps say how old", () => {
    const E = F.EXPECT.stale;
    renderIn(<AccountsPanel />);
    const row = dashRow(E.ext);
    expect(within(row).getByTestId("dash-account-balance").textContent).toBe(E.owed);
    expect(within(row).getByTestId("dash-account-state").textContent).toBe("Out of date");
    expect(within(row).getByTestId("dash-account-stamps").textContent).toBe(" · synced 3 d ago · balance read 3 d ago · data through Oct 5");
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe(`Owed ${E.owed}`);
    expect(within(chip(E.ext)).getByTestId("chip-stamps").textContent).toBe("synced 3 d ago · balance read 3 d ago · data through Oct 5");
  });
});

describe("savings: the last reading, not rolled forward — or words", () => {
  it("the same line on the dashboard and the chip; the Summary splits it into figure and caption", async () => {
    const E = F.EXPECT.savings;
    renderIn(<AccountsPanel />);
    expect(within(dashRow(E.ext)).getByTestId("dash-account-snapshot").textContent).toBe(E.line);
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe(E.line);
    const s = await summaryOf(E.ext);
    const block = within(s).getByTestId("summary-snapshot");
    expect(within(block).getByText(E.figure)).toBeTruthy();
    expect(block.textContent).toContain(E.caption);
    expect(s.textContent).not.toContain("Balance today");
  });
  it("no reading: words on every surface, never $0", async () => {
    const E = F.EXPECT.savingsNone;
    renderIn(<AccountsPanel />);
    expect(within(dashRow(E.ext)).getByTestId("dash-account-nobalance").textContent).toBe(E.words);
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe(E.words);
    expect(within(await summaryOf(E.ext)).getByTestId("summary-not-tracked").textContent).toBe(E.words);
  });
});

describe("the amount left: one total, the same scope", () => {
  it("the dashboard's \"$X left on your payoff plan (…)\" = the Avalanche total, without the archived or off-plan cards", () => {
    renderIn(<SummaryRow />);
    expect(screen.getByTestId("dash-debt-left").textContent).toBe(`${F.EXPECT.left} left on your payoff plan (${F.EXPECT.leftNames})`);
    cleanup();
    renderIn(<AvalanchePage />);
    const totals = screen.getByText("Totals").closest("tr")!;
    expect((totals.querySelectorAll("td")[1]?.textContent ?? "").trim()).toBe(F.EXPECT.left);
  });
});

describe("(WP4) the tile names exactly the cards its total leaves out", () => {
  it("the off-plan line names the archived and off-plan cards the rows mark, and nothing on the plan", () => {
    renderIn(<><SummaryRow /><AccountsPanel /></>);
    expect(screen.getByTestId("dash-debt-offplan").textContent).toBe(`${F.EXPECT.offPlanLine} · Put them on the plan`);
    for (const ext of [F.EXPECT.archived.ext, F.EXPECT.offPlan.ext, F.EXPECT.missing.ext]) {
      expect(within(dashRow(ext)).getByTestId("dash-account-add-plan").getAttribute("href")).toBe("/avalanche");
    }
    for (const ext of [F.EXPECT.live.ext, F.EXPECT.twin.ext, F.EXPECT.zero.ext, F.EXPECT.noMask.ext, F.EXPECT.stale.ext]) {
      expect(within(dashRow(ext)).queryByTestId("dash-account-add-plan")).toBeNull();
    }
  });
});

describe("freshness: three stamps, and 'data through' is a data date", () => {
  it("the dashboard row and the chip print the same stamps for the same account", () => {
    const ext = F.EXPECT.live.ext;
    renderIn(<AccountsPanel />);
    const dash = within(dashRow(ext)).getByTestId("dash-account-stamps").textContent!;
    expect(dash).toBe(" · synced 3 h ago · balance read 4 h ago · data through Oct 8");
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(` · ${within(chip(ext)).getByTestId("chip-stamps").textContent}`).toBe(dash);
  });
});

describe("checking: the spine's account, by id — the balance today and the snapshot under it (WP1 + WP3)", () => {
  const E = F.EXPECT.checking;
  it("the summary row, the dashboard row, the chip and the Summary print the same balance and the same snapshot words", async () => {
    renderIn(<><SummaryRow /><AccountsPanel /></>);
    expect(screen.getByTestId("dash-kpi-checking-value").textContent).toBe(E.balance);
    expect(screen.getByTestId("dash-since-snapshot").textContent).toBe(E.since);
    expect(within(dashRow(E.ext)).getByTestId("dash-account-balance").textContent).toBe(E.balance);
    cleanup();
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).toBe(`Balance ${E.balance}`);
    expect(within(chip(E.ext)).getByTestId("chip-snapshot").textContent).toBe(E.snapshotLine);
    const s = await summaryOf(E.ext);
    const today = within(s).getByTestId("summary-balance");
    expect(within(today).getByText(E.balance)).toBeTruthy();
    expect(today.textContent).toContain(E.since);
    const snap = within(s).getByTestId("summary-bank-snapshot");
    expect(within(snap).getByText(E.snapshot)).toBeTruthy();
    expect(snap.textContent).toContain(E.caption);
  });
  it("the raw snapshot is never shown as the balance", async () => {
    renderIn(<NextAccountsPage />, "/next/accounts");
    expect(within(chip(E.ext)).getByTestId("chip-balance").textContent).not.toContain(E.snapshot);
    const s = await summaryOf(E.ext);
    expect(within(s).getByTestId("summary-balance").textContent).not.toContain(E.snapshot);
  });
});
