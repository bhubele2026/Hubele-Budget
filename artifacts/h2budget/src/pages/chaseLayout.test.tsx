import React from "react";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, afterAll, it, expect, vi, describe } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerOptions,
} from "./__test-helpers__/fakeLedgerServer";

/**
 * (C9) The Chase page on the panel grid — composition only; every figure and
 * handler is pinned by the other `chase*` tests, which this restyle left
 * unchanged.
 *
 * - Head: the page title stays an h1 "Chase" (e2e finds it by role), with the
 *   account's chip (accent, name, ••mask) under it.
 * - The two range figures are checking-accent panels side by side (span-6),
 *   or span-4 beside a host's `lead` panel on `/next/accounts/:id`.
 * - The ledger is ONE sticky-safe panel whose pinned pane holds the review
 *   controls; the day groups are flush sections of it; the bulk bar sticks
 *   under the pane via `--page-sticky-top`.
 * - Rows are the real shared row: the card column names the source and the
 *   account's digits, with the checking accent dot.
 */

const state = vi.hoisted(() => ({
  empty: [] as any[],
  forecast: undefined as unknown,
}));
vi.mock("@workspace/api-client-react", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const real = new Set([
    "useGetTransactionsLedgerInfinite",
    "useGetTransactionsBalances",
    "useBulkUpdateTransactions",
    "useBulkReviewMatchingTransactions",
    "useGetUiPreferences",
    "useUpdateUiPreferences",
  ]);
  const hooks = Object.fromEntries(
    Object.keys(actual)
      .filter((k) => /^use[A-Z]/.test(k) && !real.has(k))
      .map((k) => [
        k,
        () => ({
          data: undefined,
          isLoading: false,
          isPending: false,
          mutate: vi.fn(),
          mutateAsync: vi.fn(),
        }),
      ]),
  );
  return {
    ...actual,
    ...hooks,
    useListTransactions: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
    useListCategories: () => ({ data: state.empty }),
    useListMappingRules: () => ({ data: state.empty }),
    useListPlaidItems: () => ({ data: state.empty }),
    useGetForecast: () => ({ data: state.forecast, isError: false }),
    useGetSpine: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() }),
  };
});
vi.mock("wouter", () => ({
  Link: ({ children, ...rest }: any) => <a data-testid={rest["data-testid"]}>{children}</a>,
  useLocation: () => ["/transactions", vi.fn()],
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useReviewInboxCount", () => ({ useReviewInboxCount: () => 3 }));
vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({ offerBulkRecategorize: vi.fn(), previewDialog: null }),
}));
vi.mock("@/lib/useRuleActionUndo", () => ({ useRuleActionUndo: () => vi.fn() }));
vi.mock("@/components/plaid-reauth-banner", () => ({ PlaidReauthBanner: () => null }));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => <button>Sync</button> }));
vi.mock("@/components/plaid-link-button", () => ({ PlaidLinkButton: () => null }));
vi.mock("@/components/post-link-progress", () => ({ PostLinkProgressBanner: () => null }));
vi.mock("@/components/chase-insight-strip", () => ({
  ChaseInsightStrip: () => <section data-testid="chase-insight-strip" />,
}));
vi.mock("@/components/account-page/balance-trend-chart", () => ({ BalanceTrendChart: () => null }));
vi.mock("@/components/merchant-rename-popover", () => ({ MerchantRenamePopover: () => null }));
import TransactionsPage from "./transactions";

// Wednesday 2026-09-16 (07:00 in Chicago): this week is Sun 09-13 – Sat 09-19.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});

const CHECKING = {
  id: "acct-chk",
  accountId: "ext-chk",
  institutionName: "Chase",
  name: "Total Checking",
  mask: "5526",
  subtype: "checking",
};
const FORECAST = {
  bankSnapshot: {
    balance: "1000",
    at: "2026-09-16T06:00:00.000Z",
    source: "plaid",
    accountId: "acct-chk",
    name: "Total Checking",
    mask: "5526",
  },
  accountSnapshots: {},
  resolutions: [],
  plaidCheckingAccounts: [CHECKING],
  today: "2026-09-16",
};
const ROWS: FakeLedgerOptions["rows"] = [
  { id: "t1", occurredOn: "2026-09-16", description: "GROCER", amount: "-40.00", source: "plaid:chase", plaidAccountId: "ext-chk" },
  { id: "t2", occurredOn: "2026-09-15", description: "PAYROLL", amount: "900.00", source: "plaid:chase", plaidAccountId: "ext-chk" },
  { id: "m1", occurredOn: "2026-09-14", description: "CASH GIFT", amount: "25.00", source: "manual" },
];

let qc: QueryClient;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/transactions");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.forecast = FORECAST;
  const server = createFakeLedgerServer({
    rows: ROWS,
    balanceStart: "500.00",
    balanceEnd: "1000.00",
    balanceToday: "1000.00",
  });
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

