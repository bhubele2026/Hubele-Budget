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
}));

vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react")>()),
  useListPlaidItems: () => ({ data: h.items, isError: false, isLoading: false }),
}));
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react/features")>()),
  useGetBankingReview: (params: Record<string, unknown>) => {
    h.calls.push(params);
    if (h.error) return { data: undefined, isError: true, isLoading: false, refetch: vi.fn() };
    const key = params.bucket ? `${params.bucket}|${params.kind ?? ""}|${params.cursor ?? ""}` : "";
    const page = key ? (h.pages[key] ?? { bucket: params.bucket, kind: params.kind ?? null, rows: [], nextCursor: null, limit: 25 }) : null;
    return { data: h.review && { ...h.review, page }, isError: false, isLoading: false, refetch: vi.fn() };
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
  reason: "no_plan",
  evidence: null,
  plan: null,
  ...o,
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

  it("a tie that holds reads 'Ties to bank'; a drift reads 'Off by $X'", () => {
    h.review = review({ balanceTie: { status: "ties", checkedAt: "2026-10-14T15:00:00.000Z", unexplained: "0.00" } });
    mount();
    expect(text("br-tie")).toBe("Ties to bank");
    cleanup();
    h.review = review({ balanceTie: { status: "drift", checkedAt: "2026-10-14T15:00:00.000Z", unexplained: "-12.34" } });
    mount();
    expect(text("br-tie")).toBe("Off by $12.34");
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
          plan: { key: "k", label: "Cap One minimum", scheduledDate: "2026-10-02", planned: "-40.00", difference: "260.00", dayDelta: 2 },
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
    expect(text("br-plan-r1")).toBe("Planned $40.00 on Oct 2 → paid $300.00 on Oct 4 (+$260.00 / 2 days late)");
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

  it("pages with the server's cursor", () => {
    h.pages["unmatched||"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: "CUR1", rows: [rowOf("p1")] };
    h.pages["unmatched||CUR1"] = { bucket: "unmatched", kind: null, limit: 25, nextCursor: null, rows: [rowOf("p2")] };
    mount();
    expect(screen.queryByTestId("br-row-p2")).toBeNull();
    fireEvent.click(screen.getByTestId("br-more"));
    expect(screen.getByTestId("br-row-p1")).toBeTruthy();
    expect(screen.getByTestId("br-row-p2")).toBeTruthy();
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
    expect(screen.queryByTestId("br-unexplained")).toBeNull();
  });

  it("unexplained ≠ 0 shows an honest notice instead of hiding it", () => {
    h.review = review({ reconciliation: { rowsPlaced: 21, rowsUnexplained: 1, unexplained: "18.40" } });
    mount();
    expect(text("br-unexplained")).toBe("Some rows couldn't be placed: $18.40");
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
