import React from "react";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeHouseholdApi,
  type FakeAccount,
  type FakeHouseholdOptions,
  type FakeHouseholdRow,
} from "../__test-helpers__/fakeHouseholdApi";

/**
 * ⭐ (WP8b) A CARD'S PAGE RUNS ON THE CARD'S OWN CURRENT BALANCE — for a card
 * from any bank, not only Amex.
 *
 * Through the REAL account page and the REAL embedded card ledger (the Amex
 * page), on the real hooks, answered at the fetch level. A Chase Freedom (a card
 * outside the Amex set) with Plaid's stored liability balance: its rows' "bal"
 * start from that figure — the one the Summary prints as "Card's current
 * balance" — and the forward chart draws. A Citi card with no figure: no "bal"
 * on any row, no chart, and words in the pane. Before the fix the per-card
 * anchor answered `missing` outside the Amex set, the page anchored at $0
 * ("Calculated"), and both cards showed "bal" from $0 and a chart.
 */

vi.mock("recharts", () => import("@/test-recharts-stub"));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useReviewInboxCount", () => ({ useReviewInboxCount: () => 0 }));
vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({ offerBulkRecategorize: vi.fn(), previewDialog: null }),
}));
vi.mock("@/lib/useRuleActionUndo", () => ({ useRuleActionUndo: () => vi.fn() }));
vi.mock("@/components/plaid-reauth-banner", async (orig) => ({
  ...(await orig<object>()),
  PlaidReauthBanner: () => null,
  PlaidReauthBannerView: () => null,
}));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/plaid-link-button", () => ({ PlaidLinkButton: () => null }));
vi.mock("@/components/post-link-progress", () => ({ PostLinkProgressBanner: () => null }));
vi.mock("@/components/chase-insight-strip", () => ({ ChaseInsightStrip: () => null }));
// The chart draws only with a window (the real component returns null without
// one and with no trailing data): a marker stands in for the drawing.
vi.mock("@/components/account-page/balance-trend-chart", async () => {
  const R = await import("react");
  return {
    BalanceTrendChart: (p: { window?: unknown }) =>
      p.window ? R.createElement("div", { "data-testid": "card-balance-trend" }) : null,
  };
});
vi.mock("@/components/merchant-rename-popover", () => ({ MerchantRenamePopover: () => null }));
vi.mock("@/components/category-picker", () => ({ CategoryPicker: () => null, defaultRememberPattern: (s: string) => s }));
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));
vi.mock("@/components/matched-rule-chip", () => ({ MatchedRuleChip: () => null }));
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => null }));

import NextAccountsPage from "./Accounts";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

// Wednesday 2026-09-16, noon UTC (07:00 in Chicago).
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});
const TODAY = "2026-09-16";

const acct = (key: string, item: string, name: string, mask: string, type: FakeAccount["type"], subtype: string): FakeAccount => ({
  key, id: `row-${key}`, accountId: `ext-${key}`, item, name, mask, type, subtype,
});
const row = (id: string, o: Partial<FakeHouseholdRow> & Pick<FakeHouseholdRow, "account" | "source">): FakeHouseholdRow => ({
  id,
  occurredOn: "2026-09-15",
  description: id.toUpperCase(),
  amount: "-10.00",
  ...o,
});

const HOUSEHOLD: FakeHouseholdOptions = {
  today: TODAY,
  items: [
    { id: "it-chase", institutionName: "Chase", institutionSlug: "chase" },
    { id: "it-citi", institutionName: "Citi", institutionSlug: "citi" },
  ],
  accounts: [
    acct("chk", "it-chase", "Total Checking", "5526", "depository", "checking"),
    acct("freedom", "it-chase", "Freedom Unlimited", "4417", "credit", "credit card"),
    acct("citi", "it-citi", "Double Cash", "6620", "credit", "credit card"),
  ],
  rows: [
    row("tx-chk", { account: "chk", source: "plaid:chase" }),
    // Dated before Plaid's figure was read (09-16 06:00 CT), so the month ends on it.
    row("tx-freedom-new", { account: "freedom", source: "plaid:chase", occurredOn: "2026-09-15", amount: "-14.82" }),
    row("tx-freedom-old", { account: "freedom", source: "plaid:chase", occurredOn: "2026-09-14", amount: "-30.00" }),
    row("tx-citi-new", { account: "citi", source: "plaid:citi", occurredOn: "2026-09-15", amount: "-22.40" }),
    row("tx-citi-old", { account: "citi", source: "plaid:citi", occurredOn: "2026-09-14", amount: "-8.10" }),
  ],
  snapshotAccount: "chk",
  balanceToday: "4812.37",
  cardBalances: { freedom: { balance: "512.34", lastFetchedAt: "2026-09-16T11:00:00.000Z" } },
};

