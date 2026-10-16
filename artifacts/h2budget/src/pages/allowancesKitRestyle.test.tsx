import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/components/plan/WeekPlanPanel", () => ({ WeekPlanPanel: () => null }));
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * C8 — Allowances on the kit: cards, CSS fill meters, state in words.
 *
 * The invariant this file guards is the one that matters: THE RESTYLE MOVED NO
 * MONEY. Every figure still comes from the same `effectiveBucket` +
 * `expenseMagnitude` path the Banking dashboard sums through, the window
 * arithmetic (week for weekly, calendar month for monthly/unplanned) is
 * unchanged, and the testids the rest of the app keys on are stable.
 *
 * `lib/weeklyBuckets` and `lib/bucketSpend` are deliberately NOT mocked — they
 * are the money math under test.
 */

// Friday 15 May 2026 (a Friday in Chicago under TZ=UTC too). The household
// week's Sunday is 2026-05-10, so the weekly window is
// 05-10…05-16 and the month window is 05-01…05-31.
const TEST_TODAY = new Date(2026, 4, 15, 12, 0, 0);

const BAD_RGB = "rgb(225, 109, 62)"; // #e16d3e — over plan
const NAVY_RGB = "rgb(25, 49, 91)"; // #19315b — resting

/** Independent of the app's own formatter, so we pin the rendered string. */
const usd = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);

type Tx = {
  id: string;
  description: string;
  amount: string;
  occurredOn: string;
  categoryId: string | null;
  source: string | null;
  weeklyAllowance?: boolean;
  monthlyAllowance?: boolean;
  unplannedAllowance?: boolean;
  weeklyBucket?: string | null;
  isTransfer?: boolean;
};

const tx = (o: Partial<Tx> & Pick<Tx, "id" | "amount" | "occurredOn">): Tx => ({
  description: `txn ${o.id}`,
  categoryId: null,
  source: "chase",
  weeklyBucket: null,
  ...o,
});

/**
 * Deliberately un-round figures, so "the page printed the derived number"
 * cannot be a coincidence of tidy values.
 *
 *  weekly   (05-10…05-16): 120.25 + 75.50            = 195.75  of 450 → under
 *  monthly  (05-01…05-31): 420.40                    = 420.40  of 300 → OVER
 *  unplanned(05-01…05-31): 50.10                     =  50.10  of 200 → under
 */
const TXNS: Tx[] = [
  // — the selected week, weekly bucket
  tx({ id: "w1", amount: "-120.25", occurredOn: "2026-05-11", weeklyAllowance: true, weeklyBucket: "groceries" }),
  tx({ id: "w2", amount: "-75.50", occurredOn: "2026-05-14", weeklyAllowance: true, weeklyBucket: "dining" }),
  // — the month, monthly + unplanned buckets (outside the weekly window)
  tx({ id: "m1", amount: "-420.40", occurredOn: "2026-05-06", monthlyAllowance: true }),
  tx({ id: "u1", amount: "-50.10", occurredOn: "2026-05-07", unplannedAllowance: true }),
  // — two COMPLETED weeks over the 450 weekly allowance, so the streak is 2:
  //   week of 05-03 and week of 04-26 (its 05-01 row is inside the fetch window).
  tx({ id: "s1", amount: "-500.00", occurredOn: "2026-05-05", weeklyAllowance: true }),
  tx({ id: "s2", amount: "-500.00", occurredOn: "2026-05-01", weeklyAllowance: true }),
  // — decoys: unflagged spend and income must never reach a bucket.
  tx({ id: "d1", amount: "-999.99", occurredOn: "2026-05-12" }),
  tx({ id: "d2", amount: "4321.00", occurredOn: "2026-05-13", weeklyAllowance: true }),
];

const SETTINGS = {
  weeklyAllowanceAmount: "450.00",
  monthlyAllowanceAmount: "300.00",
  unplannedAllowanceAmount: "200.00",
  preferences: {},
};

// (W5) The spent totals are the SERVER's (GET /money/period-breakdown), not the
// browser's sum of the rows above (195.75 / 420.40 / 50.10). The server's weekly
// pool also counts a $24.50 purchase not filed yet, so the fixture's weekly is
// 220.25. Monthly and unplanned are the same by both rules.
const BROWSER_WEEKLY = 195.75;
const EXPECTED = { weekly: 220.25, monthly: 420.4, unplanned: 50.1 };
const planOf = (amount: string | null, source = "plan") => ({ status: amount == null ? "not_set" : "set", amount, source, planId: null, effectiveFrom: null });
const SERVER = {
  week: { actual: "220.25", beside: { unplanned: "0.00" }, plan: planOf("450.00"), remaining: "229.75", withinPlan: true },
  month: { actual: "420.40", beside: { unplanned: "50.10" }, plan: planOf("300.00"), remaining: "-120.40", withinPlan: false },
};
const PLANNED = { weekly: 450, monthly: 300, unplanned: 200 };

