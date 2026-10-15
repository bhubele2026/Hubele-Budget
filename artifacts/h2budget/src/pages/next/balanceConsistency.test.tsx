import React, { Suspense } from "react";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeHouseholdApi, type FakeChecking, type FakeHouseholdApi, type FakeHouseholdOptions } from "../__test-helpers__/fakeHouseholdApi";
import { resetDataAsOf } from "@/lib/dataAsOf";

/**
 * ⭐ (T1) ONE CHECKING BALANCE, EVERY SURFACE — from ONE fake household.
 *
 * The owner keeps $0.00 in checking on purpose. Pages used to disagree: the
 * dashboard and Banking said $0.00 while the Forecast card said yesterday's
 * reading. Here the same fake answers every endpoint (spine, banking review,
 * forecast bundle and cash signal, the Chase ledger), and each surface is
 * rendered on the REAL generated hooks:
 *
 *   Dashboard Banking tile · Banking (H2 balance + reading + check) · Chase
 *   register · Accounts chip · Forecast card + "Checking today" KPI
 *
 * Each shows $0.00 (a real zero, never a dash, never rust), the reading's day
 * where it says "as of", and the bank's own reading named as evidence once —
 * never under a "today" label. Synthetic household and amounts.
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
vi.mock("@/components/account-page/balance-trend-chart", () => ({ BalanceTrendChart: () => null }));
vi.mock("@/components/merchant-rename-popover", () => ({ MerchantRenamePopover: () => null }));
vi.mock("@/components/category-picker", () => ({ CategoryPicker: () => null, defaultRememberPattern: (s: string) => s }));
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));
vi.mock("@/components/matched-rule-chip", () => ({ MatchedRuleChip: () => null }));
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => null }));
vi.mock("@/pages/banking/ProposedFixes", () => ({ ProposedFixes: () => null }));
vi.mock("@/components/avalanche-schedule-card", () => ({ AvalancheScheduleCard: () => null }));

import Tiles from "./dashboard/Tiles";
import BankingReviewPage from "../command-center";
import NextAccountsPage from "./Accounts";
import TransactionsPage from "../transactions";
import ForecastPage from "../forecast";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

// Thursday 2026-10-15, 09:00 in Chicago. The bank was read at 7:02 AM.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date("2026-10-15T14:00:00.000Z"));
afterAll(() => {
  vi.useRealTimers();
});

const READ_AT = "2026-10-15T12:02:00.000Z"; // Oct 15, 7:02 AM Chicago

function household(checking: FakeChecking): FakeHouseholdOptions {
  return {
    today: "2026-10-15",
    items: [{ id: "item-bank", institutionName: "Sample Bank", institutionSlug: "chase" }],
    accounts: [
      { key: "chk", id: "r-chk", accountId: "ext-chk", item: "item-bank", name: "Everyday Checking", mask: "0001", type: "depository", subtype: "checking" },
    ],
    rows: [],
    snapshotAccount: "chk",
    checking,
  };
}

let qc: QueryClient;
let api: FakeHouseholdApi;
function serve(checking: FakeChecking) {
  api = createFakeHouseholdApi(household(checking));
  vi.stubGlobal("fetch", api.fetch);
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  resetDataAsOf();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

function at(path: string, el: React.ReactElement) {
  window.history.replaceState(null, "", path);
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <Suspense fallback={null}>{el}</Suspense>
      </Router>
    </QueryClientProvider>,
  );
}

const ZERO: FakeChecking = {
  reading: { balance: "0.00", at: READ_AT, source: "plaid" },
  check: {
    status: "matches", reason: null, stale: false, staleReason: null, checkedAt: READ_AT,
    bank: { balance: "0.00", at: READ_AT, field: "available" }, h2: { balance: "0.00" }, difference: "0.00", direction: null, lastDrift: null,
  },
  cashBuffer: "500.00",
};
const RUST = /text-bad|text-bad-ink/;
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("⭐ (H1) the bank holds exactly $0.00 — every surface says $0.00, as of the reading, never rust", () => {
  it("Dashboard: the Banking tile", async () => {
    serve(ZERO);
    at("/", <Tiles />);
    const fig = await screen.findByTestId("tile-banking-balance");
    await waitFor(() => expect(fig.textContent).toBe("$0.00"));
    expect(fig.className).not.toMatch(RUST);
    // The check's words are Banking's own.
    expect((await screen.findByTestId("tile-banking-check")).textContent).toBe("Balances match");
    // The low point at $0.00 is under the $500 buffer: quiet, never rust.
    expect(screen.getByTestId("tile-forecast-status").textContent).toBe("Under the $500 buffer");
    expect(screen.getByTestId("tile-forecast-status").getAttribute("data-tone")).toBe("neutral");
  });

  it("Banking: H2 balance $0.00 · as of Oct 15 · the bank's last reading, once; the check matches", async () => {
    serve(ZERO);
    at("/banking", <BankingReviewPage />);
    const bal = await screen.findByTestId("br-balance");
    expect(bal.textContent).toBe("$0.00");
    expect(bal.className).not.toMatch(RUST);
    expect(screen.getByTestId("br-balance-asof").textContent).toBe("as of Oct 15");
    expect(screen.getByTestId("br-bank-today").textContent).toBe("Bank's last reading $0.00 · Oct 15, 7:02 AM");
    expect(count(screen.getByTestId("br-summary").textContent ?? "", "Bank's last reading")).toBe(1);
    expect(screen.getByTestId("br-tie").textContent).toBe("Balances match");
  });

  it("Chase: the register's balance is the same $0.00", async () => {
    serve(ZERO);
    at("/transactions", <TransactionsPage />);
    const panel = await screen.findByTestId("chase-stats-balance");
    await waitFor(() => expect(panel.textContent).toContain("$0.00"));
    expect(panel.textContent).not.toContain("—");
  });

  it("Accounts: the checking chip says Balance $0.00 and names the bank's reading under it", async () => {
    serve(ZERO);
    at("/next/accounts", <NextAccountsPage />);
    await waitFor(() => expect(screen.getAllByTestId("chip-balance").length).toBeGreaterThan(0));
    const chip = screen.getAllByTestId("chip-balance")[0]!.closest("[data-testid^='account-chip']") ?? document.body;
    await waitFor(() => expect(within(chip as HTMLElement).getByTestId("chip-balance").textContent).toBe("Balance $0.00"));
    expect(within(chip as HTMLElement).getByTestId("chip-snapshot").textContent).toBe("Bank's last reading $0.00 · Oct 15");
  });

  it("Forecast: the card is 'Checking today' $0.00 (not the raw reading) and the KPI says the same, as of Oct 15", async () => {
    serve(ZERO);
    at("/forecast", <ForecastPage />);
    const card = await screen.findByTestId("text-bank-balance", undefined, { timeout: 3000 });
    expect(card.textContent).toBe("$0.00");
    expect(screen.getByTestId("card-bank-snapshot").textContent).toContain("Checking today");
    expect(screen.getByTestId("text-bank-reading").textContent).toBe("Bank's last reading $0.00 · Everyday Checking ••0001 · Oct 15, 7:02 AM");
    const kpi = screen.getByTestId("kpi-bank-today");
    expect(kpi.textContent).toContain("Checking today");
    expect(kpi.textContent).toContain("$0.00");
    expect(kpi.textContent).toContain("as of Oct 15");
    // The typed-balance control is gone: the bank's reading is the only source.
    expect(screen.queryByTestId("button-set-bank-snapshot")).toBeNull();
    expect(screen.queryByText("Set manually")).toBeNull();
  });
});

describe("(H5) today's balance differs from the reading (rows since): every surface quotes the SAME balance today, the reading only as evidence", () => {
  const ROLLED: FakeChecking = { reading: { balance: "120.00", at: READ_AT, source: "plaid" }, today: "84.50", cashBuffer: "0.00" };

  it("Banking and the Forecast card agree on $84.50 today; $120.00 is named as the bank's reading", async () => {
    serve(ROLLED);
    at("/banking", <BankingReviewPage />);
    expect((await screen.findByTestId("br-balance")).textContent).toBe("$84.50");
    expect(screen.getByTestId("br-bank-today").textContent).toBe("Bank's last reading $120.00 · Oct 15, 7:02 AM");
    cleanup();
    qc.clear();
    at("/forecast", <ForecastPage />);
    expect((await screen.findByTestId("text-bank-balance", undefined, { timeout: 3000 })).textContent).toBe("$84.50");
    expect(screen.getByTestId("kpi-bank-today").textContent).toContain("$84.50");
    // The raw reading is never under the "today" title.
    expect(screen.getByTestId("text-bank-reading").textContent).toContain("Bank's last reading $120.00");
  });

  it("the Dashboard tile quotes $84.50 too", async () => {
    serve(ROLLED);
    at("/", <Tiles />);
    const fig = await screen.findByTestId("tile-banking-balance");
    await waitFor(() => expect(fig.textContent).toBe("$84.50"));
  });
});

describe("(H3) the owner's stored $432.00 difference, after the Sync re-anchored to $0.00", () => {
  const OWNER: FakeChecking = {
    reading: { balance: "0.00", at: READ_AT, source: "plaid" },
    check: {
      status: "off_by", reason: null, stale: false, staleReason: null, checkedAt: READ_AT,
      bank: { balance: "0.00", at: READ_AT, field: "available" }, h2: { balance: "432.00" }, difference: "432.00", direction: "bank_lower", lastDrift: null,
    },
  };

  it("Banking: $0.00 today, the agreement said, the check's own difference, Review difference; the tile says the same chip", async () => {
    serve(OWNER);
    at("/banking", <BankingReviewPage />);
    expect((await screen.findByTestId("br-balance")).textContent).toBe("$0.00");
    expect(screen.getByTestId("br-tie").textContent).toBe("Difference needs review");
    expect(screen.getByTestId("br-check-agree").textContent).toBe("Today H2 $0.00 and the bank $0.00 agree.");
    expect(screen.getByTestId("br-check-line").textContent).toBe("At the last check (Oct 15) the bank was $432.00 lower than H2 expected.");
    expect(screen.getByTestId("br-review-difference").textContent).toBe("Review difference");
    cleanup();
    qc.clear();
    at("/", <Tiles />);
    expect((await screen.findByTestId("tile-banking-check")).textContent).toBe("Difference needs review");
    // The balance itself is still a plain $0.00.
    expect(screen.getByTestId("tile-banking-balance").className).not.toMatch(RUST);
  });
});

describe("(H4) a typed $0.00 replaced an older bank reading", () => {
  const TYPED: FakeChecking = {
    reading: { balance: "0.00", at: READ_AT, source: "manual" },
    check: {
      status: "matches", reason: null, stale: true, staleReason: "anchor_changed", checkedAt: "2026-10-14T13:00:00.000Z",
      bank: { balance: "432.00", at: "2026-10-14T13:00:00.000Z", field: "available" }, h2: { balance: "432.00" }, difference: "0.00", direction: null, lastDrift: null,
    },
  };

  it("Banking and Forecast say 'Typed balance (not from the bank)'; the check is out of date", async () => {
    serve(TYPED);
    at("/banking", <BankingReviewPage />);
    expect((await screen.findByTestId("br-bank-today")).textContent).toBe("Typed balance $0.00 (not from the bank) · Oct 15");
    expect(screen.getByTestId("br-tie").textContent).toBe("Check is out of date");
    expect(screen.getByTestId("br-check-line").textContent).toBe("A balance was typed in since the last check (Oct 14).");
    cleanup();
    qc.clear();
    at("/forecast", <ForecastPage />);
    await screen.findByTestId("text-bank-balance", undefined, { timeout: 3000 });
    expect(screen.getByTestId("text-bank-reading").textContent).toBe("Typed balance $0.00 (not from the bank) · Everyday Checking ••0001 · Oct 15");
    // Never named as the bank's reading.
    expect(screen.getByTestId("card-bank-snapshot").textContent).not.toContain("Bank's last reading");
  });
});