function show(props: React.ComponentProps<typeof TransactionsPage> = {}) {
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage {...props} />
    </QueryClientProvider>,
  );
}
async function ready() {
  await waitFor(() => expect(screen.getByTestId("row-tx-t1")).toBeTruthy());
}

describe("Chase page — the panel grid (C9)", () => {
  it("head: an h1 'Chase' with the account's chip under it, actions beside", async () => {
    show();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: /^chase$/i })).toBeTruthy();
    const chip = screen.getByTestId("account-head-identity");
    expect(chip.textContent).toContain("Chase Total Checking");
    expect(chip.textContent).toContain("••5526");
    expect(chip.querySelector('[data-accent="checking"]')).toBeTruthy();
    expect(screen.getByTestId("button-add-transaction")).toBeTruthy();
    expect(screen.queryByTestId("chase-embedded-actions")).toBeNull();
  });

  it("figures: two checking-accent panels side by side, then the household strip with no account accent", async () => {
    show();
    await ready();
    for (const id of ["chase-stats-in-out", "chase-stats-balance"]) {
      const p = screen.getByTestId(id);
      expect(p.tagName).toBe("SECTION");
      for (const c of ["panel", "span-6", "panel-accent-checking"]) expect(p.className).toContain(c);
    }
    const strip = screen.getByTestId("chase-insight-strip").parentElement!;
    expect(strip.className).toContain("span-12");
    expect(strip.className).not.toContain("panel-accent");
    // The controls row carries the Review drilldown (CH-14).
    expect(within(screen.getByTestId("chase-controls")).getByTestId("link-bucket-pending-count").textContent).toMatch(
      /Match\s*3\s*items in Review/,
    );
  });

  it("ledger: one sticky-safe panel; its pinned pane holds the review controls; day groups are flush sections", async () => {
    show();
    await ready();
    const ledger = screen.getByTestId("chase-ledger");
    for (const c of ["span-12", "panel-sticky-safe", "panel-flush", "panel-accent-checking"]) {
      expect(ledger.className).toContain(c);
    }
    const pane = within(ledger).getByTestId("ledger-pane");
    expect(pane.className).toMatch(/^sticky top-0 /);
    expect(within(pane).getByTestId("chase-review-controls")).toBeTruthy();
    // The page publishes the pane's height for the rows beneath it.
    expect(screen.getByTestId("chase-page").style.getPropertyValue("--page-sticky-top")).toMatch(/px$/);
    const groups = ledger.querySelectorAll('[data-variant="flush"]');
    expect(groups.length).toBe(3);
    // Rows, pager and day heads all live inside the ledger panel.
    expect(within(ledger).getByTestId("row-tx-t2")).toBeTruthy();
    expect(within(ledger).getByTestId("chase-ledger-pager")).toBeTruthy();
  });

  it("rows: the card column names the source and the account's digits, with the checking dot; manual rows neither", async () => {
    show();
    await ready();
    const own = screen.getByTestId("text-card-t1");
    expect(own.textContent).toBe("Chase · Plaid ••5526");
    expect(own.parentElement!.querySelector('[aria-hidden="true"]')!.className).toContain("bg-acct-checking");
    const manual = screen.getByTestId("text-card-m1");
    expect(manual.textContent).toBe("Manual");
    expect(manual.parentElement!.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByTestId("row-tx-t1").className).toContain("min-h-10");
  });

  it("the bulk bar sticks under the pane, inside the ledger panel", async () => {
    show();
    await ready();
    const row = screen.getByTestId("row-tx-t1");
    fireEvent.click(within(row).getByRole("checkbox", { name: "Select" }));
    const bar = await screen.findByTestId("bulk-bar");
    expect(bar.style.top).toBe("var(--page-sticky-top, 0px)");
    expect(bar.className).toContain("sticky");
    expect(screen.getByTestId("chase-ledger").contains(bar)).toBe(true);
  });
});

describe("Chase page embedded (/next/accounts/:id) — the same layout", () => {
  it("drops the title, keeps the actions, and puts the host's lead first in the figures row (span-4 each)", async () => {
    show({
      embedded: true,
      accountKey: "acct-chk",
      lead: <section data-testid="lead" className="panel span-4" />,
    });
    await ready();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(within(screen.getByTestId("chase-embedded-actions")).getByTestId("button-add-transaction")).toBeTruthy();
    const lead = screen.getByTestId("lead");
    const inOut = screen.getByTestId("chase-stats-in-out");
    expect(inOut.className).toContain("span-4");
    expect(screen.getByTestId("chase-stats-balance").className).toContain("span-4");
    // Same grid, lead before the figures.
    expect(lead.parentElement).toBe(inOut.parentElement);
    expect(lead.compareDocumentPosition(inOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("chase-ledger").className).toContain("panel-sticky-safe");
  });
});