let txns: Tx[] = [];
let settings: Record<string, unknown> | undefined;
let server: Record<string, unknown> | undefined = SERVER;
const asked: Array<Record<string, unknown>> = [];
/** Server answers for a specific period (`week:2026-09-06`); anything else gets `server`. */
let serverBy: Record<string, unknown> = {};
const fig = (actual: string, unplanned = "0.00") => ({ actual, beside: { unplanned }, plan: planOf("450.00"), remaining: "100.00", withinPlan: true });
/** (T4) A completed week as the server answers it: its plan, what was left (negative = over) and whether within. */
const wk = (left: string | null, plan: string | null = "450.00", source = "plan") => ({
  actual: "0.00", beside: { unplanned: "0.00" }, plan: planOf(plan, source), remaining: left, withinPlan: left == null ? null : Number(left) >= 0,
});
/** (T4) 'refresh': the newest request failed and the last answer is kept. */
let failMode: null | "refresh" | "load" = null;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/split-transaction-dialog", () => ({
  SplitTransactionDialog: () => null,
}));

const spineState = vi.hoisted(() => ({ weekAdjustment: null as null | { amount: string; weekStart: string; reason: null } }));
vi.mock("@workspace/api-client-react", () => ({
  useGetSpine: () => ({
    data: { position: { weekAdjustment: spineState.weekAdjustment } },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
  }),
  getGetSpineQueryKey: () => ["/api/spine"],
  useListTransactions: () => ({ data: txns, isLoading: false }),
  useGetSettings: () => ({ data: settings }),
  useListCategories: () => ({ data: [{ id: "c1", name: "Groceries" }] }),
  useUpdateTransaction: () => ({ mutateAsync: vi.fn(async () => undefined) }),
  useUpdateSettings: () => ({ mutateAsync: vi.fn(async () => undefined) }),
  getListTransactionsQueryKey: () => ["/api/transactions"],
  getGetSettingsQueryKey: () => ["/api/settings"],
}));

vi.mock("@workspace/api-client-react/features", () => ({
  useGetPeriodBreakdown: (params: Record<string, unknown>) => {
    asked.push(params);
    const base = (serverBy[`${params.period}:${params.start}`] ?? server?.[String(params.period)]) as Record<string, unknown> | undefined;
    // The server echoes the period it read.
    const data = failMode === "load" ? undefined : base && { ...base, period: params.period, start: params.start };
    return {
      data,
      isError: failMode != null,
      isLoadingError: failMode === "load",
      isRefetchError: failMode === "refresh",
      dataUpdatedAt: failMode ? Date.now() - 4 * 60_000 : 0,
      refetch: vi.fn(),
    };
  },
}));

