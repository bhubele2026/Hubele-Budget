import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Spine } from "@workspace/api-client-react";
import type { SpineRead } from "@/data/useSpine";

/**
 * ⭐ TODAY READS ITS FIGURES; IT NEVER WORKS ONE OUT.
 *
 * The spine and every generated hook are mocked at the boundary, and each
 * figure on screen is checked against what they returned: the exact value to
 * the cent (`<data value>`) and the whole-dollar face beside it. Then the
 * sheets, the one-thing order, the states, and the standing law: no amount
 * owed ever reaches this screen, and no dollar figure appears that was not
 * handed in.
 */

type Hook = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  spine: null as unknown as SpineRead,
  position: {} as Hook,
  plans: {} as Hook,
  settings: {} as Hook,
  bills: {} as Hook,
  ledger: {} as Hook,
  categories: {} as Hook,
  prefs: {} as Hook,
  save: vi.fn(),
}));

vi.mock("@/data/useSpine", () => ({ useSpine: () => mocks.spine }));
vi.mock("@workspace/api-client-react", () => ({
  useGetSettings: () => mocks.settings,
  getGetSettingsQueryKey: () => ["/api/settings"],
  useGetMoneyPosition: () => mocks.position,
  getGetMoneyPositionQueryKey: () => ["/api/money/position"],
  useGetBillsSummary: () => mocks.bills,
  getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
  useListAllowancePlans: () => mocks.plans,
  getListAllowancePlansQueryKey: () => ["/api/allowance-plans"],
  useListCategories: () => mocks.categories,
  getListCategoriesQueryKey: () => ["/api/budget/categories"],
  getGetSpineQueryKey: () => ["/api/spine"],
  getGetForecastBankBalanceExplainQueryKey: () => ["/api/forecast/bank-balance/explain"],
}));
vi.mock("@workspace/api-client-react/ledger", () => ({
  useGetTransactionsLedger: () => mocks.ledger,
  getGetTransactionsLedgerQueryKey: (p: unknown) => ["/api/transactions/ledger", p],
  useGetUiPreferences: () => mocks.prefs,
  getGetUiPreferencesQueryKey: () => ["/api/me/ui-preferences"],
  useUpdateUiPreferences: () => ({ mutate: mocks.save }),
}));

import Today from "./Today";
import { attentionItems } from "./attention";

// Wednesday Oct 7, 2026, 10:00 in Chicago.
const NOW = new Date("2026-10-07T15:00:00Z");

