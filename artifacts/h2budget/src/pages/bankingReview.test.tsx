import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
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
}));
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react/features")>()),
  getBankingReview: async (params: Record<string, unknown>) => {
    h.calls.push({ ...params, via: "fetch" });
    const key = `${params.bucket}|${params.kind ?? ""}|${params.cursor ?? ""}`;
    return { ...h.review, page: h.pages[key] ?? { bucket: params.bucket, kind: params.kind ?? null, rows: [], nextCursor: null, limit: 25 } };
  },
  getGetReviewProposalsQueryKey: () => ["/api/review/proposals"],
  useGetReviewProposals: (opts?: { query?: { enabled?: boolean } }) => {
    if (opts?.query?.enabled === false) return { data: undefined, isError: false, refetch: vi.fn() };
    h.proposalCalls += 1;
    return { data: h.proposals, isError: false, refetch: vi.fn() };
  },
  useGetBankingReview: (params: Record<string, unknown>, opts?: { query?: { enabled?: boolean } }) => {
    if (opts?.query?.enabled === false) return { data: undefined, isError: false, isLoading: false, refetch: vi.fn() };
    h.calls.push(params);
    if (h.error) return { data: undefined, isError: true, isLoading: false, refetch: vi.fn() };
    const key = params.bucket ? `${params.bucket}|${params.kind ?? ""}|${params.cursor ?? ""}` : "";
    const page = key ? (h.pages[key] ?? { bucket: params.bucket, kind: params.kind ?? null, rows: [], nextCursor: null, limit: 25 }) : null;
    // (P4) The summary carries each bucket's first page, as the server does.
    const seeded = h.review && !params.bucket ? withFirstPages(h.review, h.pages) : h.review;
    return { data: seeded && { ...seeded, page }, isError: false, isLoading: false, refetch: vi.fn() };
  },
}));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => <button data-testid="own-sync">Sync</button> }));