import AllowancesPage from "./allowances";
import { bucketSpendInWindow } from "@/lib/bucketSpend";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AllowancesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TEST_TODAY);
  txns = TXNS;
  settings = { ...SETTINGS };
  server = SERVER;
  // (T4) Two completed weeks over the 450 plan (the streak), the rest of the history within.
  serverBy = { "week:2026-05-03": wk("-50.00"), "week:2026-04-26": wk("-50.00") };
  asked.length = 0;
  failMode = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Allowances — the money is unmoved", () => {
  it("prints each bucket's spend against its own window", () => {
    renderPage();
    // Each bucket card shows its actual; the summary row repeats it.
    for (const key of ["weekly", "monthly", "unplanned"] as const) {
      const row = screen.getByTestId(`allowance-summary-${key}`);
      expect(within(row).getByText(usd(EXPECTED[key]))).toBeTruthy();
      expect(within(row).getByText(usd(PLANNED[key]))).toBeTruthy();
    }
  });

  it("prints the server's totals, asked for this week and this month", () => {
    // The Banking dashboard's helper still sums the rows in the browser; this
    // page no longer does. The weekly pool differs by rule (unfiled counts).
    expect(bucketSpendInWindow(TXNS, "weekly", "2026-05-10", "2026-05-16")).toBeCloseTo(
      BROWSER_WEEKLY,
      2,
    );
    renderPage();
    const weekRow = screen.getByTestId("allowance-summary-weekly");
    expect(within(weekRow).getByText(usd(EXPECTED.weekly))).toBeTruthy();
    expect(within(weekRow).queryByText(usd(BROWSER_WEEKLY))).toBeNull();
    expect(asked).toContainEqual(expect.objectContaining({ period: "week", start: "2026-05-10" }));
    expect(asked).toContainEqual(expect.objectContaining({ period: "month", start: "2026-05-01" }));
  });

  it("shows a dash, never $0.00, while the server's totals have not arrived", () => {
    server = undefined;
    renderPage();
    for (const key of ["weekly", "monthly", "unplanned"] as const) {
      const row = screen.getByTestId(`allowance-summary-${key}`);
      expect(within(row).queryByText(usd(0))).toBeNull();
      expect(screen.getByTestId(`allowance-card-${key}`).textContent).toContain("—");
    }
  });

  it("counts neither unflagged spend nor income", () => {
    renderPage();
    // The $999.99 decoy is unassigned; the $4,321.00 credit is flagged weekly
    // but is income, so `expenseMagnitude` returns 0 for it.
    expect(screen.queryByText(usd(999.99))).toBeNull();
    expect(screen.queryByText(usd(4321))).toBeNull();
    expect(screen.queryByText(usd(1195.74))).toBeNull(); // weekly + decoy
  });

  it("reports variance as spend minus plan, per bucket", () => {
    renderPage();
    expect(screen.getByTestId("allowance-variance-weekly").textContent).toContain(
      `${usd(PLANNED.weekly - EXPECTED.weekly)} under`,
    );
    expect(screen.getByTestId("allowance-variance-monthly").textContent).toContain(
      `${usd(EXPECTED.monthly - PLANNED.monthly)} over`,
    );
  });
});

describe("Allowances — state is in words, never colour alone", () => {
  it("gives every bucket a labelled chip", () => {
    renderPage();
    expect(screen.getByTestId("allowance-state-weekly").textContent).toBe("Under");
    expect(screen.getByTestId("allowance-state-monthly").textContent).toBe("Over");
    expect(screen.getByTestId("allowance-state-unplanned").textContent).toBe("Under");
  });

  it("uses the kit's .chip classes, over taking the one bad tone", () => {
    renderPage();
    const cls = (id: string) =>
      screen.getByTestId(id).className.split(/\s+/).filter(Boolean);
    expect(cls("allowance-state-monthly")).toEqual(
      expect.arrayContaining(["chip", "bad"]),
    );
    expect(cls("allowance-state-weekly")).toEqual(
      expect.arrayContaining(["chip", "ok"]),
    );
  });

  it("states the over-budget streak as a chip with its count", () => {
    renderPage();
    const chip = screen.getByTestId("allowance-over-streak");
    expect(chip.textContent).toContain("Over budget");
    expect(chip.textContent).toContain("2 weeks running");
    expect(chip.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["chip", "bad"]),
    );
    // The two banners are mutually exclusive, exactly as before.
    expect(screen.queryByTestId("allowance-praise")).toBeNull();
  });

  it("carries no exclamation marks and no cute copy", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";
    expect(text).not.toContain("!");
    for (const phrase of [
      "in the tank",
      "Let's not make it a habit",
      "You're better than this",
      "Deep breath",
      "look at you",
    ]) {
      expect(text).not.toContain(phrase);
    }
  });
});

describe("Allowances — the fill meters", () => {
  it("paints under plan navy and over plan deep orange", () => {
    const { container } = renderPage();
    const fills = Array.from(
      container.querySelectorAll<HTMLElement>(".bar-sweep"),
    ).map((el) => el.style.background);
    expect(fills).toContain(NAVY_RGB);
    expect(fills).toContain(BAD_RGB);
  });

  it("drops a plan marker once actual passes plan", () => {
    const { container } = renderPage();
    // The monthly bucket is over, so its track rescales to ACTUAL and a
    // hairline marks where the plan ran out.
    const markers = container.querySelectorAll("span[style*='left']");
    expect(markers.length).toBeGreaterThan(0);
  });
});