const SPINE: Spine = {
  asOf: "2026-10-07T14:59:00Z",
  bank: {
    balance: "12345.67",
    asOfDate: "2026-10-07T14:48:00Z",
    source: "plaid",
    lastContactAt: "2026-10-07T14:48:00Z",
    lastFailureAt: null,
    stale: false,
    staleReason: null,
  },
  spentMonth: 1890.12,
  spentWeek: 412.4,
  nextBill: { name: "Electric", amount: "142.18", dueDate: "2026-10-12" },
  billsDueCount: 3,
  forecast: { lowPoint: "800.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "ready" },
  debt: { payoffPct: 41.3, nextMilestone: null, paidDownMtd: 0 },
  reviewCount: 0,
  position: {
    safeToSpendNow: "144.50",
    remainingWeek: "144.50",
    availableUntilPayday: "2124.50",
    paydayDate: "2026-10-09",
    horizonKind: "payday",
    withinPlan: "yes",
    confidence: "firm",
    degraded: false,
  },
};

const POSITION = {
  todayISO: "2026-10-07",
  paydayDate: "2026-10-09",
  payday: { itemId: "pay", label: "Paycheck", amount: "2000.00" },
  horizon: { kind: "payday", endDate: "2026-10-09", lastDay: "2026-10-09" },
  committedUntilPayday: "340.00",
  cashBuffer: "500.00",
  reservesHeld: "0.00",
  availableUntilPayday: "2124.50",
  weekCap: "600.00",
  spentWeekDiscretionary: "455.50",
  needsClassificationWeek: "0.00",
  unplannedWeek: "0.00",
  remainingWeek: "144.50",
  withinPlan: "yes",
  safeToSpendNow: "144.50",
  confidence: "firm",
  estimates: [],
  assumptions: ["Available credit is not counted.", "Bank data from Oct 7."],
  degraded: false,
};

const PLANS = {
  plans: [
    { id: "p1", memberUserId: null, period: "weekly", amount: "600.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null },
  ],
  suggested: {
    weekly: "430.00",
    derivation: {
      takeHomeMonthly: "4333.33",
      committedMonthly: "1815.99",
      debtMinimumsMonthly: "395.00",
      extraMonthly: "250.00",
      goalsMonthly: "0.00",
      discretionaryMonthly: "1872.34",
    },
  },
};

const item = (id: string, name: string, amount: string) => ({ id, name, kind: "bill", amount, active: "true" });
const BILLS = {
  income: [],
  bills: [
    { item: item("b1", "Electric", "142.18"), nextOccurrence: "2026-10-12" },
    { item: item("b2", "Internet", "70.00"), nextOccurrence: "2026-10-15" },
    { item: item("b3", "Phone", "95.00"), nextOccurrence: "2026-10-20" },
    { item: item("b4", "Water", "60.00"), nextOccurrence: "2026-10-28" },
    { item: item("b5", "Old", "11.00"), nextOccurrence: "2026-10-01" },
  ],
  debtMins: [],
  monthly: {},
};

const row = (id: string, on: string, name: string, amount: string, categoryId: string | null, pending = false) => ({
  id, occurredOn: on, description: name.toUpperCase(), displayName: name, amount, categoryId, pending, countsInBalance: true,
});
const LEDGER = {
  rows: [
    row("t1", "2026-10-07", "Corner Market", "-18.40", "c1", true),
    row("t2", "2026-10-06", "Gas Station", "-41.10", null),
    row("t0", "2026-10-06", "Paycheck", "1200.00", "c2"),
  ],
  nextCursor: null,
  limit: 8,
  matchingCount: 3,
};
const CATEGORIES = [
  { id: "c1", name: "Groceries" },
  { id: "c2", name: "Income" },
];

const q = <T,>(data: T | undefined, over: Hook = {}): Hook => ({
  data,
  isFetching: false,
  isLoadingError: false,
  isRefetchError: false,
  isPlaceholderData: false,
  refetch: vi.fn(),
  ...over,
});

function readSpine(over: Partial<SpineRead> = {}): SpineRead {
  return {
    data: SPINE,
    isLoading: false,
    isFetching: false,
    state: "loaded",
    error: null,
    updatedAt: "2026-10-07T14:59:00Z",
    refetch: vi.fn(),
    ...over,
  };
}
function withPosition(over: Record<string, unknown>): Spine {
  return { ...SPINE, position: { ...SPINE.position, ...over } } as Spine;
}

beforeEach(() => {
  mocks.spine = readSpine();
  mocks.position = q(POSITION);
  mocks.plans = q(PLANS);
  mocks.settings = q({ weeklyAllowanceAmount: "600.00", monthlyAllowanceAmount: "0", unplannedAllowanceAmount: "0" });
  mocks.bills = q(BILLS);
  mocks.ledger = q(LEDGER);
  mocks.categories = q(CATEGORIES);
  // Seen already: the sheet stays out of the way unless a test asks for it.
  mocks.prefs = q({ sidebarCollapsed: true, whatsNewSeen: "h2-1" });
  mocks.save = vi.fn();
});
afterEach(cleanup);

function renderToday() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Today now={NOW} />
    </QueryClientProvider>,
  );
}

/** Every <data> in a region, as [face, exact value]. */
function figuresIn(el: HTMLElement): Array<[string | null, string | null]> {
  return Array.from(el.querySelectorAll("data"), (d) => [d.textContent, d.getAttribute("value")]);
}