import BankingReviewPage from "./command-center";

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
const kt = (count: number, net: string) => ({ count, moneyIn: "0.00", moneyOut: "0.00", net, pendingNet: "0.00" });
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
  balance: { today: "3205.81", asOf: "2026-10-14T13:00:00.000Z", start: "3000.00", end: "3205.81", unavailableReason: null },
  freshness: { source: "plaid", lastContactAt: "2026-10-14T16:00:00.000Z", lastFailureAt: null, stale: false, staleReason: null },
  cashFlow: { moneyIn: "2425.00", moneyOut: "2219.19", net: "205.81", count: 23, pendingNet: "-6.50", supersededExcluded: 1, otherExcluded: 0 },
  planComparison: { available: true, reason: null, comparedFrom: "2026-08-16", plansFrom: "2026-09-01", through: "2026-10-14" },
  planned: [
    { key: "a|2026-10-01", itemId: "a", label: "Gym Membership", scheduledDate: "2026-10-01", occurrenceDate: "2026-10-01", planned: "-40.00", fate: "matched", txnId: "t1", txnDate: "2026-10-08", txnAmount: "-40.00", txnOnThisAccount: true, difference: "0.00", dayDelta: 7, remainder: null, onCurve: false, hook: null },
    { key: "b|2026-10-12", itemId: "b", label: "Water", scheduledDate: "2026-10-12", occurrenceDate: "2026-10-12", planned: "-60.00", fate: "missed", txnId: null, txnDate: null, txnAmount: null, txnOnThisAccount: false, difference: null, dayDelta: null, remainder: null, onCurve: true, hook: null },
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
  reviewInbox: { unresolvedInRange: 15, badgeCount: 16, badgeScope: "this calendar month, forecast account" },
  balanceTie: { status: "not_checked", checkedAt: null, unexplained: null },
  balanceCheck: check({}),
  household: { scope: "all accounts · this week", weekStart: "2026-10-11", weekEnd: "2026-10-17", spentWeek: "124.00", weekPlan: null, remainingWeek: null },
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
  h.proposals = undefined;
  h.proposalCalls = 0;
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
    expect(text("br-fresh")).toContain("Synced 1 hour ago");
    expect(screen.getByTestId("br-preset-month").getAttribute("aria-pressed")).toBe("true");
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

  it("Balance check and Review inbox are separate things", () => {
    mount();
    expect(within(screen.getByTestId("br-tie-cell")).getByText("Balance check")).toBeTruthy();
    expect(within(screen.getByTestId("br-inbox-cell")).getByText("Review inbox")).toBeTruthy();
    expect(text("br-tie")).toBe("Not checked yet");
    expect(text("br-inbox")).toBe("16 to review this month");
    // The inbox's real scope is in its tooltip, not in a claim about the balance.
    expect(screen.getByTestId("br-inbox-cell").innerHTML).toContain("this calendar month, forecast account");
    expect(screen.getByTestId("br-tie-cell").textContent).not.toMatch(/review/i);
  });

  it("an empty inbox reads 'Review inbox clear'", () => {
    h.review = review({ reviewInbox: { unresolvedInRange: 0, badgeCount: 0, badgeScope: "this calendar month, forecast account" } });
    mount();
    expect(text("br-inbox")).toBe("Review inbox clear");
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
    const expected: Array<[string, string, string]> = [
      ["unmatched", "9", "-$737.80"],
      ["amountDifference", "4", "-$643.40"],
      ["timingDifference", "1", "-$40.00"],
      ["confirmedUnplanned", "3", "-$132.50"],
      ["uncertain", "2", "-$145.00"],
    ];
    for (const [name, count, net] of expected) {
      expect(text(`br-count-${name}`)).toBe(count);
      expect(text(`br-net-${name}`)).toBe(net);
    }
    const titles = ["Unmatched", "Different amount", "Different date", "Marked not in plan", "Not sure"];
    for (const t of titles) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Paid, but not on the plan").length).toBeGreaterThan(0);
    expect(screen.getByText("H2 can't tell yet")).toBeTruthy();
  });

  it("the section is open by default", () => {
    mount();
    expect((screen.getByTestId("br-notinplan") as HTMLDetailsElement).open).toBe(true);
    expect((screen.getByTestId("br-planned") as HTMLDetailsElement).open).toBe(false);
  });

  it("Unmatched is split by kind, with the note that card and debt payments are not overspending", () => {
    mount();
    const kinds = screen.getByTestId("br-kinds");
    expect(text("br-kind-card_payment")).toContain("Card payment");
    expect(text("br-kind-card_payment")).toContain("-$250.00");
    expect(text("br-kind-debt_payment")).toContain("-$300.00");
    expect(kinds.textContent).toContain("Card and debt payments are not overspending.");
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
    expect(screen.getByTestId("br-detail").textContent).toContain("Unmatched · Card payment");
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
    expect(text("br-no-compare")).toContain("Not sure");
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

  it("household: labelled, secondary, 'Plan not set' is never $0", () => {
    mount();
    const box = screen.getByTestId("br-household");
    expect(box.textContent).toContain("All accounts · this week");
    expect(text("br-hh-spent")).toBe("$124.00");
    expect(text("br-hh-plan")).toBe("Plan not set");
    expect(within(box).getByText("Open this week →").getAttribute("href")).toBe("/spending/week");
    // It comes last.
    const planned = screen.getByTestId("br-planned");
    expect(planned.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("household with a plan shows it", () => {
    h.review = review({ household: { scope: "all accounts · this week", weekStart: "2026-10-11", weekEnd: "2026-10-17", spentWeek: "124.00", weekPlan: "300.00", remainingWeek: "176.00" } });
    mount();
    expect(text("br-hh-plan")).toBe("$300.00");
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

describe("(F4) Balance check — five honest states", () => {
  const NOW = "2026-10-14T15:00:00.000Z";
  const state = (o: Record<string, unknown>) => {
    h.review = review({ balanceCheck: check({ checkedAt: NOW, ...o }) });
    mount();
  };

  it("matches: 'Matches bank', checked when", () => {
    state({ status: "matches", reason: null, difference: "0.00", bank: { balance: "2985.00", at: NOW, field: "available" }, h2: { balance: "2985.00" } });
    expect(text("br-tie")).toBe("Matches bank");
    expect(screen.getByTestId("br-tie").className).toContain("ok");
    expect(text("br-check-when")).toBe("Checked 2 hours ago");
    expect(screen.queryByTestId("br-investigate")).toBeNull();
  });

  it("off by: the amount, which way, and Investigate with the register", () => {
    state({ status: "off_by", reason: null, difference: "62.50", direction: "bank_lower", bank: { balance: "2985.00", at: NOW, field: "available" }, h2: { balance: "3047.50" } });
    expect(text("br-tie")).toBe("Off by $62.50");
    expect(screen.getByTestId("br-tie").className).toContain("bad");
    expect(text("br-check-direction")).toBe("Bank is $62.50 lower than H2");
    expect(screen.getByTestId("br-investigate").textContent).toBe("Investigate");
    expect(screen.getByTestId("br-check-register").getAttribute("href")).toBe("/transactions?account=acct-chk&month=2026-10-01");
  });

  it("bank higher reads the other way", () => {
    state({ status: "off_by", reason: null, difference: "10.00", direction: "bank_higher" });
    expect(text("br-check-direction")).toBe("Bank is $10.00 higher than H2");
  });

  it("resolved since: says so, and what it was", () => {
    state({ status: "resolved_since", reason: null, difference: "2000.00", direction: "bank_higher", lastDrift: { checkedAt: NOW, difference: "2000.00", direction: "bank_higher" } });
    expect(text("br-tie")).toBe("Resolved since");
    expect(text("br-check-was")).toContain("It was off by $2,000.00");
  });

  it("stale: greyed, and 'Checked N days ago — Sync to recheck'", () => {
    h.review = review({ balanceCheck: check({ status: "matches", reason: null, stale: true, staleReason: "age", checkedAt: "2026-10-05T12:00:00.000Z", difference: "0.00" }) });
    mount();
    expect(screen.getByTestId("br-check").getAttribute("data-stale")).toBe("true");
    // greyed by the chip, never by fading the text (contrast stays ≥ 4.5:1)
    expect(screen.getByTestId("br-check").className).not.toContain("opacity");
    expect(screen.getByTestId("br-tie").className).toContain("gray");
    expect(text("br-check-when")).toBe("Checked 9 days ago — Sync to recheck");
  });

  it.each([
    ["never", "A Sync on the register checks it."],
    ["not_forecast_account", "H2 checks the balance on the planned account only."],
    ["anchor_too_old", "The last balance was too old to check. Sync again."],
    ["balance_unavailable", "The bank gave no balance. Sync again."],
  ])("not checked yet (%s) gives the reason in words", (reason, words) => {
    state({ status: "not_checked", reason, checkedAt: reason === "never" ? null : NOW });
    expect(text("br-tie")).toBe("Not checked yet");
    expect(text("br-check-reason")).toBe(words);
  });

  it("stays apart from the review inbox and the synced line", () => {
    state({ status: "matches", reason: null, difference: "0.00" });
    expect(screen.getByTestId("br-tie-cell").textContent).not.toMatch(/review inbox|synced/i);
    expect(text("br-inbox")).toBe("16 to review this month");
    expect(text("br-fresh")).toContain("Synced");
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
    expect(text("br-amount-pay")).toBe("$2,391.40");
    // costs cash -> the wrong colour; an under / more is not
    expect(screen.getByTestId("br-variance-elec").className).toContain("text-bad-ink");
    expect(screen.getByTestId("br-variance-under").className).not.toContain("text-bad-ink");
  });

  it("the bucket card keeps money in and money out apart, each with its effect on cash", () => {
    diff();
    expect(text("br-side-amountDifference-in")).toContain("Income $108.60 less than expected");
    expect(text("br-side-amountDifference-in")).toContain("−$108.60 cash");
    expect(text("br-side-amountDifference-out")).toContain("Bills $12.00 over");
    expect(text("br-side-amountDifference-out")).toContain("−$12.00 cash");
    expect(text("br-sides-amountDifference")).not.toContain("-$96.60");
    // the rows' full amount stays visible but is labelled, so it never reads as the difference
    expect(text("br-net-amountDifference")).toBe("$2,239.40 total moved");
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
        key: "k1", kind: "loan_payment", rowCount: 6, truncated: false, total: "3451.20",
        rows: [1, 2, 3, 4, 5, 6].map((i) => ({
          id: `lp${i}`, date: `2026-0${i + 3 > 9 ? 9 : i + 3}-13`, displayName: "Larkspur Lending", description: "LARKSPUR", amount: "-592.60", pending: false,
          account: { id: "a", institution: "Chase", name: "Total Checking", mask: "4321" }, category: null, occurrence: null,
        })),
        evidence: [{ field: "pfc_primary", value: "LOAN_PAYMENTS" }, { field: "pfc_detailed", value: "LOAN_PAYMENTS_OTHER_PAYMENT" }, { field: "name_match", value: "LARKSPUR LENDING ~ HELOC" }, { field: "amount_match", value: "592.60 ~ 575.00" }],
        action: { code: "file_as_bill_payment", target: { kind: "bill", id: "b1", label: "HELOC", categoryId: null, categoryName: null } },
        applyWith: ["review_mark_matched", "categories_change"],
      },
      {
        key: "k2", kind: "income_category", rowCount: 1, truncated: false, total: "2391.40",
        rows: [{ id: "pp", date: "2026-10-09", displayName: "Mapleworks Inc", description: "MAPLEWORKS", amount: "2391.40", pending: false, account: { id: "a", institution: "Chase", name: "Total Checking", mask: "4321" }, category: { id: "d", name: "Dining" }, occurrence: null }],
        evidence: [{ field: "pfc_primary", value: "INCOME" }],
        action: { code: "file_under_income_category", target: { kind: "category", id: "c", label: "Paycheck", categoryId: "c", categoryName: "Paycheck" } },
        applyWith: ["categories_change"],
      },
    ],
  });

  it("is closed by default and reads nothing until it is opened", () => {
    h.proposals = proposals();
    mount();
    expect((screen.getByTestId("br-fixes") as HTMLDetailsElement).open).toBe(false);
    expect(h.proposalCalls).toBe(0);
  });

  it("lists the rows, the evidence, the proposed action and the link that applies it; applies nothing", () => {
    h.proposals = proposals();
    mount("/banking?fixes=1");
    const fixes = screen.getAllByTestId("br-fix");
    expect(fixes).toHaveLength(2);
    const first = within(fixes[0]!);
    expect(first.getAllByTestId("br-fix-row")).toHaveLength(4); // the first four; the rest are counted
    expect(fixes[0]!.textContent).toContain("and 2 more");
    expect(first.getByTestId("br-fix-total").textContent).toBe("$3,451.20");
    expect(first.getByTestId("br-fix-evidence").textContent).toBe("Bank says loan payments · Name fits HELOC · Amount $592.60 vs $575.00 planned");
    expect(first.getByTestId("br-fix-action").textContent).toBe("Proposed: File as a payment of HELOC");
    expect(first.getByTestId("br-fix-link-match").getAttribute("href")).toBe("/review");
    expect(first.getByTestId("br-fix-link-categories").getAttribute("href")).toBe("/review/categories");
    const second = within(fixes[1]!);
    expect(second.getByTestId("br-fix-action").textContent).toBe("Proposed: File under Paycheck (income)");
    expect(second.queryByTestId("br-fix-link-match")).toBeNull();
    // read-only: no button anywhere in the panel
    expect(within(screen.getByTestId("br-fixes")).queryAllByRole("button")).toHaveLength(0);
    expect(text("br-fixes-count")).toBe("2");
  });

  it("nothing to propose says so", () => {
    h.proposals = { window: { from: "a", to: "b", days: 120 }, count: 0, truncated: false, items: [] };
    mount("/banking?fixes=1");
    expect(text("br-fixes-none")).toBe("Nothing to propose right now.");
  });
});