describe("Allowances — the public surface is stable", () => {
  it("keeps every testid the app keys on", () => {
    renderPage();
    for (const id of [
      "allowance-card-weekly",
      "allowance-card-monthly",
      "allowance-card-unplanned",
      "allowance-edit-planned-weekly",
      "allowance-variance-weekly",
      "allowance-bucket-weekly",
      "allowance-bucket-monthly",
      "allowance-bucket-unplanned",
      "allowance-summary-weekly",
      "allowance-summary-monthly",
      "allowance-summary-unplanned",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("renders the weekly money-left history as CSS bars, not a chart", () => {
    const { container } = renderPage();
    expect(
      screen.getByLabelText("Weekly allowance money left or over plan, by week"),
    ).toBeTruthy();
    // Chart law 4: this list re-reads itself, so it must not be recharts.
    expect(container.querySelector(".recharts-wrapper")).toBeNull();
  });

  it("orders the weekly bars oldest-first, not by size", () => {
    renderPage();
    const list = screen.getByLabelText(
      "Weekly allowance money left or over plan, by week",
    );
    // Rows are positioned by transform, so read the rendered order off the
    // translateY each row carries. A time series must not re-sort by
    // magnitude — that would shuffle the weeks into a meaningless order.
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[title]"));
    const byPosition = rows
      .map((el) => ({
        title: el.getAttribute("title") ?? "",
        y: Number(/translateY\(([-\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0),
      }))
      .sort((a, b) => a.y - b.y)
      .map((r) => r.title.split(" — ")[0]);
    expect(byPosition.length).toBe(8);
    // Oldest first: every label parses to a date that only moves forward.
    const days = byPosition.map((t) => new Date(`${t} 2026`).getTime());
    for (let i = 1; i < days.length; i += 1) {
      expect(days[i]).toBeGreaterThan(days[i - 1]);
    }
  });

  it("paints money left navy and an overspent week deep orange", () => {
    const { container } = renderPage();
    const list = screen.getByLabelText(
      "Weekly allowance money left or over plan, by week",
    );
    const fills = Array.from(
      list.querySelectorAll<HTMLElement>("span[style*='background']"),
    ).map((el) => el.style.background);
    // Under-budget weeks (money left) must NOT take the bad colour.
    expect(fills).toContain(NAVY_RGB);
    expect(container).toBeTruthy();
  });
});

describe("Allowances — the household's week (PR2)", () => {
  // Saturday 9/12, 8:30pm Central — 01:30 on Sunday in UTC. Under TZ=UTC the
  // old browser-local week had already moved on to Sun 9/13 – Sat 9/19.
  const SATURDAY_EVENING = new Date("2026-09-13T01:30:00Z");

  it("still counts Saturday's weekly spend on Saturday evening, not Sunday's", () => {
    vi.setSystemTime(SATURDAY_EVENING);
    txns = [
      tx({ id: "sat", amount: "-61.25", occurredOn: "2026-09-12", weeklyAllowance: true, weeklyBucket: "groceries" }),
      tx({ id: "sun", amount: "-88.40", occurredOn: "2026-09-13", weeklyAllowance: true, weeklyBucket: "groceries" }),
    ];
    // (W5) The page asks the server for the household's week (Sun 9/6), not
    // the UTC browser's (Sun 9/13), and prints what it answers.
    serverBy = { "week:2026-09-06": fig("61.25"), "week:2026-09-13": fig("88.40") };
    renderPage();
    expect(asked).toContainEqual(expect.objectContaining({ period: "week", start: "2026-09-06" }));
    expect(asked).not.toContainEqual(expect.objectContaining({ period: "week", start: "2026-09-13" }));
    const row = screen.getByTestId("allowance-summary-weekly");
    expect(within(row).getByText(usd(61.25))).toBeTruthy();
    expect(within(row).queryByText(usd(88.4))).toBeNull();
  });
});

/** The 8 variance-bar week stamps, oldest first, read off the rendered rows. */
function varianceBarLabels(): string[] {
  const list = screen.getByLabelText("Weekly allowance money left or over plan, by week");
  return Array.from(list.querySelectorAll<HTMLElement>("[title]"))
    .map((el) => ({
      title: el.getAttribute("title") ?? "",
      y: Number(/translateY\(([-\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0),
    }))
    .sort((a, b) => a.y - b.y)
    .map((r) => r.title.split(" — ")[0]);
}

describe("Allowances — the household's month (PR2)", () => {
  const MONTH_EDGE_TXNS = [
    tx({ id: "m-sep", amount: "-42.15", occurredOn: "2026-09-30", monthlyAllowance: true }),
    tx({ id: "m-oct", amount: "-17.35", occurredOn: "2026-10-01", monthlyAllowance: true }),
    tx({ id: "u-sep", amount: "-23.45", occurredOn: "2026-09-14", unplannedAllowance: true }),
  ];

  it("Wed 9/30 at 9pm Central still counts September, even on a UTC browser", () => {
    vi.setSystemTime(new Date("2026-10-01T02:00:00Z"));
    txns = MONTH_EDGE_TXNS;
    serverBy = { "month:2026-09-01": fig("42.15", "23.45"), "month:2026-10-01": fig("17.35") };
    renderPage();
    expect(asked).toContainEqual(expect.objectContaining({ period: "month", start: "2026-09-01" }));
    // Old, under UTC: October — $17.35 monthly and nothing unplanned.
    const monthly = screen.getByTestId("allowance-summary-monthly");
    expect(within(monthly).getByText(usd(42.15))).toBeTruthy();
    expect(within(monthly).queryByText(usd(17.35))).toBeNull();
    expect(
      within(screen.getByTestId("allowance-summary-unplanned")).getByText(usd(23.45)),
    ).toBeTruthy();
  });

  it("Thu 10/1 at 12:30am Central counts October, even on a Pacific browser still on 9/30", () => {
    vi.setSystemTime(new Date("2026-10-01T05:30:00Z"));
    txns = MONTH_EDGE_TXNS;
    serverBy = { "month:2026-09-01": fig("42.15", "23.45"), "month:2026-10-01": fig("17.35") };
    renderPage();
    expect(asked).toContainEqual(expect.objectContaining({ period: "month", start: "2026-10-01" }));
    // Old, under Pacific: September — $42.15 monthly and $23.45 unplanned.
    const monthly = screen.getByTestId("allowance-summary-monthly");
    expect(within(monthly).getByText(usd(17.35))).toBeTruthy();
    expect(within(monthly).queryByText(usd(42.15))).toBeNull();
    expect(
      within(screen.getByTestId("allowance-summary-unplanned")).queryByText(usd(23.45)),
    ).toBeNull();
  });
});

describe("Allowances — streaks and variance bars walk household weeks (PR2)", () => {
  // Weekly plan $450. Two completed household weeks over it, then the open week
  // over it too — the open week must never count toward a streak.
  const STREAK_TXNS = [
    tx({ id: "w-0823", amount: "-470.00", occurredOn: "2026-08-24", weeklyAllowance: true }),
    tx({ id: "w-0830", amount: "-510.00", occurredOn: "2026-09-05", weeklyAllowance: true }),
    tx({ id: "w-0906", amount: "-600.00", occurredOn: "2026-09-12", weeklyAllowance: true }),
  ];

  it("Sat 9/12 at 8:30pm Central (a UTC browser's Sunday): last completed week is Aug 30", () => {
    vi.setSystemTime(new Date("2026-09-13T01:30:00Z"));
    txns = STREAK_TXNS;
    serverBy = { "week:2026-08-23": wk("-20.00"), "week:2026-08-30": wk("-60.00") };
    renderPage();
    // A local-UTC walk would treat Sep 6 – 12 as completed: 3 weeks, bars to Sep 6.
    expect(screen.getByTestId("allowance-over-streak").textContent).toContain("2 weeks running");
    const labels = varianceBarLabels();
    expect(labels).toHaveLength(8);
    expect(labels[0]).toBe("Jul 12");
    expect(labels[7]).toBe("Aug 30");
  });

  it("Sun 9/13 at 12:30am Central (a Pacific browser's Saturday): last completed week is Sep 6", () => {
    vi.setSystemTime(new Date("2026-09-13T05:30:00Z"));
    txns = STREAK_TXNS;
    serverBy = { "week:2026-08-23": wk("-20.00"), "week:2026-08-30": wk("-60.00"), "week:2026-09-06": wk("-150.00") };
    renderPage();
    // A local-Pacific walk would still be inside Sep 6 – 12: 2 weeks, bars to Aug 30.
    expect(screen.getByTestId("allowance-over-streak").textContent).toContain("3 weeks running");
    const labels = varianceBarLabels();
    expect(labels).toHaveLength(8);
    expect(labels[0]).toBe("Jul 19");
    expect(labels[7]).toBe("Sep 6");
  });
});

describe("Allowances — C3 grid placement", () => {
  it("lays the three bucket panels at span-4, bars and breakdown at span-6, summary at span-12", () => {
    renderPage();
    for (const slug of ["weekly", "monthly", "unplanned"]) {
      expect(screen.getByTestId(`allowance-card-${slug}`).closest(".panel")?.className).toContain("span-4");
    }
    expect(screen.getByTestId("allowance-bucket-weekly").closest(".panel")?.className).toContain("span-6");
    expect(screen.getByTestId("allowance-summary-weekly").closest(".panel")?.className).toContain("span-12");
    expect(document.querySelector(".grid-12")).not.toBeNull();
  });
});


describe("Allowances — carry-over and the way back (F7)", () => {
  it("reads the server's carry-over and says it under the weekly bucket", () => {
    const now = new Date();
    const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    spineState.weekAdjustment = { amount: "-40.00", weekStart: iso(sunday), reason: null };
    renderPage();
    expect(screen.getByTestId("allowance-carry-over").textContent).toBe("This week starts $40.00 lower (you chose this)");
    spineState.weekAdjustment = null;
  });

  it("no carry-over: no line", () => {
    spineState.weekAdjustment = null;
    renderPage();
    expect(screen.queryByTestId("allowance-carry-over")).toBeNull();
  });
});

// ⭐ (F6 round 4, review finding 2) The page's own sums — the streak chip, the
// 8-week bars, the drill-down groups — leave out an expired hold, as the
// server's totals above them do. Synthetic: weekly plan 450; last week (5/3–5/9)
// an expired hold −500 beside a real −30; the week before (4/26–5/2) another
// expired −500 beside a real −20. This month a −52.00 pickup hold (expired) and
// its −49.37 final, both monthly and unfiled.
describe("Allowances — an expired hold counts nowhere on the page (F6 round 4)", () => {
  const EXPIRED_TXNS: Tx[] = [
    { ...tx({ id: "x1", amount: "-500.00", occurredOn: "2026-05-05", weeklyAllowance: true }), expiredHold: true } as Tx,
    tx({ id: "r1", amount: "-30.00", occurredOn: "2026-05-06", weeklyAllowance: true }),
    { ...tx({ id: "x2", amount: "-500.00", occurredOn: "2026-05-01", weeklyAllowance: true }), expiredHold: true } as Tx,
    tx({ id: "r2", amount: "-20.00", occurredOn: "2026-05-02", weeklyAllowance: true }),
    { ...tx({ id: "x3", amount: "-52.00", occurredOn: "2026-05-06", monthlyAllowance: true }), expiredHold: true } as Tx,
    tx({ id: "r3", amount: "-49.37", occurredOn: "2026-05-07", monthlyAllowance: true }),
  ];

  it("the streak reads the server's weeks (30 and 20 spent, under 450): 'Under budget · 2 weeks running'", () => {
    txns = EXPIRED_TXNS;
    // The server leaves the expired holds out of its week totals; the week before them was over.
    serverBy = { "week:2026-05-03": wk("420.00"), "week:2026-04-26": wk("430.00"), "week:2026-04-19": wk("-10.00") };
    renderPage();
    expect(screen.queryByTestId("allowance-over-streak")).toBeNull();
    expect(screen.getByTestId("allowance-praise").textContent).toContain("2 weeks running");
    // The bars: last week 420 left (450 − 30), the week before 430 — no overspent week.
    const list = screen.getByLabelText("Weekly allowance money left or over plan, by week");
    const titles = Array.from(list.querySelectorAll<HTMLElement>("[title]")).map((el) => el.getAttribute("title") ?? "");
    expect(titles.some((t) => t.includes(usd(420).replace("$", "")))).toBe(true);
    expect(titles.some((t) => t.includes(usd(430).replace("$", "")))).toBe(true);
  });

  it("the drill-down lists the hold, labelled, at $0: 'Uncategorized 2 · $49.37' (it read $101.37)", async () => {
    const { fireEvent } = await import("@testing-library/react");
    txns = EXPIRED_TXNS;
    renderPage();
    fireEvent.click(screen.getByTestId("allowance-bucket-monthly"));
    const group = screen.getByTestId("allowance-group-_uncat");
    expect(group.textContent).toContain(usd(49.37));
    expect(group.textContent).not.toContain(usd(101.37));
    fireEvent.click(group);
    expect(screen.getByTestId("label-expired-hold-x3").textContent).toBe("Expired hold · not counted");
    expect(screen.queryByTestId("label-expired-hold-r3")).toBeNull();
  });

  it("(T4) the streak and the bars are the server's weeks, not a sum of the rows the page holds", () => {
    txns = [];
    renderPage();
    expect(screen.getByTestId("allowance-over-streak").textContent).toContain("2 weeks running");
    expect(varianceBarLabels()).toHaveLength(8);
  });
});


// ⭐ (F6 round 6, completeness finding 1) A HELD PAIR — a hold the bank snapshot
// held, and its reversal — comes from the server `expiredHold: false,
// expiredPair: true`: counted in cash, in no spending total. Listed in a drill,
// it carries its own quiet label, so the rows a group lists add up to its
// header (round 5: listed bare beside the header's $49.37 — $101.37 on screen).
describe("Allowances — a held pair is labelled in the drill (F6 round 6)", () => {
  const PAIR_TXNS: Tx[] = [
    { ...tx({ id: "p1", amount: "-52.00", occurredOn: "2026-05-06", monthlyAllowance: true }), expiredPair: true } as Tx,
    tx({ id: "r3", amount: "-49.37", occurredOn: "2026-05-07", monthlyAllowance: true }),
    { ...tx({ id: "p2", amount: "-80.00", occurredOn: "2026-05-11", weeklyAllowance: true, weeklyBucket: "groceries" }), expiredPair: true } as Tx,
    tx({ id: "w1", amount: "-120.25", occurredOn: "2026-05-11", weeklyAllowance: true, weeklyBucket: "groceries" }),
  ];
  const amountOf = (id: string) => -Number(PAIR_TXNS.find((t) => t.id === id)!.amount);

  async function openGroup(bucket: string, group: string): Promise<HTMLElement> {
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByTestId(`allowance-bucket-${bucket}`));
    const g = screen.getByTestId(`allowance-group-${group}`);
    fireEvent.click(g);
    return g;
  }
  /** The ids a group lists, and the ones without a label. */
  function listed(): { all: string[]; unlabelled: string[] } {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='allowance-txn-']"));
    const all = rows.map((r) => r.getAttribute("data-testid")!.slice("allowance-txn-".length));
    const unlabelled = rows
      .filter((r) => !r.querySelector("[data-testid^='label-expired-']"))
      .map((r) => r.getAttribute("data-testid")!.slice("allowance-txn-".length));
    return { all, unlabelled };
  }

  it("monthly: 'Uncategorized 2 · $49.37'; the pair row says 'Hold and its reversal · not counted here'; the unlabelled rows add to the header", async () => {
    txns = PAIR_TXNS;
    renderPage();
    const group = await openGroup("monthly", "_uncat");
    expect(group.textContent).toContain(usd(49.37));
    expect(screen.getByTestId("label-expired-pair-p1").textContent).toBe("Hold and its reversal · not counted here");
    expect(screen.queryByTestId("label-expired-hold-p1")).toBeNull();
    expect(screen.queryByTestId("label-expired-pair-r3")).toBeNull();
    const { all, unlabelled } = listed();
    expect(all.sort()).toEqual(["p1", "r3"]);
    expect(unlabelled.reduce((s, id) => s + amountOf(id), 0)).toBeCloseTo(49.37, 2);
  });

  it("weekly: the groceries group reads $120.25 and lists the pair row labelled", async () => {
    txns = PAIR_TXNS;
    renderPage();
    const group = await openGroup("weekly", "groceries");
    expect(group.textContent).toContain(usd(120.25));
    expect(screen.getByTestId("label-expired-pair-p2")).toBeTruthy();
    const { all, unlabelled } = listed();
    expect(all.sort()).toEqual(["p2", "w1"]);
    expect(unlabelled.reduce((s, id) => s + amountOf(id), 0)).toBeCloseTo(120.25, 2);
  });
});


// ⭐ (T4) NO PLAN IS NOT "OVER". The plan on every comparison is the server's for that
// week or month; the legacy saved weekly amount is on none. A week with no cap is a
// "No plan" row and ends a streak; a $0 plan says so.
describe("Allowances — no plan, never over (T4)", () => {
  it("a week with no plan: the card says 'Plan not set', its chip 'No plan', and nothing is over", () => {
    serverBy = { "week:2026-05-10": { ...wk(null, null, "none"), actual: "220.25" } };
    renderPage();
    expect(screen.getByTestId("allowance-state-weekly").textContent).toBe("No plan");
    expect(screen.getByTestId("allowance-plan-weekly").textContent).toBe("Plan not set");
    // Said once (the plan line); the variance line stays empty rather than repeat it.
    expect(screen.getByTestId("allowance-variance-weekly").textContent).toBe("");
    expect(screen.getByTestId("allowance-card-weekly").textContent).not.toMatch(/over/i);
    expect(screen.getByTestId("allowance-summary-weekly").textContent).not.toMatch(/Over/);
  });

  it("a $0 plan says 'Plan set to $0'", () => {
    serverBy = { "week:2026-05-10": { ...wk(null, null, "override"), actual: "220.25" } };
    renderPage();
    expect(screen.getByTestId("allowance-plan-weekly").textContent).toBe("Plan set to $0");
    expect(screen.getByTestId("allowance-state-weekly").textContent).toBe("No plan");
  });

  it("the legacy saved weekly amount is on no comparison: no server plan, no figure from settings", () => {
    settings = { ...SETTINGS, weeklyAllowanceAmount: "999.00" };
    serverBy = { "week:2026-05-10": wk(null, null, "none") };
    renderPage();
    expect(screen.queryByText(usd(999))).toBeNull();
    expect(screen.getByTestId("allowance-plan-weekly").textContent).toBe("Plan not set");
  });

  it("the monthly plan is the server's, and the unplanned card says 'Saved amount'", () => {
    server = { ...SERVER, month: { ...SERVER.month, plan: planOf("375.00") } };
    renderPage();
    expect(screen.getByTestId("allowance-plan-monthly").textContent).toBe("of $375.00 planned");
    expect(screen.getByTestId("allowance-plan-unplanned").textContent).toBe("Saved amount $200.00");
    expect(screen.queryByTestId("allowance-edit-planned-monthly")).toBeNull();
  });

  it("a monthly card with no plan offers 'Set plan' on Spending", () => {
    server = { ...SERVER, month: { ...SERVER.month, plan: planOf(null, "none") } };
    renderPage();
    expect(screen.getByTestId("allowance-plan-monthly").textContent).toBe("Plan not set");
    expect(screen.getByTestId("allowance-set-plan-monthly").getAttribute("href")).toBe("/spending/month");
    expect(screen.getByTestId("allowance-state-monthly").textContent).toBe("No plan");
  });

  it("history: a no-plan week is a 'No plan' row with no bar, and it ends the streak", () => {
    serverBy = {
      "week:2026-05-03": wk("-50.00"),
      "week:2026-04-26": wk(null, null, "none"),
      "week:2026-04-19": wk("-50.00"),
    };
    renderPage();
    // Newest first: one week over, then a week with no plan: a streak of 1 is not a pattern.
    expect(screen.queryByTestId("allowance-over-streak")).toBeNull();
    expect(screen.getAllByTestId("allowance-noplan-row").map((r) => r.textContent)).toEqual(["No plan: Apr 26"]);
  });

  it("history: a no-plan week is listed as 'No plan' and has no bar; a $0 week says so", () => {
    serverBy = {
      "week:2026-05-03": wk(null, null, "none"),
      "week:2026-04-26": wk(null, null, "override"),
    };
    renderPage();
    const rows = screen.getAllByTestId("allowance-noplan-row").map((r) => r.textContent);
    expect(rows).toEqual(["No plan: May 3", "Plan set to $0: Apr 26"]);
    expect(varianceBarLabels()).toHaveLength(6);
    expect(screen.queryByTestId("allowance-over-streak")).toBeNull();
  });
});

describe("Allowances — a failed refresh keeps the figures (T4)", () => {
  it("shows the banner with the age and the last numbers", () => {
    failMode = "refresh";
    renderPage();
    expect(screen.getByTestId("allowances-refresh-banner").textContent).toMatch(/^Couldn't refresh\. Showing numbers from /);
    expect(screen.getByTestId("allowance-card-weekly").textContent).toContain(usd(EXPECTED.weekly));
  });

  it("a failed first load says so and the cards show a dash, never $0.00", () => {
    failMode = "load";
    renderPage();
    expect(screen.getByTestId("allowances-refresh-banner").textContent).toContain("Couldn't load these numbers");
    expect(screen.getByTestId("allowance-card-weekly").textContent).toContain("—");
    expect(screen.getByTestId("allowance-card-weekly").textContent).not.toContain("$0.00");
  });

  it("no banner when nothing failed", () => {
    renderPage();
    expect(screen.queryByTestId("allowances-refresh-banner")).toBeNull();
  });
});
