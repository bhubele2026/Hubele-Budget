import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * (W3) Banking › Review. Synthetic fixtures only. Every figure on the page is
 * the server's string; these tests feed `GET /banking/review` JSON and read the
 * screen back, and pin the words that must stay apart: Balance check vs Review
 * inbox vs Not in the plan.
 */
const h = vi.hoisted(() => ({
  review: undefined as Record<string, unknown> | undefined,
  pages: {} as Record<string, unknown>,
  calls: [] as Array<Record<string, unknown>>,
  items: undefined as unknown,
  error: false,
  proposals: undefined as unknown,
  proposalCalls: 0,
  /** (Q4) The query holds another account's/range's answer (keepPreviousData). */
  placeholder: false,
  /** (Q4) Holds `getBankingReview` (the Show more cursor request) until released. */
  hold: null as Promise<void> | null,
  /** The next Show more request fails once. */
  failNext: false,
  /** (Q5) The signed-in person is the household owner. */
  owner: true as boolean,
  /** (Q5 fix) The spine's bank confidence (the account-wide pending count, the bank's figure today). */
  spine: undefined as unknown,
  /** (T2) GET /banking/check-explain's answer, and how often it was asked (only while the dialog is open). */
  explain: undefined as unknown,
  explainCalls: 0,
}));

function withFirstPages(r: Record<string, unknown>, pages: Record<string, unknown>) {
  const nip = { ...(r.notInPlan as Record<string, Record<string, unknown>>) };
  for (const name of Object.keys(nip)) {
    const first = pages[`${name}||`] as { rows: unknown[]; nextCursor: string | null } | undefined;
    if (first) nip[name] = { ...nip[name], rows: first.rows, truncated: !!first.nextCursor };
  }
  return { ...r, notInPlan: nip };
}

vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react")>()),
  useListPlaidItems: () => ({ data: h.items, isError: false, isLoading: false }),
  useGetMe: () => ({ data: { isOwner: h.owner }, isError: false, isLoading: false }),
}));
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react/features")>()),
  getBankingReview: async (params: Record<string, unknown>) => {
    h.calls.push({ ...params, via: "fetch" });
    if (h.hold) await h.hold;
    if (h.failNext) {
      h.failNext = false;
      throw new Error("network");
    }
    const key = `${params.bucket}|${params.kind ?? ""}|${params.cursor ?? ""}`;
    return { ...h.review, page: h.pages[key] ?? { bucket: params.bucket, kind: params.kind ?? null, rows: [], nextCursor: null, limit: 25 } };
  },
  getGetReviewProposalsQueryKey: () => ["/api/review/proposals"],
  getListAppliedReviewProposalsQueryKey: () => ["/api/review/proposals/applied"],
  useListAppliedReviewProposals: () => ({ data: { items: [] }, isError: false }),
  useApplyReviewProposal: () => ({ mutate: vi.fn(), isPending: false }),
  useGetReviewProposals: (opts?: { query?: { enabled?: boolean } }) => {
    if (opts?.query?.enabled === false) return { data: undefined, isError: false, refetch: vi.fn() };
    h.proposalCalls += 1;
    return { data: h.proposals, isError: false, refetch: vi.fn() };
  },
  useGetBankingCheckExplain: (opts?: { query?: { enabled?: boolean } }) => {
    if (opts?.query?.enabled === false) return { data: undefined, isError: false, isFetching: false, refetch: vi.fn() };
    h.explainCalls += 1;
    return { data: h.explain, isError: false, isFetching: false, refetch: vi.fn() };
  },
  useGetBankingReview: (params: Record<string, unknown>, opts?: { query?: { enabled?: boolean } }) => {
    if (opts?.query?.enabled === false) return { data: undefined, isError: false, isLoading: false, refetch: vi.fn() };
    h.calls.push(params);
    if (h.error) return { data: undefined, isError: true, isLoading: false, refetch: vi.fn() };
    const key = params.bucket ? `${params.bucket}|${params.kind ?? ""}|${params.cursor ?? ""}` : "";
    const page = key ? (h.pages[key] ?? { bucket: params.bucket, kind: params.kind ?? null, rows: [], nextCursor: null, limit: 25 }) : null;
    // (P4) The summary carries each bucket's first page, as the server does.
    const seeded = h.review && !params.bucket ? withFirstPages(h.review, h.pages) : h.review;
    // (Q4) The server echoes the days it read; the page shows an answer only for the range it asked.
    const echoed = seeded && {
      ...seeded,
      period: { ...(seeded as { period: Record<string, unknown> }).period, ...(params.from ? { from: params.from } : {}), ...(params.to ? { to: params.to } : {}) },
      page,
    };
    return { data: echoed, isError: false, isLoading: false, isPlaceholderData: h.placeholder, refetch: vi.fn() };
  },
}));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => ({ data: h.spine, state: h.spine ? "loaded" : "cold", refetch: () => {} }) }));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => <button data-testid="own-sync">Sync</button> }));

import BankingReviewPage from "./command-center";
import { ownerExplain } from "./__test-helpers__/checkExplainFixture";

const TODAY = new Date("2026-10-14T17:00:00Z"); // Wed 12:00 Central

const totals = (count: number, net: string, o: Record<string, unknown> = {}) => ({
  count,
  moneyIn: "0.00",
  moneyOut: net.replace("-", ""),
  net,
  pendingNet: "0.00",
  rows: [],
  truncated: false,
  differenceTotal: null,
  varianceIn: null,
  varianceOut: null,
  byKind: null,
  byReason: null,
  ...o,
});
// A negative net is money out, a positive one money in (the server's own in / out split).
const kt = (count: number, net: string) => ({
  count,
  moneyIn: Number(net) > 0 ? net : "0.00",
  moneyOut: Number(net) < 0 ? net.replace("-", "") : "0.00",
  net,
  pendingNet: "0.00",
});
const flags = (o: Record<string, boolean> = {}) => ({
  unplannedAllowance: false,
  weeklyAllowance: false,
  monthlyAllowance: false,
  reimbursable: false,
  transfer: false,
  cardPayment: false,
  ...o,
});
const rowOf = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  date: "2026-10-09",
  displayName: `Shop ${id}`,
  description: `SHOP ${id}`,
  amount: "-25.00",
  pending: false,
  manual: false,
  category: null,
  flags: flags(),
  kind: "spending",
  direction: "out",
  classificationIssue: null,
  reason: "no_plan",
  evidence: null,
  plan: null,
  ...o,
});

const check = (o: Record<string, unknown>) => ({
  status: "not_checked", reason: "never", stale: false, staleReason: null, checkedAt: null,
  bank: null, h2: null, difference: null, direction: null, lastDrift: null, ...o,
});

