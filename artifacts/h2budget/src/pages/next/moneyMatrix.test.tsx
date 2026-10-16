import React, { Suspense } from "react";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeHouseholdApi, type FakeChecking, type FakeHouseholdApi, type FakeHouseholdOptions } from "../__test-helpers__/fakeHouseholdApi";
import { resetDataAsOf } from "@/lib/dataAsOf";

/**
 * ⭐ (Task 6) THE CROSS-MEASURE MATRIX — like with like, from ONE fake household.
 *
 * The pairs no other render test held together (Checking today and Overview ⇄ detail are
 * `balanceConsistency.test.tsx`'s; the debt pairs are `debtBalanceParity.test.tsx`'s):
 *   - the week: the dashboard's week tile and Banking's household block quote ONE position —
 *     "Counts toward plan" and "Unconfirmed" are the same figures, and "Plan not set" is never $0;
 *   - the forecast low point at 90 days: the dashboard's Forecast tile, the detail's KPI and the
 *     Overview's stat quote one figure on one day, and the tile opens that day.
 * Synthetic household and amounts.
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
import ForecastOverviewPage from "../forecast-overview";

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


const READ = { balance: "120.00", at: READ_AT, source: "plaid" as const };

describe("(Task 6) the week — the dashboard tile and Banking's household block are one position", () => {
  const WEEK: FakeChecking = {
    reading: READ,
    today: "84.50",
    cashBuffer: "500.00",
    week: { start: "2026-10-11", end: "2026-10-17", known: "324.50", unresolved: "861.37", provisional: true, cap: null },
  };

  it("Counts toward plan $324.50 and Unconfirmed $861.37 on both; no weekly plan reads 'Not set', never $0", async () => {
    serve(WEEK);
    at("/", <Tiles />);
    await waitFor(() => expect(screen.getByTestId("tile-week-spent").textContent).toContain("$324.50"));
    const tile = screen.getByTestId("tile-week");
    expect(tile.textContent).toContain("Counts toward plan");
    expect(screen.getByTestId("tile-week-provisional").textContent).toBe("Unconfirmed $861.37 may change this");
    expect(within(tile).queryByText("$0.00")).toBeNull();
    cleanup(); qc.clear();

    at("/banking", <BankingReviewPage />);
    await waitFor(() => expect(screen.getByTestId("br-hh-spent").textContent).toBe("$324.50"));
    const box = screen.getByTestId("br-household");
    expect(box.textContent).toContain("Counts toward plan");
    expect(screen.getByTestId("br-hh-unconfirmed").textContent).toBe("$861.37");
    expect(screen.getByTestId("br-hh-plan").textContent).toBe("Not set");
    // The cautious total is named as such, the sum of the two.
    expect(screen.getByTestId("br-hh-cautious").textContent).toBe("Cautious total (includes unconfirmed) $1,185.87");
  });
});

describe("(Task 6) the forecast low point at 90 days — dashboard tile = detail KPI = Overview stat", () => {
  const LOW: FakeChecking = { reading: READ, today: "84.50", cashBuffer: "500.00", lowPoint: { value: "-40.00", date: "2026-10-22" } };

  it("one figure, one day; the tile opens that day at 90 days", async () => {
    serve(LOW);
    at("/", <Tiles />);
    await waitFor(() => expect(screen.getByTestId("tile-forecast-low").textContent).toContain("-$40.00"));
    expect(screen.getByTestId("tile-forecast").textContent).toContain("Lowest point");
    expect(screen.getByTestId("tile-forecast-shortfall").textContent).toBe("Review shortfall →");
    expect(screen.getByTestId("tile-forecast-link").getAttribute("href")).toBe("/forecast?horizon=90&day=2026-10-22");
    expect(screen.getByTestId("tile-forecast-status").textContent).toBe("Below zero on Oct 22");
    cleanup(); qc.clear();

    at("/forecast?horizon=90", <ForecastPage />);
    const kpi = await screen.findByTestId("kpi-lowest-point", undefined, { timeout: 3000 });
    expect(kpi.textContent).toContain("-$40.00");
    expect(kpi.textContent).toContain("Below zero on Oct 22");
    cleanup(); qc.clear();

    at("/forecast/overview?horizon=90", <ForecastOverviewPage />);
    await waitFor(() => expect(screen.getByTestId("fo-stat-low-point").textContent).toContain("-$40.00"));
    expect(screen.getByTestId("fo-stat-low-point").textContent).toContain("Below zero on Oct 22");
  });
});
