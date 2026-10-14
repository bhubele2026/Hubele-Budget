import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * (W7) The band is a SELECTOR that agrees with the Summary: each tile's Owed and
 * Purchases are the server's `/amex/summary` figures for the same period, never
 * the weekly-payoff model's combined balance. One id space: the external Plaid
 * account id (`hs-amex-…`), the same one the section tabs and `?card=` carry.
 */
const calls: Array<{ accountId: string; from: string; to: string }> = [];
const SUMMARY: Record<string, { owed: string | null; purchases: string }> = {
  all: { owed: "2952.85", purchases: "475.60" },
  "hs-amex-blue-2002": { owed: "612.30", purchases: "90.90" },
  "hs-amex-plat-1001": { owed: "2340.55", purchases: "384.70" },
};
vi.mock("@workspace/api-client-react/features", () => ({
  useGetAmexSummary: (p: { accountId: string; from: string; to: string }) => {
    calls.push(p);
    // (P4) ONE all-cards summary carries every card's owed + purchases.
    if (p.accountId !== "all") return { data: undefined, isError: false };
    const a = SUMMARY.all;
    const cards = Object.entries(SUMMARY)
      .filter(([k]) => k !== "all")
      .map(([accountId, c]) => ({ accountId, owed: c.owed, purchases: { amount: c.purchases, count: 1 } }));
    return { data: { owed: { current: a.owed }, purchases: { amount: a.purchases }, scope: { cards } }, isError: false };
  },
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetSettings: () => ({ data: undefined }),
  useGetAmexWeeklyPayoff: () => ({
    data: {
      combinedWeekCharges: 0,
      combinedStatementBalance: 612.3, // the old weekly model: non-debt cards only
      cards: [
        { accountId: "hs-amex-blue-2002", plaidAccountId: "row-1", debtId: null, name: "Amex Blue", brand: "blue", cadence: "monthly", periodLabel: "", displayName: null, weekCharges: 135.5, chargeCount: 3, statementBalance: 612.3, pctOfStatementThisWeek: 0.22, topMerchant: null },
      ],
      debtLinkedCards: [{ accountId: "hs-amex-plat-1001", name: "Amex Platinum", mask: "1001", debtId: "d1", brand: "silver", cadence: "weekly", displayName: null }],
    },
  }),
  getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
  getListDebtsQueryKey: () => ["/api/debts"],
}));
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => <span>add</span> }));

import { AmexCardBand } from "./amex-card-band";

afterEach(() => { cleanup(); calls.length = 0; });
const view = (selected = "all") =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AmexCardBand selected={selected} onSelect={() => undefined} period={{ from: "2026-10-11", to: "2026-10-17" }} periodLabel="Oct 11 – 17" />
    </QueryClientProvider>,
  );

describe("AmexCardBand figures (W7)", () => {
  it("All cards shows the Summary's owed and purchases, not the weekly model's combined balance", () => {
    view();
    const all = screen.getByTestId("amex-tile-all");
    expect(within(all).getByTestId("amex-owed-all").textContent).toBe("$2,952.85");
    expect(within(all).getByTestId("amex-purchases-all").textContent).toContain("$475.60");
    expect(all.textContent).not.toContain("$612.30");
    expect(all.textContent).not.toMatch(/combined/i);
  });

  it("every card tile — the debt-linked one too — shows its own owed and period purchases", () => {
    view();
    const blue = document.querySelector('[data-account-id="hs-amex-blue-2002"]') as HTMLElement;
    const plat = document.querySelector('[data-account-id="hs-amex-plat-1001"]') as HTMLElement;
    expect(within(blue).getByTestId("amex-owed-hs-amex-blue-2002").textContent).toBe("$612.30");
    expect(within(blue).getByTestId("amex-purchases-hs-amex-blue-2002").textContent).toContain("$90.90");
    expect(within(plat).getByTestId("amex-owed-hs-amex-plat-1001").textContent).toBe("$2,340.55");
    expect(within(plat).getByTestId("amex-purchases-hs-amex-plat-1001").textContent).toContain("$384.70");
  });

  it("the band asks for the Summary's own period, by the external account id; the ring is named as the weekly plan's", () => {
    view("hs-amex-blue-2002");
    expect(calls.every((c) => c.from === "2026-10-11" && c.to === "2026-10-17")).toBe(true);
    // One call, for "all": no per-card summary queries.
    expect(new Set(calls.map((c) => c.accountId))).toEqual(new Set(["all"]));
    expect(screen.getByText("cleared this wk")).toBeTruthy();
    expect(screen.getByText("add")).toBeTruthy(); // + Add to avalanche stays
    expect(document.querySelector('[data-account-id="hs-amex-blue-2002"]')!.className).toContain("ring-2");
  });
});