const review = (o: Record<string, unknown> = {}) => ({
  account: { id: "acct-chk", institution: "Chase", name: "Total Checking", mask: "4321", isForecastAccount: true, lastSyncedAt: "2026-10-14T16:00:00.000Z" },
  period: { from: "2026-10-01", to: "2026-10-14", today: "2026-10-14", timezone: "America/Chicago" },
  balance: { today: "3205.81", asOf: "2026-10-14T13:00:00.000Z", reading: "3170.00", start: "3000.00", end: "3205.81", unavailableReason: null },
  freshness: { source: "plaid", fetchedAt: "2026-10-14T16:00:00.000Z", lastContactAt: "2026-10-14T16:00:00.000Z", lastFailureAt: null, stale: false, staleReason: null },
  cashFlow: { moneyIn: "2425.00", moneyOut: "2219.19", net: "205.81", count: 23, pendingNet: "-6.50", pendingCount: 1, supersededExcluded: 1, otherExcluded: 0 },
  planComparison: { available: true, reason: null, comparedFrom: "2026-08-16", plansFrom: "2026-09-01", through: "2026-10-14" },
  planned: [
    { key: "a|2026-10-01", itemId: "a", label: "Gym Membership", scheduledDate: "2026-10-01", occurrenceDate: "2026-10-01", planned: "-40.00", fate: "matched", txnId: "t1", txnDate: "2026-10-08", txnAmount: "-40.00", txnOnThisAccount: true, difference: "0.00", dayDelta: 7, remainder: null, onCurve: false, hook: null, direction: "out", outcome: "paid" },
    { key: "b|2026-10-12", itemId: "b", label: "Water", scheduledDate: "2026-10-12", occurrenceDate: "2026-10-12", planned: "-60.00", fate: "missed", txnId: null, txnDate: null, txnAmount: null, txnOnThisAccount: false, difference: null, dayDelta: null, remainder: null, onCurve: true, hook: null, direction: "out", outcome: "missed" },
  ],
  notInPlan: {
    amountDifference: totals(4, "-643.40"),
    timingDifference: totals(1, "-40.00"),
    confirmedUnplanned: totals(3, "-132.50"),
    uncertain: totals(2, "-145.00", { byReason: { needs_review: kt(1, "-70.00"), suggested_match: kt(1, "-75.00"), not_compared: kt(0, "0.00") } }),
    unmatched: totals(9, "-737.80", {
      byKind: {
        spending: kt(3, "-112.80"), card_payment: kt(1, "-250.00"), debt_payment: kt(1, "-300.00"), transfer: kt(1, "-500.00"),
        income: kt(1, "300.00"), refund: kt(1, "25.00"), other: kt(1, "100.00"),
      },
    }),
  },
  asPlanned: { count: 3, net: "1904.51", pendingNet: "0.00", withoutPlanDetail: 0 },
  reconciliation: { rowsPlaced: 22, rowsUnexplained: 0, unexplained: "0.00" },
  reviewInbox: { unresolvedInRange: 15, unresolvedScope: "this account · this period", unresolvedFrom: "2026-10-01", unresolvedTo: "2026-10-14", badgeCount: 16, badgeScope: "this calendar month, forecast account" },
  balanceTie: { status: "not_checked", checkedAt: null, unexplained: null },
  balanceCheck: check({}),
  household: { scope: "all accounts · this week", weekStart: "2026-10-11", weekEnd: "2026-10-17", spentWeek: "124.00", weekPlan: null, remainingWeek: null, knownWeek: "100.00", unresolvedWeek: "24.00", provisional: false, remainingWeekKnown: null },
  ...o,
});

const item = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  itemId: "pi-1",
  institutionName: "Chase",
  institutionSlug: "chase",
  lastSyncedAt: "2026-10-14T16:00:00Z",
  lastSyncError: null,
  lastSyncErrorCode: null,
  freshness: { state: "ok", stale: false, staleReason: null, fetchedAt: "2026-10-14T16:00:00Z", lastContactAt: "2026-10-14T16:00:00Z", lastFailureAt: null },
  accounts: [
    { id: "acct-chk", accountId: "ext-chk", name: "Total Checking", mask: "4321", type: "depository", subtype: "checking" },
    { id: "acct-sav", accountId: "ext-sav", name: "Savings", mask: "8802", type: "depository", subtype: "savings" },
  ],
  ...over,
});