let qc: QueryClient;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  vi.stubGlobal("fetch", createFakeHouseholdApi(HOUSEHOLD).fetch);
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

function at(path: string) {
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <NextAccountsPage />
      </Router>
    </QueryClientProvider>,
  );
}

describe("(WP8b) a card outside the Amex set, on its own page", () => {
  it("with Plaid's figure: the rows' bal start from it — the Summary's 'Card's current balance' — and the chart draws", async () => {
    at("/next/accounts/ext-freedom");
    await screen.findByTestId("row-amex-tx-freedom-new");
    const summary = await screen.findByTestId("summary-creditor");
    await waitFor(() => expect(within(summary).getByText("$512.34")).toBeTruthy());
    // The newest row carries the card's current balance; the one before it, that less the newer charge.
    await waitFor(() => expect(screen.getByTestId("text-running-balance-tx-freedom-new").textContent).toBe("bal $512.34"));
    expect(screen.getByTestId("text-running-balance-tx-freedom-old").textContent).toBe("bal $527.16");
    expect(screen.getByTestId("card-balance-trend")).toBeTruthy();
    expect(screen.getByTestId("amex-anchor-note").textContent).toBe(
      "Running balances start from the card's current balance, $512.34 as of Sep 16.",
    );
    expect(screen.queryByTestId("amex-trend-cap")).toBeNull();
  });

  it("with no figure at all: no bal on any row, no chart, and the pane says why — never a running sum from $0", async () => {
    at("/next/accounts/ext-citi");
    await screen.findByTestId("row-amex-tx-citi-new");
    await waitFor(() =>
      expect(screen.getByTestId("amex-anchor-note").textContent).toBe(
        "No running balance or chart: this card has not reported a current balance yet.",
      ),
    );
    expect(screen.queryAllByTestId(/^text-running-balance-/)).toHaveLength(0);
    expect(screen.queryByTestId("card-balance-trend")).toBeNull();
    // The Summary has no figure either: a dash, never $0.00.
    expect(within(screen.getByTestId("summary-creditor")).queryByText("$0.00")).toBeNull();
  });
});

describe("(WP8b) the trend read discloses its cap", () => {
  it("when the 12-month read comes back full (5,000 rows), the pane says the oldest are left out", async () => {
    vi.unstubAllGlobals();
    // 5,000 earlier charges on the card, Oct 2025 – Aug 2026, plus this month's two.
    const older: FakeHouseholdRow[] = Array.from({ length: 5000 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 9, 1) + (i % 330) * 86_400_000).toISOString().slice(0, 10);
      return row(`tx-old-${i}`, { account: "freedom", source: "plaid:chase", occurredOn: d, amount: "-1.00" });
    });
    vi.stubGlobal("fetch", createFakeHouseholdApi({ ...HOUSEHOLD, rows: [...HOUSEHOLD.rows, ...older] }).fetch);
    at("/next/accounts/ext-freedom");
    await screen.findByTestId("row-amex-tx-freedom-new");
    await waitFor(() =>
      expect(screen.getByTestId("amex-trend-cap").textContent).toBe(
        "Only the most recent 5,000 rows feed the chart and earlier months' running balances.",
      ),
    );
    expect(screen.queryByTestId("amex-month-cap")).toBeNull();
  });
});