describe("Today — the hero: free until payday", () => {
  it("is the spine's safeToSpendNow, exact to the cent, the one figure-xl", () => {
    const { container } = renderToday();
    expect(container.querySelectorAll("[data-size='xl']")).toHaveLength(1);
    const hero = screen.getByTestId("figure-hero");
    expect(figuresIn(hero)).toEqual([["$145", "144.50"]]);
    expect(hero.textContent).toContain("Free until payday");
    expect(hero.textContent).not.toContain("estimated");
  });

  it("the sub-line names payday and the bills before it, read from the position", () => {
    renderToday();
    expect(screen.getByTestId("figure-hero").textContent).toContain("Payday Fri, Oct 9 · $340 in bills before then");
  });

  it("a null safeToSpendNow is '—' with a reason, never $0", () => {
    mocks.spine = readSpine({ data: withPosition({ safeToSpendNow: null, availableUntilPayday: null }) });
    renderToday();
    const hero = screen.getByTestId("figure-hero");
    expect(hero.textContent).toContain("—");
    expect(hero.querySelector("data")).toBeNull();
    expect(hero.textContent).toContain("Not enough on file to work this out yet.");
  });

  it("estimated: the word sits beside the figure, in the page itself", () => {
    mocks.spine = readSpine({ data: withPosition({ confidence: "estimated" }) });
    renderToday();
    expect(screen.getByTestId("figure-hero").textContent).toMatch(/\$145\s*estimated/);
  });

  it("no payday in 45 days: 'Free until Saturday' and why", () => {
    mocks.spine = readSpine({ data: withPosition({ horizonKind: "week_end", paydayDate: null }) });
    renderToday();
    const hero = screen.getByTestId("figure-hero");
    expect(hero.textContent).toContain("Free until Saturday");
    expect(hero.textContent).toContain("No payday on file in the next 45 days");
  });

  it("degraded: says which bank date the figure is from", () => {
    mocks.spine = readSpine({
      data: {
        ...withPosition({ degraded: true }),
        bank: { ...SPINE.bank, asOfDate: "2026-10-04T13:00:00Z", stale: true, staleReason: "old" },
      } as Spine,
    });
    renderToday();
    expect(screen.getByTestId("figure-hero").textContent).toContain("from bank data as of Oct 4");
  });
});

describe("Today — the assumptions sheet", () => {
  it("opens from the hero button, shows each line, and Escape returns focus to the hero", async () => {
    const user = userEvent.setup();
    mocks.position = q({
      ...POSITION,
      estimates: [{ itemId: "e1", label: "Electric", amount: "-340.00", date: "2026-10-08" }],
    });
    renderToday();
    const hero = screen.getByRole("button", { name: /Free until payday: \$145/ });
    hero.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Free until payday" });
    const text = dialog.textContent ?? "";
    expect(text).toContain("Bank balance");
    expect(text).toContain("as of Oct 7 · bank sync");
    expect(screen.getByTestId("assumption-payday").textContent).toBe("Fri, Oct 9");
    expect(text).toContain("Cash buffer");
    expect(figuresIn(dialog)).toContainEqual(["$500", "500.00"]);
    expect(figuresIn(dialog)).toContainEqual(["$340", "340.00"]);
    // The server's own words, verbatim.
    expect(within(dialog).getByText("Available credit is not counted.")).toBeTruthy();
    expect(within(dialog).getByText("Bank data from Oct 7.")).toBeTruthy();
    expect(screen.getByTestId("estimates").textContent).toContain("Electric — estimated $340");
    expect(screen.getByTestId("credit-line").textContent).toBe("Available credit is never counted.");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(hero);
  });
});