function mount(path = "/banking") {
  window.history.replaceState(null, "", path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BankingReviewPage />
    </QueryClientProvider>,
  );
}
const text = (id: string) => screen.getByTestId(id).textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  h.review = review();
  h.pages = {};
  h.calls = [];
  h.items = [item()];
  h.error = false;
  h.placeholder = false;
  h.hold = null;
  h.proposals = undefined;
  h.proposalCalls = 0;
  h.owner = true;
  h.explain = undefined;
  h.explainCalls = 0;
  h.spine = { bankConfidence: { fetchedAt: "2026-10-14T16:00:00.000Z", bankBalance: "3205.81", bankAsOf: "2026-10-14T13:00:00.000Z", h2Balance: "3205.81", pendingCount: 1, check: {} } };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("Banking review — header and summary", () => {
  it("names the account, the explicit range and the freshness", () => {
    mount();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Banking review");
    expect(text("br-account")).toContain("Total Checking");
    expect(text("br-range")).toBe("Oct 1 – Oct 14");
    expect(text("br-fresh")).toContain("Updated 1 h ago");
    expect(text("br-pending")).toBe("1 pending");
    expect(screen.getByTestId("br-preset-month").getAttribute("aria-pressed")).toBe("true");
  });

  it("'Updated' is the SERVER's instant (freshness.fetchedAt), never a latest-of the browser takes itself", () => {
    h.review = review({
      account: { id: "acct-chk", institution: "Chase", name: "Total Checking", mask: "4321", isForecastAccount: true, lastSyncedAt: "2026-10-14T16:00:00.000Z" },
      freshness: { source: "plaid", fetchedAt: "2026-10-14T13:00:00.000Z", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null },
    });
    mount();
    expect(text("br-fresh")).toContain("Updated 4 h ago");
    cleanup();
    h.review = review({
      account: { id: "acct-chk", institution: "Chase", name: "Total Checking", mask: "4321", isForecastAccount: true, lastSyncedAt: null },
      freshness: null,
      balance: { today: null, asOf: null, start: null, end: null, unavailableReason: "not_snapshot_account" },
    });
    h.items = [item({ freshness: { state: "never", stale: false, staleReason: null, fetchedAt: null, lastContactAt: null, lastFailureAt: null } })];
    mount();
    expect(text("br-fresh")).toContain("Not updated yet");
  });

  it("(Q5 fix) a typed balance is as old as its own time: a live feed's recent sync does not make it 'Updated 1 h ago'", () => {
    // The dashboard header (spine) and the tile say 10 days; Banking says the same, from the same server instant.
    h.review = review({
      freshness: { source: "manual", fetchedAt: "2026-10-04T13:00:00.000Z", lastContactAt: "2026-10-14T16:00:00.000Z", lastFailureAt: null, stale: true, staleReason: "manual_old" },
      balance: { today: "3205.81", asOf: "2026-10-04T13:00:00.000Z", start: "3000.00", end: "3205.81", unavailableReason: null },
    });
    mount();
    expect(text("br-fresh")).toBe("Needs an update · Updated 10 d ago");
  });

  it("(Q5 fix) another account's 'Updated' is its own connection's server freshness", () => {
    h.review = review({
      account: { id: "acct-sav", institution: "Chase", name: "Savings", mask: "8802", isForecastAccount: false, lastSyncedAt: "2026-10-14T16:00:00.000Z" },
      freshness: null,
    });
    h.items = [item({ freshness: { state: "stale", stale: true, staleReason: "old", fetchedAt: "2026-10-11T13:00:00Z", lastContactAt: "2026-10-11T13:00:00Z", lastFailureAt: null } })];
    mount("/banking?account=acct-sav");
    expect(text("br-fresh")).toBe("Out of date · Updated 3 d ago");
  });

  it("(Q5 fix) 'N pending' is the account's, through today — the dashboard's count — not the range's", () => {
    // Last month: nothing pending in September, but the account has 3 pending now (the spine's count).
    h.spine = { bankConfidence: { fetchedAt: "2026-10-14T16:00:00.000Z", bankBalance: "3205.81", bankAsOf: null, h2Balance: "3205.81", pendingCount: 3, check: {} } };
    h.review = review({ cashFlow: { moneyIn: "0.00", moneyOut: "0.00", net: "0.00", count: 0, pendingNet: "0.00", pendingCount: 0, supersededExcluded: 0, otherExcluded: 0 } });
    mount("/banking?from=2026-09-01&to=2026-09-30");
    expect(text("br-pending")).toBe("3 pending");
    cleanup();
    // Another account has no account-wide read: it says its range.
    h.review = review({
      account: { id: "acct-sav", institution: "Chase", name: "Savings", mask: "8802", isForecastAccount: false, lastSyncedAt: null },
      freshness: null,
      cashFlow: { moneyIn: "0.00", moneyOut: "0.00", net: "0.00", count: 2, pendingNet: "-5.00", pendingCount: 2, supersededExcluded: 0, otherExcluded: 0 },
    });
    mount("/banking?account=acct-sav");
    expect(text("br-pending")).toBe("2 pending in Oct 1 – Oct 14");
  });

  it("asks the server for this month to today on the default account", () => {
    mount();
    expect(h.calls[0]).toMatchObject({ from: "2026-10-01", to: "2026-10-14" });
    expect(h.calls[0]).not.toHaveProperty("account");
  });

  it("summary: balance, money in, money out are the server's strings", () => {
    mount();
    expect(text("br-balance")).toBe("$3,205.81");
    expect(text("br-in")).toBe("$2,425.00");
    expect(text("br-out")).toBe("$2,219.19");
  });

  it("Balance check and the to-review count are separate things, each with its own scope", () => {
    mount();
    expect(within(screen.getByTestId("br-tie-cell")).getByText("Balance check")).toBeTruthy();
    expect(text("br-tie")).toBe("Not checked");
    // One name everywhere (the dashboard tile and the top bar say "review"). The count is THIS account and range, not the badge's.
    expect(text("br-inbox")).toBe("15 charges to match");
    expect(text("br-inbox-scope")).toBe("This account · Oct 1 – Oct 14");
    // (Q5 fix) The destination opens on that month, so the list has the scope the chip names.
    expect(screen.getByTestId("br-inbox").getAttribute("href")).toBe("/review?month=2026-10");
    expect(screen.getByTestId("br-inbox").getAttribute("aria-label")).toBe("15 charges to match, This account · Oct 1 – Oct 14");
    expect(screen.getByTestId("banking-review").textContent).not.toMatch(/Review inbox|to review this month|reconcile/i);
    expect(screen.getByTestId("br-tie-cell").textContent).not.toMatch(/reconcile|review/i);
  });

  it("(Q5 fix) the to-review chip always ties to its destination: last month links to that month; a range the review page cannot show says the page's own count", () => {
    h.review = review({ reviewInbox: { unresolvedInRange: 1, unresolvedScope: "this account · this period", unresolvedFrom: "2026-09-01", unresolvedTo: "2026-09-30", badgeCount: 9, badgeScope: "this calendar month, forecast account" } });
    mount("/banking?from=2026-09-01&to=2026-09-30");
    expect(text("br-inbox")).toBe("1 charge to match");
    expect(text("br-inbox-scope")).toBe("This account · Sep 1 – Sep 30");
    expect(screen.getByTestId("br-inbox").getAttribute("href")).toBe("/review?month=2026-09");
    cleanup();
    // (Round 3) A month two back ties too: Review loads it (GET /forecast?fromMonth). Thirteen back it cannot: the page's count.
    mount("/banking?from=2026-08-01&to=2026-08-31");
    expect(text("br-inbox-scope")).toBe("This account · Aug 1 – Aug 31");
    expect(screen.getByTestId("br-inbox").getAttribute("href")).toBe("/review?month=2026-08");
    cleanup();
    mount("/banking?from=2025-08-01&to=2025-08-31");
    expect(text("br-inbox-scope")).toBe("Planned account · this month");
    expect(screen.getByTestId("br-inbox").getAttribute("href")).toBe("/review");
    cleanup();
    // This week is part of a month (the review page lists the whole month): the chip says the page's count and scope.
    mount("/banking?from=2026-10-11&to=2026-10-14");
    expect(text("br-inbox")).toBe("9 charges to match");
    expect(text("br-inbox-scope")).toBe("Planned account · this month");
    expect(screen.getByTestId("br-inbox").getAttribute("href")).toBe("/review");
    cleanup();
    // Another account: the review page lists the planned account only.
    h.review = review({ account: { id: "acct-sav", institution: "Chase", name: "Savings", mask: "8802", isForecastAccount: false, lastSyncedAt: null }, freshness: null });
    mount("/banking?account=acct-sav");
    expect(text("br-inbox")).toBe("16 charges to match");
    expect(text("br-inbox-scope")).toBe("Planned account · this month");
  });

  it("an empty inbox reads 'Nothing to match'", () => {
    h.review = review({ reviewInbox: { unresolvedInRange: 0, unresolvedScope: "this account · this period", unresolvedFrom: "2026-10-01", unresolvedTo: "2026-10-14", badgeCount: 0, badgeScope: "this calendar month, forecast account" } });
    mount();
    expect(text("br-inbox")).toBe("Nothing to match");
  });

  it("the order is the order of the questions: context, then what needs a decision, then not on the plan, planned, household", () => {
    mount();
    const order = ["br-summary", "br-decide", "br-notinplan", "br-planned", "br-household"].map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    }
    expect(within(screen.getByTestId("br-decide")).getByTestId("br-fixes")).toBeTruthy();
    expect(within(screen.getByTestId("br-decide")).getByTestId("br-inbox")).toBeTruthy();
  });

  it("no balance for an account without a snapshot reads a dash, never $0.00", () => {
    h.review = review({ balance: { today: null, asOf: null, start: null, end: null, unavailableReason: "not_snapshot_account" } });
    mount();
    expect(text("br-balance")).toBe("—");
  });

  it("the household spine figures, insight strip and allowance table are gone", () => {
    mount();
    for (const id of ["cc-spine-stats", "cc-allowances", "cc-biggest-charges", "chase-insight-strip"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });
});

describe("Banking review — Not in the plan", () => {
  it("five buckets in the owner's order, counts and nets from the server", () => {
    mount();
    const ids = [...document.querySelectorAll('[data-testid^="br-bucket-"]')].map((e) => e.getAttribute("data-testid"));
    expect(ids).toEqual([
      "br-bucket-unmatched",
      "br-bucket-amountDifference",
      "br-bucket-timingDifference",
      "br-bucket-confirmedUnplanned",
      "br-bucket-uncertain",
    ]);
    const expected: Array<[string, string]> = [
      ["unmatched", "9"],
      ["amountDifference", "4"],
      ["timingDifference", "1"],
      ["confirmedUnplanned", "3"],
      ["uncertain", "2"],
    ];
    for (const [name, count] of expected) {
      expect(text(`br-count-${name}`)).toBe(count);
      // (Q5) Never the old net-as-"total moved": money in and money out are said apart.
      expect(screen.queryByTestId(`br-net-${name}`)).toBeNull();
      expect(screen.getByTestId(`br-bucket-${name}`).textContent).not.toMatch(/total moved/i);
    }
    expect(text("br-inout-unmatched-out")).toBe("Out $737.80");
    expect(screen.queryByTestId("br-inout-unmatched-in")).toBeNull();
    const titles = ["Unplanned activity", "Amount differences", "Timing differences", "Marked unplanned", "Unclear"];
    for (const t of titles) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    // compact pills in one labelled group; the selected one is pressed
    const group = screen.getByRole("group", { name: "Not in the plan" });
    expect(within(group).getAllByRole("button")).toHaveLength(5);
    expect(screen.getByTestId("br-bucket-unmatched").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("br-bucket-amountDifference").getAttribute("aria-pressed")).toBe("false");
  });

  it("the section is open by default", () => {
    mount();
    expect((screen.getByTestId("br-notinplan") as HTMLDetailsElement).open).toBe(true);
    expect((screen.getByTestId("br-planned") as HTMLDetailsElement).open).toBe(false);
  });

  it("a bucket reads aloud with its count, money in and money out apart", () => {
    h.review = review({ notInPlan: { ...review().notInPlan, unmatched: totals(2, "275.00", { moneyIn: "300.00", moneyOut: "25.00" }) } });
    mount();
    expect(screen.getByTestId("br-bucket-unmatched").getAttribute("aria-label")).toBe("Unplanned activity: 2 rows, money in $300.00, money out $25.00");
    expect(screen.getByTestId("br-bucket-unmatched").getAttribute("title")).toBe("Unplanned activity: 2 rows, money in $300.00, money out $25.00");
    expect(text("br-inout-unmatched-in")).toBe("In $300.00");
    expect(text("br-inout-unmatched-out")).toBe("Out $25.00");
  });

  it("Unmatched is split by kind, with the note that card payments, debt payments and transfers are not spending", () => {
    mount();
    const kinds = screen.getByTestId("br-kinds");
    // in / out apart, never a signed net
    expect(text("br-kind-card_payment")).toBe("Card payment 1 · Out $250.00");
    expect(text("br-kind-debt_payment")).toBe("Debt payment 1 · Out $300.00");
    expect(text("br-kind-spending")).toBe("Spending 3 · Out $112.80");
    expect(text("br-kind-income")).toBe("Income 1 · In $300.00");
    expect(text("br-kind-all")).toBe("All 9");
    expect(kinds.textContent).not.toMatch(/−|\+\$/);
    expect(kinds.textContent).toContain("Card and debt payments and transfers are not spending.");
    for (const k of ["spending", "transfer", "income", "refund", "other"]) expect(screen.getByTestId(`br-kind-${k}`)).toBeTruthy();
  });

  it("selecting a bucket writes ?bucket and lists its rows with the row facts", () => {
    h.pages["amountDifference||"] = {
      bucket: "amountDifference",
      kind: null,
      limit: 25,
      nextCursor: null,
      rows: [
        rowOf("r1", {
          date: "2026-10-04",
          displayName: "Capital One Mobile Pymt",
          amount: "-300.00",
          pending: true,
          category: { id: "c1", name: "Debt" },
          flags: flags({ unplannedAllowance: true, reimbursable: true }),
          kind: "card_payment",
          reason: "amount",
          plan: { key: "k", label: "Cap One minimum", scheduledDate: "2026-10-02", planned: "-40.00", difference: "260.00", dayDelta: 2, eventKind: "debt", direction: "out", expected: "40.00", actual: "300.00", variance: "-260.00", varianceKind: "over_planned" },
        }),
      ],
    };
    mount();
    fireEvent.click(screen.getByTestId("br-bucket-amountDifference"));
    expect(window.location.search).toContain("bucket=amountDifference");
    expect(screen.getByTestId("br-bucket-amountDifference").getAttribute("aria-pressed")).toBe("true");
    const row = screen.getByTestId("br-row-r1");
    expect(row.textContent).toContain("Oct 4");
    expect(row.textContent).toContain("Capital One Mobile Pymt");
    expect(row.textContent).toContain("Pending");
    expect(text("br-cat-r1")).toBe("Debt");
    expect(row.textContent).toContain("Unplanned allowance");
    expect(row.textContent).toContain("Reimbursable");
    expect(text("br-amount-r1")).toBe("-$300.00");
    expect(text("br-plan-r1")).toBe("Planned $40.00 · paid $300.00 · $260.00 over · 2 days late");
    // the difference leads; the full amount is secondary
    expect(text("br-variance-r1")).toBe("$260.00 over");
  });

  it("a row without a category says so", () => {
    h.pages["unmatched||"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: null, rows: [rowOf("r2")] };
    mount();
    expect(text("br-cat-r2")).toBe("No category");
  });

  it("each row links to its register with account, month and transaction", () => {
    h.pages["unmatched||"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: null, rows: [rowOf("r3", { date: "2026-10-09" })] };
    mount();
    const href = screen.getByTestId("br-link-r3").getAttribute("href")!;
    const u = new URL(href, "http://x");
    expect(u.pathname).toBe("/transactions");
    expect(u.searchParams.get("account")).toBe("acct-chk");
    expect(u.searchParams.get("month")).toBe("2026-10-01");
    expect(u.searchParams.get("tx")).toBe("r3");
  });

  it("selecting a kind filters the unmatched rows (?kind) and asks the server for that kind", () => {
    mount();
    fireEvent.click(screen.getByTestId("br-kind-card_payment"));
    expect(window.location.search).toContain("bucket=unmatched");
    expect(window.location.search).toContain("kind=card_payment");
    expect(h.calls.some((c) => c.bucket === "unmatched" && c.kind === "card_payment")).toBe(true);
    expect(screen.getByTestId("br-detail").textContent).toContain("Unplanned activity · Card payment");
  });

  it("'All' clears the kind filter; kind chips live only inside Unplanned activity", () => {
    mount("/banking?bucket=unmatched&kind=card_payment");
    expect(screen.getByTestId("br-kind-all").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("br-kind-card_payment").getAttribute("aria-pressed")).toBe("true");
    // the selected title shows that kind's own in / out
    expect(text("br-sel-out")).toBe("Out $250.00");
    expect(screen.queryByTestId("br-sel-in")).toBeNull();
    fireEvent.click(screen.getByTestId("br-kind-all"));
    expect(window.location.search).not.toContain("kind=");
    expect(screen.getByTestId("br-kind-all").getAttribute("aria-pressed")).toBe("true");
    // another bucket has no kind chips
    fireEvent.click(screen.getByTestId("br-bucket-timingDifference"));
    expect(screen.queryByTestId("br-kinds")).toBeNull();
    expect(text("br-sel-note")).toBe("On the plan, but more than 3 days early or late");
  });

  it("one box: the rows sit directly under the title, no nested card, the household is a footnote", () => {
    mount();
    const detail = screen.getByTestId("br-detail");
    expect(detail.className).not.toMatch(/ring-1|rounded-card|bg-neutral-50/);
    expect(screen.getByTestId("br-household").className).not.toMatch(/ring-1|surface/);
    expect(within(detail).getByRole("heading", { name: /Unplanned activity/ })).toBeTruthy();
  });

  it("Unclear says why: reason counts under the title", () => {
    mount("/banking?bucket=uncertain");
    expect(text("br-sel-note")).toBe("1 needs review · 1 suggested match");
  });

  it("Show more says it is loading, and a failed page says so and can be tried again", async () => {
    h.pages["unmatched||"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: "CUR1", rows: [rowOf("p1")], truncated: true } as never;
    mount();
    const btn = screen.getByTestId("br-more");
    expect(btn.textContent).toBe("Show more");
    h.failNext = true;
    fireEvent.click(btn);
    expect(await screen.findByTestId("br-more-error")).toBeTruthy();
    expect(screen.getByTestId("br-more-error").getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("br-more").textContent).toBe("Show more");
  });

  it("first load is ONE review request: the summary carries the default bucket's first page", () => {
    h.pages["unmatched||"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: null, rows: [rowOf("one")] };
    mount();
    expect(screen.getByTestId("br-row-one")).toBeTruthy();
    const keys = new Set(h.calls.filter((c) => c.via !== "fetch").map((c) => JSON.stringify(c)));
    expect(keys.size).toBe(1);
    expect(h.calls.every((c) => c.bucket === undefined && c.rowsPerBucket === 25)).toBe(true);
  });

  it("pages with the server's cursor", async () => {
    h.pages["unmatched||"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: "CUR1", rows: [rowOf("p1")] };
    h.pages["unmatched||CUR1"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: null, rows: [rowOf("p2")] };
    mount();
    expect(screen.queryByTestId("br-row-p2")).toBeNull();
    fireEvent.click(screen.getByTestId("br-more"));
    expect(await screen.findByTestId("br-row-p2")).toBeTruthy();
    expect(screen.getByTestId("br-row-p1")).toBeTruthy();
    expect(screen.queryByTestId("br-more")).toBeNull();
  });

  it("an uncertain row names why H2 cannot tell", () => {
    h.pages["uncertain||"] = { bucket: "uncertain", kind: null, limit: 25, nextCursor: null, rows: [rowOf("u1", { reason: "suggested_match" })] };
    mount("/banking?bucket=uncertain");
    expect(screen.getByTestId("br-row-u1").textContent).toContain("Suggested match");
  });

  it("another account says rows are not compared with the plan", () => {
    h.review = review({
      planComparison: { available: false, reason: "not_forecast_account", comparedFrom: null, plansFrom: null, through: null },
      planned: [],
    });
    mount();
    expect(text("br-no-compare")).toContain("Unclear");
  });
});

describe("Banking review — planned, household, unexplained", () => {
  it("lists the planned items with their fate in plain words", () => {
    mount();
    const rows = screen.getAllByTestId("br-planned-row").map((r) => r.textContent);
    expect(rows[0]).toContain("Gym Membership");
    expect(rows[0]).toContain("Paid");
    expect(rows[0]).toContain("$40.00 on Oct 8");
    expect(rows[1]).toContain("Missed");
    expect(rows[1]).toContain("$60.00");
  });

  it("household: labelled, secondary, the glossary's words, 'Plan not set' is never $0", () => {
    mount();
    const box = screen.getByTestId("br-household");
    expect(box.textContent).toContain("All accounts · this week");
    // Counts toward plan = known (100), Unconfirmed 24, the cautious total (124) named as such.
    expect(box.textContent).toContain("Counts toward plan");
    expect(text("br-hh-spent")).toBe("$100.00");
    expect(box.textContent).toContain("Unconfirmed");
    expect(text("br-hh-unconfirmed")).toBe("$24.00");
    expect(text("br-hh-cautious")).toBe("Cautious total (includes unconfirmed) $124.00");
    expect(text("br-hh-plan")).toBe("Not set");
    expect(screen.queryByTestId("br-hh-left")).toBeNull();
    expect(box.textContent).not.toContain("Counts toward weekly plan");
    expect(within(box).getByText("Open this week →").getAttribute("href")).toBe("/spending/week");
    // It comes last.
    const planned = screen.getByTestId("br-planned");
    expect(planned.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("(Q5 fix) a provisional week says 'so far' on Left / Over, as the tile and the Room line do", () => {
    h.review = review({ household: { scope: "all accounts · this week", weekStart: "2026-10-11", weekEnd: "2026-10-17", spentWeek: "900.00", weekPlan: "700.00", remainingWeek: "-200.00", knownWeek: "596.32", unresolvedWeek: "303.68", provisional: true, remainingWeekKnown: "103.68" } });
    mount();
    expect(screen.getByTestId("br-household").textContent).toContain("Left so far");
    cleanup();
    h.review = review({ household: { scope: "all accounts · this week", weekStart: "2026-10-11", weekEnd: "2026-10-17", spentWeek: "900.00", weekPlan: "500.00", remainingWeek: "-400.00", knownWeek: "524.50", unresolvedWeek: "375.50", provisional: true, remainingWeekKnown: "-24.50" } });
    mount();
    expect(screen.getByTestId("br-household").textContent).toContain("Over so far");
  });

  it("household with a plan shows it, and Left / Over on the known figure", () => {
    h.review = review({ household: { scope: "all accounts · this week", weekStart: "2026-10-11", weekEnd: "2026-10-17", spentWeek: "124.00", weekPlan: "300.00", remainingWeek: "176.00", knownWeek: "100.00", unresolvedWeek: "0.00", provisional: false, remainingWeekKnown: "200.00" } });
    mount();
    expect(text("br-hh-plan")).toBe("$300.00");
    expect(text("br-hh-left")).toBe("$200.00");
    expect(screen.getByTestId("br-household").textContent).toContain("Left");
    // Nothing unconfirmed: no second figure to explain.
    expect(screen.queryByTestId("br-hh-cautious")).toBeNull();
    cleanup();
    h.review = review({ household: { scope: "all accounts · this week", weekStart: "2026-10-11", weekEnd: "2026-10-17", spentWeek: "340.00", weekPlan: "300.00", remainingWeek: "-40.00", knownWeek: "340.00", unresolvedWeek: "0.00", provisional: false, remainingWeekKnown: "-40.00" } });
    mount();
    expect(screen.getByTestId("br-household").textContent).toContain("Over");
    expect(text("br-hh-left")).toBe("$40.00");
  });

  it("planned items say it in the direction of the money: income Received, a bill Paid", () => {
    h.review = review({
      planned: [
        { key: "p|1", itemId: "p", label: "Paycheck", scheduledDate: "2026-10-09", occurrenceDate: "2026-10-09", planned: "2500.00", fate: "partial", txnId: "t", txnDate: "2026-10-09", txnAmount: "2391.40", txnOnThisAccount: true, difference: "-108.60", dayDelta: 0, remainder: null, onCurve: false, hook: null, direction: "in", outcome: "received_different" },
        { key: "p|2", itemId: "q", label: "Side gig", scheduledDate: "2026-10-12", occurrenceDate: "2026-10-12", planned: "400.00", fate: "unmatched", txnId: null, txnDate: null, txnAmount: null, txnOnThisAccount: false, difference: null, dayDelta: null, remainder: null, onCurve: false, hook: null, direction: "in", outcome: "not_received_yet" },
        { key: "p|3", itemId: "r", label: "Water", scheduledDate: "2026-10-12", occurrenceDate: "2026-10-12", planned: "-60.00", fate: "unmatched", txnId: null, txnDate: null, txnAmount: null, txnOnThisAccount: false, difference: null, dayDelta: null, remainder: null, onCurve: false, hook: null, direction: "out", outcome: "not_paid_yet" },
      ],
    });
    mount();
    const rows = screen.getAllByTestId("br-planned-row").map((r) => r.textContent!);
    expect(rows[0]).toContain("Expected Oct 9 · Received, different amount");
    expect(rows[1]).toContain("Expected Oct 12 · Not received yet");
    expect(rows[2]).toContain("Due Oct 12 · Not paid yet");
    expect(rows.join(" ")).not.toMatch(/Paid, different amount|Missed/);
  });

  it("unexplained = 0 shows no notice", () => {
    mount();
    expect(screen.queryByTestId("br-unplaced")).toBeNull();
  });

  it("unexplained ≠ 0 shows an honest notice instead of hiding it", () => {
    h.review = review({ reconciliation: { rowsPlaced: 21, rowsUnexplained: 1, unexplained: "18.40" } });
    mount();
    expect(text("br-unplaced")).toBe("H2 could not place some rows: $18.40");
    expect(screen.getByTestId("banking-review").textContent).not.toMatch(/unexplained/i);
  });
});

describe("Banking review — URL state", () => {
  it("reads account, range and bucket from the address", () => {
    mount("/banking?account=acct-sav&from=2026-09-01&to=2026-09-30&bucket=timingDifference");
    expect(h.calls[0]).toMatchObject({ account: "acct-sav", from: "2026-09-01", to: "2026-09-30" });
    expect(text("br-range")).toBe("Oct 1 – Oct 14".replace("Oct 1 – Oct 14", "Sep 1 – Sep 30"));
    expect(screen.getByTestId("br-bucket-timingDifference").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("br-preset-month").getAttribute("aria-pressed")).toBe("false");
  });

  it("a preset writes ?from&to; Last month is the whole month", () => {
    mount();
    fireEvent.click(screen.getByTestId("br-preset-last"));
    expect(window.location.search).toContain("from=2026-09-01");
    expect(window.location.search).toContain("to=2026-09-30");
    expect(text("br-range")).toBe("Sep 1 – Sep 30");
    fireEvent.click(screen.getByTestId("br-preset-week"));
    expect(window.location.search).toContain("from=2026-10-11");
    expect(window.location.search).toContain("to=2026-10-14");
  });

  it("picking an account writes ?account and clears the bucket", () => {
    mount("/banking?bucket=uncertain");
    fireEvent.change(screen.getByTestId("br-account"), { target: { value: "acct-sav" } });
    expect(window.location.search).toContain("account=acct-sav");
    expect(window.location.search).not.toContain("bucket=");
    expect(h.calls.some((c) => c.account === "acct-sav")).toBe(true);
  });

  it("a future or reversed range falls back to this month rather than asking the server for it", () => {
    mount("/banking?from=2026-12-01&to=2026-12-31");
    expect(h.calls[0]).toMatchObject({ from: "2026-10-01", to: "2026-10-14" });
  });
});

describe("Banking review — states", () => {
  it("a failed load says so and offers a retry", () => {
    h.error = true;
    mount();
    expect(screen.getByTestId("br-error").textContent).toContain("did not load");
  });

  it("an account at a bank with no register of its own keeps a Sync button", () => {
    h.review = review({ account: { id: "acct-cu", institution: "Fox Valley CU", name: "Checking", mask: "1111", isForecastAccount: false, lastSyncedAt: null } });
    mount("/banking?account=acct-cu");
    expect(screen.getByTestId("own-sync")).toBeTruthy();
    cleanup();
    h.review = review();
    mount();
    expect(screen.queryByTestId("own-sync")).toBeNull();
  });
});

describe("(F4, Q5, T2) Balance check — one state machine: one chip, one line, one action", () => {
  const NOW = "2026-10-14T15:00:00.000Z";
  const state = (o: Record<string, unknown>, r: Record<string, unknown> = {}) => {
    h.review = review({ balanceCheck: check({ checkedAt: NOW, ...o }), ...r });
    mount();
  };

  it("matches: 'Balances match' (green), checked when and the two figures it compared, no action", () => {
    state({ status: "matches", reason: null, difference: "0.00", bank: { balance: "2985.00", at: NOW, field: "available" }, h2: { balance: "2985.00" } });
    expect(text("br-tie")).toBe("Balances match");
    expect(screen.getByTestId("br-tie").className).toContain("ok");
    expect(text("br-check-line")).toBe("Checked 2 h ago · bank $2,985.00 = H2 $2,985.00");
    expect(screen.queryByTestId("br-check-sync")).toBeNull();
    expect(screen.queryByTestId("br-review-difference")).toBeNull();
  });

  it("off by: 'Difference needs review' in rust, the check's own moment, Review difference with the register", () => {
    state({ status: "off_by", reason: null, difference: "62.50", direction: "bank_lower", bank: { balance: "2985.00", at: NOW, field: "available" }, h2: { balance: "3047.50" } });
    expect(text("br-tie")).toBe("Difference needs review");
    expect(screen.getByTestId("br-tie").className).toContain("bad");
    expect(text("br-check-line")).toBe("At the last check (Oct 14) the bank was $62.50 lower than H2 expected.");
    // Today's figures are not one reading here: no "agree" line.
    expect(screen.queryByTestId("br-check-agree")).toBeNull();
    // (T1) The bank's own reading under the balance is THIS response's, named as a reading, never "Bank $X".
    expect(text("br-bank-today")).toBe("Bank's last reading $3,170.00 · Oct 14, 8:00 AM");
    expect(screen.getByTestId("br-review-difference").textContent).toBe("Review difference");
    expect(screen.getByTestId("br-check-register").getAttribute("href")).toBe("/transactions?account=acct-chk&month=2026-10-01");
  });

  it("⭐ the owner's case: H2 and the bank agree today, the check stays — and Review difference explains it, read-only", async () => {
    const at = "2026-10-14T12:02:00.000Z";
    h.explain = ownerExplain({ check: { ...ownerExplain().check, checkedAt: at, bank: { balance: "0.00", at, field: "available" } } });
    state(
      { status: "off_by", reason: null, checkedAt: at, difference: "432.00", direction: "bank_lower", bank: { balance: "0.00", at, field: "available" }, h2: { balance: "432.00" } },
      { balance: { today: "0.00", asOf: at, reading: "0.00", start: "0.00", end: "0.00", unavailableReason: null } },
    );
    expect(text("br-balance")).toBe("$0.00");
    expect(text("br-balance-asof")).toBe("as of Oct 14");
    expect(text("br-bank-today")).toBe("Bank's last reading $0.00 · Oct 14, 7:02 AM");
    expect(text("br-tie")).toBe("Difference needs review");
    expect(text("br-check-agree")).toBe("Today H2 $0.00 and the bank $0.00 agree.");
    expect(text("br-check-line")).toBe("At the last check (Oct 14) the bank was $432.00 lower than H2 expected.");
    // A real $0.00 balance is plain, never rust.
    expect(screen.getByTestId("br-balance").className).not.toMatch(/bad/);
    // Nothing is asked until the investigation opens.
    expect(h.explainCalls).toBe(0);
    fireEvent.click(screen.getByTestId("br-review-difference"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const body = await screen.findByTestId("check-explain-verdict");
    expect(h.explainCalls).toBeGreaterThan(0);
    expect(body.textContent).toContain("H2 can't find what explains this $432.00.");
    expect(screen.getByTestId("check-explain-previous").textContent).toContain("$432.00");
    expect(screen.getByTestId("check-explain-manual").textContent).toContain("none");
  });

  it("bank higher reads the other way", () => {
    state({ status: "off_by", reason: null, difference: "10.00", direction: "bank_higher" });
    expect(text("br-check-line")).toBe("At the last check (Oct 14) the bank was $10.00 higher than H2 expected.");
  });

  it("resolved since: green, the check's own difference (not the history), and the history beside it", () => {
    state({ status: "resolved_since", reason: null, difference: "2000.00", direction: "bank_higher", lastDrift: { checkedAt: "2026-10-02T15:00:00.000Z", difference: "75.00", direction: "bank_lower" } });
    expect(text("br-tie")).toBe("Resolved since");
    expect(screen.getByTestId("br-tie").className).toContain("ok");
    expect(text("br-check-line")).toBe("Was off by $2,000.00 at the Oct 14 check; rows that arrived later explain it.");
    expect(text("br-check-history")).toBe("Earlier: off by $75.00 on Oct 2");
  });

  it("out of date: a grey 'Check is out of date', why, and Sync to check — never green, never the alarm", () => {
    h.review = review({ balanceCheck: check({ status: "matches", reason: null, stale: true, staleReason: "age", checkedAt: "2026-10-05T12:00:00.000Z", difference: "0.00" }) });
    mount();
    expect(screen.getByTestId("br-check").getAttribute("data-stale")).toBe("true");
    // greyed by the chip, never by fading the text (contrast stays ≥ 4.5:1)
    expect(screen.getByTestId("br-check").className).not.toContain("opacity");
    expect(screen.getByTestId("br-tie").className).toContain("gray");
    expect(screen.getByTestId("br-tie").className).not.toContain("ok");
    expect(text("br-tie")).toBe("Check is out of date");
    expect(text("br-check-line")).toBe("Last checked 9 days ago.");
    expect(text("br-check-sync")).toBe("Sync to check");
  });

  it("an out-of-date check that was off keeps the fact, greyed", () => {
    h.review = review({ balanceCheck: check({ status: "off_by", reason: null, stale: true, staleReason: "age", checkedAt: "2026-10-05T12:00:00.000Z", difference: "62.50", direction: "bank_lower" }) });
    mount();
    expect(text("br-tie")).toBe("Check is out of date");
    expect(text("br-check-line")).toBe("Last checked 9 days ago. It was off by $62.50 then.");
    expect(screen.getByTestId("br-tie").className).toContain("gray");
    expect(screen.queryByTestId("br-review-difference")).toBeNull();
  });

  it("(H4) a typed balance replaced the anchor: said as typed, and the reading under the balance says so too", () => {
    state(
      { status: "matches", reason: null, stale: true, staleReason: "anchor_changed", checkedAt: "2026-10-13T15:00:00.000Z", difference: "0.00" },
      {
        freshness: { source: "manual", fetchedAt: "2026-10-14T13:00:00.000Z", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null },
        balance: { today: "0.00", asOf: "2026-10-14T13:00:00.000Z", reading: "0.00", start: "0.00", end: "0.00", unavailableReason: null },
      },
    );
    expect(text("br-tie")).toBe("Check is out of date");
    expect(text("br-check-line")).toBe("A balance was typed in since the last check (Oct 13).");
    expect(text("br-bank-today")).toBe("Typed balance $0.00 (not from the bank) · Oct 14");
  });

  it.each([
    ["never", null],
    ["not_forecast_account", "H2 checks the planned account only."],
    ["anchor_too_old", "The last balance was too old to compare."],
    ["balance_unavailable", "The bank gave no balance."],
  ])("not checked (%s): grey, its reason in a few words", (reason, line) => {
    state({ status: "not_checked", reason, checkedAt: reason === "never" ? null : NOW });
    expect(text("br-tie")).toBe("Not checked");
    expect(screen.getByTestId("br-tie").className).toContain("gray");
    if (line) expect(text("br-check-line")).toBe(line);
    else expect(screen.queryByTestId("br-check-line")).toBeNull();
  });

  it("a clear review count does not turn a missing check green", () => {
    h.review = review({
      balanceCheck: check({ status: "not_checked", reason: "never" }),
      reviewInbox: { unresolvedInRange: 0, unresolvedScope: "this account · this period", unresolvedFrom: "2026-10-01", unresolvedTo: "2026-10-14", badgeCount: 0, badgeScope: "this calendar month, forecast account" },
    });
    mount();
    expect(text("br-inbox")).toBe("Nothing to match");
    expect(screen.getByTestId("br-tie").className).not.toContain("ok");
  });

  it("stays apart from the review count and from 'Updated'", () => {
    state({ status: "matches", reason: null, difference: "0.00" });
    expect(screen.getByTestId("br-tie-cell").textContent).not.toMatch(/reconcile|updated/i);
    expect(text("br-inbox")).toBe("15 charges to match");
    expect(text("br-fresh")).toContain("Updated");
  });
});

describe("(F4) Direction-aware words and the variance first", () => {
  const diff = () => {
    h.review = review({
      notInPlan: {
        ...review().notInPlan,
        amountDifference: totals(2, "2239.40", { varianceIn: "-108.60", varianceOut: "-12.00", moneyIn: "2391.40", moneyOut: "152.00" }),
      },
    });
    h.pages["amountDifference||"] = {
      bucket: "amountDifference", kind: null, limit: 25, nextCursor: null,
      rows: [
        rowOf("pay", {
          date: "2026-10-09", displayName: "Mapleworks Inc", amount: "2391.40", kind: "income", direction: "in",
          category: { id: "d", name: "Dining & Coffee" }, classificationIssue: "inflow_into_expense", reason: "amount",
          plan: { key: "p", label: "Pat's paycheck", scheduledDate: "2026-10-09", planned: "2500.00", difference: "-108.60", dayDelta: 0, eventKind: "income", direction: "in", expected: "2500.00", actual: "2391.40", variance: "-108.60", varianceKind: "less_than_expected" },
        }),
        rowOf("elec", {
          date: "2026-10-06", displayName: "City Electric", amount: "-152.00", reason: "amount",
          plan: { key: "e", label: "Electric", scheduledDate: "2026-10-06", planned: "-140.00", difference: "12.00", dayDelta: 0, eventKind: "bill", direction: "out", expected: "140.00", actual: "152.00", variance: "-12.00", varianceKind: "over_planned" },
        }),
        rowOf("under", {
          date: "2026-10-07", displayName: "Gas Co", amount: "-90.00", reason: "amount",
          plan: { key: "u", label: "Gas", scheduledDate: "2026-10-07", planned: "-100.00", difference: "-10.00", dayDelta: 0, eventKind: "bill", direction: "out", expected: "100.00", actual: "90.00", variance: "10.00", varianceKind: "under_planned" },
        }),
        rowOf("more", {
          date: "2026-10-08", displayName: "Bonus", amount: "130.00", kind: "income", direction: "in", reason: "amount",
          plan: { key: "m", label: "Bonus", scheduledDate: "2026-10-08", planned: "100.00", difference: "30.00", dayDelta: 0, eventKind: "income", direction: "in", expected: "100.00", actual: "130.00", variance: "30.00", varianceKind: "more_than_expected" },
        }),
      ],
    };
    mount("/banking?bucket=amountDifference");
  };

  it("income: Expected · received · $X less/more than expected; expense: Planned · paid · $X over/under", () => {
    diff();
    expect(text("br-plan-pay")).toBe("Expected $2,500.00 · received $2,391.40 · $108.60 less than expected");
    expect(text("br-plan-elec")).toBe("Planned $140.00 · paid $152.00 · $12.00 over");
    expect(text("br-plan-under")).toBe("Planned $100.00 · paid $90.00 · $10.00 under");
    expect(text("br-plan-more")).toBe("Expected $100.00 · received $130.00 · $30.00 more than expected");
  });

  it("the variance is the prominent number; the full amount is secondary and smaller", () => {
    diff();
    expect(text("br-variance-pay")).toBe("$108.60 less");
    expect(text("br-variance-elec")).toBe("$12.00 over");
    expect(screen.getByTestId("br-variance-pay").className).toContain("font-semibold");
    expect(screen.getByTestId("br-amount-pay").className).toContain("text-micro");
    expect(text("br-amount-pay")).toBe("+$2,391.40");
    // costs cash -> the wrong colour; an under / more is not
    expect(screen.getByTestId("br-variance-elec").className).toContain("text-bad-ink");
    expect(screen.getByTestId("br-variance-under").className).not.toContain("text-bad-ink");
  });

  it("the bucket card keeps money in and money out apart, each with its effect on cash", () => {
    diff();
    expect(text("br-side-amountDifference-in")).toBe("Income $108.60 less");
    expect(text("br-side-amountDifference-out")).toBe("Bills $12.00 over");
    expect(text("br-sides-amountDifference")).not.toMatch(/cash|−|-\$96.60/);
    // The pill says the variance; money in and out are in the aria and, once selected, the heading: never a net.
    expect(screen.queryByTestId("br-inout-amountDifference-in")).toBeNull();
    expect(text("br-sel-in")).toBe("In $2,391.40");
    expect(text("br-sel-out")).toBe("Out $152.00");
    expect(text("br-sel-note")).toBe("Income $108.60 less than expected · Bills $12.00 over");
    expect(screen.queryByTestId("br-net-amountDifference")).toBeNull();
    expect(screen.getByTestId("br-bucket-amountDifference").textContent).not.toMatch(/total moved|2,239/);
    // (Q5 fix) the variance lines the card shows lead its accessible name
    expect(screen.getByTestId("br-bucket-amountDifference").getAttribute("aria-label")).toBe("Amount differences: Income $108.60 less than expected, Bills $12.00 over, 2 rows, money in $2,391.40, money out $152.00");
  });

  it("a bucket with nothing comparing, or an exact one, shows no variance line", () => {
    h.review = review({ notInPlan: { ...review().notInPlan, timingDifference: totals(1, "-40.00", { varianceOut: "0.00" }) } });
    mount();
    expect(screen.queryByTestId("br-sides-timingDifference")).toBeNull();
    expect(screen.queryByTestId("br-sides-unmatched")).toBeNull();
  });

  it("a row filed against its direction carries 'Filed as … — looks like income' and a link to Categories", () => {
    diff();
    expect(text("br-issue-pay")).toContain("Filed as Dining & Coffee — looks like income");
    expect(within(screen.getByTestId("br-issue-pay")).getByText("Categories").getAttribute("href")).toBe("/review/categories");
    expect(screen.queryByTestId("br-issue-elec")).toBeNull();
  });

  it("the banner for rows the review could not place never says 'unexplained'", () => {
    h.review = review({ reconciliation: { rowsPlaced: 21, rowsUnexplained: 1, unexplained: "18.40" } });
    mount();
    expect(screen.getByTestId("banking-review").textContent).not.toMatch(/unexplained/i);
  });
});

describe("(F4) Proposed fixes", () => {
  const proposals = () => ({
    window: { from: "2026-06-17", to: "2026-10-14", days: 120 }, count: 2, truncated: false,
    items: [
      {
        key: "k1", proposalHash: "h1", kind: "loan_payment", rowCount: 6, truncated: false, total: "3451.20",
        rows: [1, 2, 3, 4, 5, 6].map((i) => ({
          id: `lp${i}`, date: `2026-0${i + 3 > 9 ? 9 : i + 3}-13`, displayName: "Larkspur Lending", description: "LARKSPUR", amount: "-592.60", pending: false,
          source: "plaid:chase", account: { id: "a", institution: "Chase", name: "Total Checking", mask: "4321", externalId: "ext-chk" }, category: null, occurrence: null,
        })),
        evidence: [{ field: "pfc_primary", value: "LOAN_PAYMENTS" }, { field: "pfc_detailed", value: "LOAN_PAYMENTS_OTHER_PAYMENT" }, { field: "name_match", value: "LARKSPUR LENDING ~ HELOC" }, { field: "amount_match", value: "592.60 ~ 575.00" }],
        action: { code: "file_as_bill_payment", target: { kind: "bill", id: "b1", label: "HELOC", categoryId: null, categoryName: null } },
        applyWith: ["review_mark_matched", "categories_change"],
      },
      {
        key: "k2", proposalHash: "h2", kind: "income_category", rowCount: 1, truncated: false, total: "2391.40",
        rows: [{ id: "pp", date: "2026-10-09", displayName: "Mapleworks Inc", description: "MAPLEWORKS", amount: "2391.40", pending: false, source: "plaid:chase", account: { id: "a", institution: "Chase", name: "Total Checking", mask: "4321", externalId: "ext-chk" }, category: { id: "d", name: "Dining" }, occurrence: null }],
        evidence: [{ field: "pfc_primary", value: "INCOME" }],
        action: { code: "file_under_income_category", target: { kind: "category", id: "c", label: "Paycheck", categoryId: "c", categoryName: "Paycheck" } },
        applyWith: ["categories_change"],
      },
    ],
  });

  it("(Round 3) two proposals of one kind never share a control name: Preview, Apply and Why? carry their own subject", () => {
    const base = proposals();
    const bm = (key: string, who: string, amount: string) => ({
      ...base.items[1]!, key, proposalHash: `h-${key}`, kind: "bill_match", rowCount: 1, total: amount,
      rows: [{ ...(base.items[1]!.rows[0] as object), id: `r-${key}`, displayName: who, amount, date: "2026-10-12" }],
      evidence: [{ field: "pfc_primary", value: "A" }, { field: "name_match", value: "X ~ Y" }, { field: "amount_match", value: "1.00 ~ 2.00" }],
      action: { code: "confirm_bill_match", target: { kind: "bill", id: key, label: who, categoryId: null, categoryName: null } },
    });
    h.proposals = { ...base, count: 2, items: [bm("a", "Shieldline Life", "-45.00"), bm("b", "Northwind Power", "-120.00")] };
    mount("/banking?fixes=1");
    for (const verb of ["Preview", "Apply"]) {
      const names = screen.getAllByRole("button", { name: new RegExp(`^${verb}:`) }).map((b) => b.getAttribute("aria-label"));
      expect(new Set(names).size).toBe(2);
    }
    const why = screen.getAllByText("Why?").map((el) => el.getAttribute("aria-label"));
    expect(new Set(why).size).toBe(2);
    expect(why[0]).toContain("Shieldline Life");
  });

  it("is asked on load, so the summary says how many wait and for what scope; it never opens by itself", () => {
    h.proposals = proposals();
    mount();
    expect(h.proposalCalls).toBeGreaterThan(0);
    expect(text("br-fixes-count")).toBe("2");
    expect(text("br-fixes-title")).toBe("2 proposed fixes");
    expect(text("br-fixes-scope")).toBe("All accounts · last 120 days");
    expect((screen.getByTestId("br-fixes") as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryAllByTestId("br-fix")).toHaveLength(0);
  });

  it("while the count is on its way the summary keeps its two lines (nothing below moves), and shows no count", () => {
    h.proposals = undefined as never;
    mount();
    expect(screen.getByTestId("br-fixes-scope")).toBeTruthy();
    expect(screen.queryByTestId("br-fixes-count")).toBeNull();
  });

  it("with nothing proposed it stays closed", () => {
    h.proposals = { window: { from: "a", to: "b", days: 120 }, count: 0, truncated: false, items: [] };
    mount();
    expect(text("br-fixes-count")).toBe("0");
    expect((screen.getByTestId("br-fixes") as HTMLDetailsElement).open).toBe(false);
  });

  it("lists the rows (each opens its record), the evidence, the proposed change with its scope, and Preview / Apply for the owner", () => {
    h.proposals = proposals();
    mount("/banking?fixes=1");
    const fixes = screen.getAllByTestId("br-fix");
    expect(fixes).toHaveLength(2);
    const first = within(fixes[0]!);
    expect(first.getAllByTestId("br-fix-row")).toHaveLength(4); // the first four; "Show all" lists the rest
    expect(first.getByTestId("br-fix-rows-toggle").textContent).toBe("Show all 6 rows");
    fireEvent.click(first.getByTestId("br-fix-rows-toggle"));
    expect(first.getAllByTestId("br-fix-row")).toHaveLength(6);
    expect(first.getByTestId("br-fix-rows-toggle").textContent).toBe("Show fewer");
    // every row opens its record through the one route rule (account, month, row)
    const href = first.getAllByTestId("br-fix-row-link")[0]!.getAttribute("href")!;
    const u = new URL(href, "http://x");
    expect(u.pathname).toBe("/transactions");
    expect(u.searchParams.get("account")).toBe("acct-chk");
    expect(u.searchParams.get("tx")).toBe("lp1");
    expect(first.getByTestId("br-fix-total").textContent).toBe("$3,451.20");
    // One line: the first two facts; the rest are behind Why?
    expect(first.getByTestId("br-fix-evidence").textContent).toBe("Bank says loan payments · Name fits HELOC");
    expect(first.getByTestId("br-fix-why-lines").textContent).toBe("Bank says loan payments · Name fits HELOC · Amount $592.60 vs $575.00 planned");
    // each control has a name of its own (a screen reader hears more than "Preview, Apply, Preview, Apply")
    expect(first.getByTestId("br-fix-preview").getAttribute("aria-label")).toBe("Preview: File as a payment of HELOC: Larkspur Lending -$592.60, Apr 13 and 5 more");
    expect(first.getByTestId("br-fix-apply").getAttribute("aria-label")).toBe("Apply: File as a payment of HELOC: Larkspur Lending -$592.60, Apr 13 and 5 more");
    expect(first.getByTestId("br-fix-action").textContent).toBe("Proposed: File as a payment of HELOC");
    expect(first.getByTestId("br-fix-scope").textContent).toBe("Changes 6 rows");
    expect(first.getByTestId("br-fix-preview").textContent).toBe("Preview");
    expect(first.getByTestId("br-fix-apply").textContent).toBe("Apply");
    expect(first.getByTestId("br-fix-link-match").getAttribute("href")).toBe("/review");
    expect(first.getByTestId("br-fix-link-match").textContent).toBe("In Review");
    expect(first.getByTestId("br-fix-link-categories").getAttribute("href")).toBe("/review/categories");
    const second = within(fixes[1]!);
    expect(second.getByTestId("br-fix-action").textContent).toBe("Proposed: File under Paycheck (income)");
    expect(second.queryByTestId("br-fix-link-match")).toBeNull();
    expect(text("br-fixes-count")).toBe("2");
    // nothing is applied by opening the list
    expect(screen.queryByTestId("fix-dialog")).toBeNull();
  });

  it("?fixes=1 opens the panel and scrolls to it once the page has its answer", () => {
    h.proposals = proposals();
    const scroll = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      mount("/banking?fixes=1");
      expect(scroll).toHaveBeenCalledTimes(1);
      expect((scroll.mock.contexts[0] as HTMLElement).id).toBe("proposed-fixes");
      expect((screen.getByTestId("br-fixes") as HTMLDetailsElement).open).toBe(true);
      cleanup();
      scroll.mockClear();
      mount("/banking");
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("a member is told who applies, and nothing is asked of the server (it answers a member 403)", () => {
    h.owner = false;
    h.proposals = proposals();
    mount("/banking?fixes=1");
    expect(text("br-fixes-member")).toBe("The household owner applies fixes.");
    expect(screen.queryByTestId("br-fixes")).toBeNull();
    expect(screen.queryByTestId("br-fix")).toBeNull();
    expect(h.proposalCalls).toBe(0);
  });

  it("nothing to propose says so", () => {
    h.proposals = { window: { from: "a", to: "b", days: 120 }, count: 0, truncated: false, items: [] };
    mount("/banking?fixes=1");
    expect(text("br-fixes-none")).toBe("Nothing to propose right now.");
  });
});

describe("(Q4) Banking: no other account's review under this account's name", () => {
  it("the review on screen is still another range's: a skeleton, not its balance and buckets", () => {
    h.placeholder = true;
    mount("/banking?account=acct-sav&from=2026-09-01&to=2026-09-30");
    expect(screen.getByTestId("br-loading")).toBeTruthy();
    expect(screen.queryByTestId("br-summary")).toBeNull();
    expect(screen.queryByTestId("br-balance")).toBeNull();
    expect(screen.queryByTestId("br-notinplan")).toBeNull();
  });

  it("a Show more answer that lands after the range changed is dropped", async () => {
    h.pages["unmatched||"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: "CUR1", rows: [rowOf("p1")] };
    h.pages["unmatched||CUR1"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: null, rows: [rowOf("p2")] };
    let release: () => void = () => {};
    h.hold = new Promise<void>((r) => (release = r));
    mount();
    fireEvent.click(screen.getByTestId("br-more"));
    // The person picks another range while the cursor is out.
    fireEvent.click(screen.getByTestId("br-preset-last"));
    h.hold = null;
    await act(async () => release());
    expect(screen.queryByTestId("br-row-p2")).toBeNull();
  });
});