describe("Today — this week", () => {
  it("spent of the limit from the position; status word from withinPlan", () => {
    renderToday();
    const week = screen.getByTestId("section-week");
    expect(figuresIn(week)).toContainEqual(["$456", "455.50"]);
    expect(figuresIn(week)).toContainEqual(["$600", "600.00"]);
    expect(within(week).getByTestId("meter-status").textContent).toBe("On plan");
    expect(screen.queryByTestId("week-caption")).toBeNull();
  });

  it("tight and over read as words; over names the server's remainingWeek", () => {
    mocks.spine = readSpine({ data: withPosition({ withinPlan: "tight" }) });
    renderToday();
    expect(screen.getByTestId("meter-status").textContent).toBe("Tight");
    cleanup();
    mocks.spine = readSpine({ data: withPosition({ withinPlan: "over", remainingWeek: "-55.20", safeToSpendNow: "0.00" }) });
    renderToday();
    expect(screen.getByTestId("meter-status").textContent).toBe("Over by $55");
  });

  it("unplanned on top and unfiled charges are said, with a way to file", () => {
    mocks.position = q({ ...POSITION, unplannedWeek: "40.00", needsClassificationWeek: "25.50" });
    renderToday();
    expect(screen.getByTestId("week-caption").textContent).toBe("$456 so far · $40 unplanned on top");
    const filing = screen.getByTestId("needs-filing");
    expect(filing.textContent).toContain("$26 needs filing");
    expect(within(filing).getByRole("link", { name: "File it" }).getAttribute("href")).toBe("/classic/review");
  });

  it("explains the limit: owner-set, and the suggestion", () => {
    renderToday();
    expect(screen.getByTestId("limit-source").textContent).toBe("$600 a week, set by you.");
    expect(screen.getByTestId("limit-suggested").textContent).toBe("H2 suggests $430 a week.");
    expect(screen.queryByTestId("limit-derivation")).toBeNull();
  });

  it("explains a derived limit with its working", () => {
    mocks.plans = q({ ...PLANS, plans: [{ ...PLANS.plans[0], source: "derived" }] });
    renderToday();
    expect(screen.getByTestId("limit-source").textContent).toContain("suggested from your income");
    expect(screen.getByTestId("limit-derivation").textContent).toContain("Take-home $4,333 a month");
  });

  it("with no cap anywhere, says so rather than inventing one", () => {
    mocks.position = q({ ...POSITION, weekCap: null });
    mocks.plans = q({ ...PLANS, plans: [] });
    mocks.settings = q({ weeklyAllowanceAmount: "0.00", monthlyAllowanceAmount: "0", unplannedAllowanceAmount: "0" });
    renderToday();
    expect(screen.getByTestId("section-week").textContent).toContain("No weekly limit set yet.");
    expect(screen.queryByTestId("meter-status")).toBeNull();
  });

  it("a position that failed shows '—' and Retry, not $0", () => {
    const refetch = vi.fn();
    mocks.position = q(undefined, { isLoadingError: true, refetch });
    renderToday();
    const week = screen.getByTestId("section-week");
    expect(week.querySelector("data")).toBeNull();
    within(week).getByRole("button", { name: "Retry" }).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("Today — one thing, in a fixed order", () => {
  const BANK = SPINE.bank;
  const base = { bank: BANK, withinPlan: "yes" as const, overBy: null, dueSoon: [], today: "2026-10-07", reviewCount: 0 };
  const kinds = (o: Partial<Parameters<typeof attentionItems>[0]>) => attentionItems({ ...base, ...o }).map((a) => a.kind);

  it("orders reconnect, stale, over, bill, review; nothing only when none match", () => {
    const all = kinds({
      bank: { ...BANK, stale: true, staleReason: "refresh_failed" },
      withinPlan: "over",
      overBy: 55,
      dueSoon: [{ name: "Electric", amount: 142.18, dueOn: "2026-10-08" }],
      reviewCount: 2,
    });
    expect(all).toEqual(["reconnect", "over", "bill", "review"]);
    expect(kinds({ bank: { ...BANK, stale: true, staleReason: "old" }, reviewCount: 1 })).toEqual(["stale", "review"]);
    expect(kinds({})).toEqual(["nothing"]);
  });

  it("every title is 60 characters or fewer, however long the bill's name", () => {
    const longName = "An Extremely Long Bill Name From A Utility Company Somewhere";
    const items = attentionItems({
      ...base,
      bank: { ...BANK, stale: true, staleReason: "refresh_failed" },
      withinPlan: "over",
      overBy: 1234567,
      dueSoon: [{ name: longName, amount: 1234567, dueOn: "2026-10-08" }],
      reviewCount: 120,
    });
    expect(items.length).toBe(4);
    for (const a of items) expect(a.title.length).toBeLessThanOrEqual(60);
  });

  it("nothing: a plain line with a check, no buttons", () => {
    renderToday();
    const card = screen.getByTestId("action-card");
    expect(card.textContent).toContain("Nothing needs you today");
    expect(card.getAttribute("data-done")).not.toBeNull();
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("reconnect first, with its link; Next steps through the rest and wraps", async () => {
    const user = userEvent.setup();
    mocks.spine = readSpine({
      data: {
        ...withPosition({ withinPlan: "over", remainingWeek: "-55.20" }),
        reviewCount: 2,
        bank: { ...SPINE.bank, stale: true, staleReason: "refresh_failed" },
      } as Spine,
    });
    renderToday();
    const title = () => screen.getByTestId("action-title").textContent;
    expect(title()).toBe("Reconnect your bank");
    expect(within(screen.getByTestId("action-card")).getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/classic/settings");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(title()).toBe("You're over this week by $55");
    expect(screen.getByTestId("action-card").textContent).toContain("Nothing to decide. Just know it.");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(title()).toBe("2 charges need a look");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(title()).toBe("Reconnect your bank");
  });

  it("a bill due tomorrow is named with its amount", () => {
    mocks.bills = q({ ...BILLS, bills: [{ item: item("b1", "Electric", "142.18"), nextOccurrence: "2026-10-08" }] });
    renderToday();
    expect(screen.getByTestId("action-title").textContent).toBe("Electric $142 is due tomorrow");
  });

  it("charges to review link to the classic review", () => {
    mocks.spine = readSpine({ data: { ...SPINE, reviewCount: 1 } });
    renderToday();
    expect(screen.getByTestId("action-title").textContent).toBe("1 charge needs a look");
    expect(screen.getByRole("link", { name: "Open review" }).getAttribute("href")).toBe("/classic/review");
  });
});

describe("Today — yesterday and today", () => {
  it("rows from the ledger: name, amount, day, category chip, pending word", () => {
    renderToday();
    const rows = within(screen.getByTestId("activity-rows")).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Corner Market");
    expect(rows[0]!.textContent).toContain("today");
    expect(rows[0]!.textContent).toContain("pending");
    expect(rows[0]!.textContent).toContain("Groceries");
    expect(figuresIn(rows[0]!)).toEqual([["-$18", "-18.40"]]);
    expect(rows[1]!.textContent).toContain("Not filed");
    expect(rows[1]!.textContent).not.toContain("pending");
    expect(figuresIn(rows[2]!)).toEqual([["+$1,200", "1200.00"]]);
    expect(screen.getByRole("link", { name: /All activity/ }).getAttribute("href")).toBe("/classic/transactions");
  });

  it("empty: 'No charges yet today.'", () => {
    mocks.ledger = q({ ...LEDGER, rows: [], matchingCount: 0 });
    renderToday();
    expect(screen.getByTestId("section-activity").textContent).toContain("No charges yet today.");
  });
});

describe("Today — coming up", () => {
  it("the next three from the bills summary, past ones left out, with the month's count", () => {
    renderToday();
    const rows = screen.getAllByTestId("coming-up-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "$142Electric" + "Mon, Oct 12",
      "$70Internet" + "Thu, Oct 15",
      "$95Phone" + "Tue, Oct 20",
    ]);
    expect(figuresIn(rows[0]!)).toEqual([["$142", "142.18"]]);
    expect(screen.getByTestId("bills-due").textContent).toBe("3 bills due this month");
  });

  it("says today and tomorrow in words", () => {
    mocks.bills = q({
      ...BILLS,
      bills: [
        { item: item("b1", "Electric", "142.18"), nextOccurrence: "2026-10-07" },
        { item: item("b2", "Internet", "70.00"), nextOccurrence: "2026-10-08" },
      ],
    });
    renderToday();
    const rows = screen.getAllByTestId("coming-up-row");
    expect(rows[0]!.textContent).toContain("today");
    expect(rows[1]!.textContent).toContain("tomorrow");
  });

  it("empty: a Note with a link to the bills", () => {
    mocks.bills = q({ ...BILLS, bills: [] });
    renderToday();
    const section = screen.getByTestId("section-coming-up");
    expect(section.textContent).toContain("Nothing scheduled.");
    expect(within(section).getByRole("link", { name: "Open bills" }).getAttribute("href")).toBe("/classic/bills/all");
  });
});

describe("Today — debt, and the no-amount-owed law", () => {
  it("a percentage paid, rounded as the classic landing rounds it", () => {
    renderToday();
    const debt = screen.getByTestId("figure-debt");
    expect(figuresIn(debt)).toEqual([["41%", "41.30"]]);
    expect(debt.textContent).toContain("paid");
    expect(screen.queryByTestId("debt-paid-down")).toBeNull();
  });

  it("paid down this month and the next milestone, when the server sends them", () => {
    mocks.spine = readSpine({
      data: { ...SPINE, debt: { payoffPct: 41.3, paidDownMtd: "812.00", nextMilestone: { label: "Card One paid off", estimatedMonth: "2027-03" } } } as unknown as Spine,
    });
    renderToday();
    expect(screen.getByTestId("debt-paid-down").textContent).toBe("Paid down $812 this month");
    expect(screen.getByTestId("debt-milestone").textContent).toBe("Next: Card One paid off · Mar 2027");
  });

  it("no anchored debt is '—' with a reason, not 0%", () => {
    mocks.spine = readSpine({ data: { ...SPINE, debt: { payoffPct: null, nextMilestone: null, paidDownMtd: 0 } } });
    renderToday();
    const debt = screen.getByTestId("figure-debt");
    expect(debt.textContent).toContain("—");
    expect(debt.textContent).not.toContain("0%");
    expect(debt.textContent).toContain("No debt has a starting balance yet.");
  });

  it("never renders an owed figure, even if a balance were smuggled onto the spine", async () => {
    const user = userEvent.setup();
    mocks.spine = readSpine({
      data: { ...SPINE, reviewCount: 2, debt: { payoffPct: 41.3, balance: "98765.43", owed: "98765.43", totalOwed: 98765.43 } } as unknown as Spine,
    });
    mocks.position = q({
      ...POSITION,
      estimates: [{ itemId: "e1", label: "Electric", amount: "-340.00", date: "2026-10-08" }],
      unplannedWeek: "40.00",
      needsClassificationWeek: "25.50",
    });
    const { container } = renderToday();
    await user.click(screen.getByTestId("hero"));
    await screen.findByRole("dialog");
    const text = (container.textContent ?? "") + (document.body.textContent ?? "");
    expect(text).not.toMatch(/98,76[45]|98765/);
    expect(text.toLowerCase()).not.toMatch(/\bowed?\b|\bowing\b|balance due|balance remaining|remaining debt|\blimit of\b|credit limit|available credit(?! is)/);
    // Every dollar figure on the page was handed in by a mock.
    const ALLOWED = new Set([
      "$12,346", "$145", "$340", "$500", "$0", "$2,125", "$600", "$456", "$40", "$26", "$142", "$70", "$95", "$18", "$41",
      "$1,200", "$430", "$4,333", "$1,816", "$395", "$250", "$1,872",
    ]);
    const found = new Set(text.match(/\$\d[\d,]*/g) ?? []);
    expect([...found].filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
});

describe("Today — What's new", () => {
  beforeEach(() => {
    mocks.prefs = q({ sidebarCollapsed: true });
  });

  it("shows three steps once, names both figures, and saves the choice merged", async () => {
    const user = userEvent.setup();
    renderToday();
    const dialog = await screen.findByRole("dialog", { name: "What's new in H2" });
    expect(dialog.textContent).toContain("Your numbers haven't changed — they're just read from a new page.");
    expect(figuresIn(dialog)).toEqual([["$12,346", "12345.67"], ["$412", "412.40"]]);
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(dialog.textContent).toContain("H2 will start filing new charges automatically; uncertain ones wait for you in Activity.");
    const sw = within(dialog).getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await user.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await user.click(sw);
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(dialog.textContent).toContain("A morning text at 7:00 can be turned on in Recap.");
    expect(within(dialog).getByRole("link", { name: "Open settings" }).getAttribute("href")).toBe("/classic/settings");
    expect(mocks.save).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({ data: { sidebarCollapsed: true, whatsNewSeen: "h2-1", autoCategorize: true } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closing it any other way also counts as seen, with the switch as left", async () => {
    const user = userEvent.setup();
    renderToday();
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(mocks.save).toHaveBeenCalledWith({ data: { sidebarCollapsed: true, whatsNewSeen: "h2-1", autoCategorize: true } });
  });

  it("does not show again once seen", async () => {
    mocks.prefs = q({ whatsNewSeen: "h2-1" });
    renderToday();
    await screen.findByTestId("today");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never shows for a new household: no bank report, nothing spent, no rows", async () => {
    mocks.spine = readSpine({
      data: { ...SPINE, spentMonth: 0, bank: { ...SPINE.bank, asOfDate: null, source: null } } as Spine,
    });
    mocks.ledger = q({ ...LEDGER, rows: [], matchingCount: 0 });
    renderToday();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("Today — the dateline is the household's date", () => {
  it("reads 'Wednesday, October 7' at 10 pm Chicago, when UTC is already the 8th", () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <Today now={new Date("2026-10-08T03:00:00Z")} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("dateline").textContent).toBe("Wednesday, October 7");
  });
});

describe("Today — states", () => {
  it("cold: skeleton shapes, the date, and no figure at all", () => {
    mocks.spine = readSpine({ data: undefined, state: "cold", isLoading: true, isFetching: true, updatedAt: null });
    const { container } = renderToday();
    expect(screen.getByTestId("today-skeleton")).toBeTruthy();
    expect(container.querySelector("data")).toBeNull();
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).toContain("Wednesday, October 7");
  });

  it("a failed first load: every figure '—', the error said, Retry offered", () => {
    const refetch = vi.fn();
    mocks.spine = readSpine({ data: undefined, state: "failed", updatedAt: null, refetch });
    mocks.position = q(undefined, { isLoadingError: true });
    mocks.ledger = q(undefined, { isLoadingError: true });
    mocks.bills = q(undefined, { isLoadingError: true });
    const { container } = renderToday();
    expect(container.textContent).not.toMatch(/\$\d/);
    expect(container.textContent).not.toContain("Nothing needs you");
    expect(screen.getByTestId("section-one-thing").textContent).toContain("Can't check until the numbers load.");
    expect(screen.getByTestId("figure-hero").textContent).toContain("—");
    expect(screen.getByTestId("figure-debt").textContent).toContain("—");
    const note = screen.getByTestId("refresh-note");
    expect(note.textContent).toContain("Couldn't load these numbers.");
    within(note).getByRole("button", { name: "Retry" }).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("refreshing: the figures stay and the badge says Updating", () => {
    mocks.spine = readSpine({ state: "refreshing", isFetching: true });
    renderToday();
    expect(screen.getByTestId("freshness-badge").textContent).toBe("Updating");
    expect(figuresIn(screen.getByTestId("figure-hero"))).toEqual([["$145", "144.50"]]);
  });

  it("stale bank: the badge words, and a Note offering Sync", () => {
    mocks.spine = readSpine({
      data: { ...SPINE, bank: { ...SPINE.bank, asOfDate: "2026-10-04T13:00:00Z", lastContactAt: null, stale: true, staleReason: "old" } },
    });
    renderToday();
    expect(screen.getByTestId("freshness-badge").textContent).toMatch(/Out of date.*last updated 3 days ago/);
    const note = screen.getByTestId("stale-note");
    expect(note.textContent).toContain("The bank balance may be out of date.");
    expect(within(note).getByRole("link", { name: "Sync" }).getAttribute("href")).toBe("/classic/settings");
  });

  it("a failed refresh keeps the last figures, says how old they are, offers Retry", () => {
    mocks.spine = readSpine({ state: "refresh-failed", updatedAt: "2026-10-07T14:40:00Z" });
    renderToday();
    expect(screen.getByTestId("refresh-note").textContent).toContain("Couldn't refresh. Showing numbers from 20 minutes ago.");
    expect(figuresIn(screen.getByTestId("figure-hero"))).toEqual([["$145", "144.50"]]);
  });

  it("the classic app is one quiet row away", () => {
    renderToday();
    const row = screen.getByTestId("classic-row");
    expect(within(row).getByRole("link", { name: "Classic app" }).getAttribute("href")).toBe("/classic/");
  });
});
