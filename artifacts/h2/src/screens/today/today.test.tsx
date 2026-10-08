import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
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
  trail: {} as Hook,
  unfiled: {} as Hook,
  prefs: {} as Hook,
  save: vi.fn(),
  ways: {} as Hook,
  me: {} as Hook,
  carry: vi.fn(),
  undo: vi.fn(),
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
  useListAgentActions: () => mocks.trail,
  getListAgentActionsQueryKey: (p: unknown) => ["/api/agent/actions", p],
  getGetSpineQueryKey: () => ["/api/spine"],
  getGetForecastBankBalanceExplainQueryKey: () => ["/api/forecast/bank-balance/explain"],
  getGetWaysBackQueryKey: () => ["/api/money/ways-back"],
  getGetMeQueryKey: () => ["/api/me"],
  useGetWaysBack: () => mocks.ways,
  useGetMe: () => mocks.me,
  useCreateWeekAdjustment: () => ({ mutate: mocks.carry, isPending: false }),
  useDeleteWeekAdjustment: () => ({ mutate: mocks.undo, isPending: false }),
}));
vi.mock("@workspace/api-client-react/ledger", () => ({
  // The unfiled count and the activity rows are two requests; `uncategorized` tells them apart.
  useGetTransactionsLedger: (p: { uncategorized?: string }) => (p.uncategorized ? mocks.unfiled : mocks.ledger),
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
  debt: { payoffPct: 41.3, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 },
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
    weekAdjustment: null,
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

// (V4) The server's ways back for a week $55.20 over (whole cents).
const WAYS = {
  weekStart: "2026-10-04",
  weekEnd: "2026-10-10",
  overBy: 5520,
  daysLeft: 4,
  hold: { perDay: 0, leavesUntilPayday: 212450 },
  trims: [
    { categoryId: "c1", name: "Groceries", spentWeek: 18000, usualWeek: 8500 },
    { categoryId: "c2", name: "Fuel", spentWeek: 9000, usualWeek: null },
  ],
  carryOver: { nextWeekStart: "2026-10-11", nextWeekCap: 19480, applied: false, adjustment: null },
};
const OVER = { withinPlan: "over", remainingWeek: "-55.20", safeToSpendNow: "0.00" };

beforeEach(() => {
  mocks.spine = readSpine();
  mocks.position = q(POSITION);
  mocks.plans = q(PLANS);
  mocks.settings = q({ weeklyAllowanceAmount: "600.00", monthlyAllowanceAmount: "0", unplannedAllowanceAmount: "0" });
  mocks.bills = q(BILLS);
  mocks.ledger = q(LEDGER);
  mocks.categories = q(CATEGORIES);
  mocks.trail = q({ actions: [] });
  mocks.unfiled = q({ ...LEDGER, rows: [], matchingCount: 0 });
  // Seen already: the sheet stays out of the way unless a test asks for it.
  mocks.prefs = q({ sidebarCollapsed: true, whatsNewSeen: "h2-1" });
  mocks.save = vi.fn();
  mocks.ways = q(WAYS);
  mocks.me = q({ userId: "u1", isOwner: true });
  mocks.carry = vi.fn((_v: unknown, o: { onSuccess?: () => void }) => o.onSuccess?.());
  mocks.undo = vi.fn((_v: unknown, o: { onSuccess?: () => void }) => o.onSuccess?.());
});
afterEach(cleanup);

/** Renders Today and waits for its lazily loaded lower sections (S5: they load after first paint). */
async function renderToday() {
  const client = new QueryClient();
  const out = render(
    <QueryClientProvider client={client}>
      <Today now={NOW} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryAllByTestId("section-skeleton")).toHaveLength(0));
  return Object.assign(out, { client });
}

/** Every <data> in a region, as [face, exact value]. */
function figuresIn(el: HTMLElement): Array<[string | null, string | null]> {
  return Array.from(el.querySelectorAll("data"), (d) => [d.textContent, d.getAttribute("value")]);
}

describe("Today — the hero: room in the plan", () => {
  it("is the spine's safeToSpendNow, exact to the cent, the one figure-xl", async () => {
    const { container } = await renderToday();
    expect(container.querySelectorAll("[data-size='xl']")).toHaveLength(1);
    const hero = screen.getByTestId("figure-hero");
    expect(figuresIn(hero)).toEqual([["$145", "144.50"]]);
    expect(hero.textContent).toContain("Room in the plan");
    expect(hero.textContent).not.toContain("Free until");
    expect(hero.textContent).not.toContain("estimated");
  });

  it("the sub-line names payday and the bills before it, read from the position", async () => {
    await renderToday();
    expect(screen.getByTestId("figure-hero").textContent).toContain("Payday Fri, Oct 9 · $340 in bills before then");
  });

  it("a null safeToSpendNow is '—' with a reason, never $0", async () => {
    mocks.spine = readSpine({ data: withPosition({ safeToSpendNow: null, availableUntilPayday: null }) });
    await renderToday();
    const hero = screen.getByTestId("figure-hero");
    expect(hero.textContent).toContain("—");
    expect(hero.querySelector("data")).toBeNull();
    expect(hero.textContent).toContain("Not enough on file to work this out yet.");
  });

  it("estimated: the word sits beside the figure, in the page itself", async () => {
    mocks.spine = readSpine({ data: withPosition({ confidence: "estimated" }) });
    await renderToday();
    expect(screen.getByTestId("figure-hero").textContent).toMatch(/\$145\s*estimated/);
  });

  it("captions: the payday line binds, or the week's limit is the tighter line", async () => {
    // The fixture's week limit ($145) is below the payday line ($2,125): the week binds.
    await renderToday();
    expect(screen.getByTestId("figure-hero").textContent).toContain("this week's limit is the tighter line");
    cleanup();
    mocks.spine = readSpine({ data: withPosition({ remainingWeek: "900.00", availableUntilPayday: "500.00", safeToSpendNow: "500.00" }) });
    await renderToday();
    const text = screen.getByTestId("figure-hero").textContent ?? "";
    expect(text).toContain("until Friday, after bills, your buffer and goals");
    expect(text).not.toContain("tighter line");
  });

  it("no payday in 45 days: the label stays, and why", async () => {
    mocks.spine = readSpine({ data: withPosition({ horizonKind: "week_end", paydayDate: null }) });
    await renderToday();
    const hero = screen.getByTestId("figure-hero");
    expect(hero.textContent).toContain("Room in the plan");
    expect(hero.textContent).toContain("No payday on file in the next 45 days");
  });

  it("degraded: says which bank date the figure is from", async () => {
    mocks.spine = readSpine({
      data: {
        ...withPosition({ degraded: true }),
        bank: { ...SPINE.bank, asOfDate: "2026-10-04T13:00:00Z", stale: true, staleReason: "old" },
      } as Spine,
    });
    await renderToday();
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
    await renderToday();
    const hero = screen.getByRole("button", { name: /Room in the plan: \$145/ });
    hero.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Room in the plan" });
    expect(dialog.textContent).toContain("Room is the smaller of the last two. It is not a target to spend.");
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
  it("the Afford button sits directly under Debt, quiet and full width; the sheet is not mounted until it is pressed", async () => {
    await renderToday();
    const debt = screen.getByTestId("section-debt");
    const button = screen.getByRole("button", { name: "Can we afford something?" });
    expect(debt.nextElementSibling).toBe(button);
    expect(button.className).toContain("w-full");
    expect(button.className).toContain("border-rule-strong");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("spent of the limit from the position; status word from withinPlan", async () => {
    await renderToday();
    const week = screen.getByTestId("section-week");
    expect(figuresIn(week)).toContainEqual(["$456", "455.50"]);
    expect(figuresIn(week)).toContainEqual(["$600", "600.00"]);
    expect(within(week).getByTestId("meter-status").textContent).toBe("On plan");
    expect(screen.queryByTestId("week-caption")).toBeNull();
  });

  it("tight and over read as words; over names the server's remainingWeek", async () => {
    mocks.spine = readSpine({ data: withPosition({ withinPlan: "tight" }) });
    await renderToday();
    expect(screen.getByTestId("meter-status").textContent).toBe("Tight");
    cleanup();
    mocks.spine = readSpine({ data: withPosition({ withinPlan: "over", remainingWeek: "-55.20", safeToSpendNow: "0.00" }) });
    await renderToday();
    expect(screen.getByTestId("meter-status").textContent).toBe("Over by $55");
  });

  it("unplanned on top and unfiled charges are said, with a way to file", async () => {
    mocks.position = q({ ...POSITION, unplannedWeek: "40.00", needsClassificationWeek: "25.50" });
    mocks.unfiled = q({ ...LEDGER, rows: [], matchingCount: 3 });
    await renderToday();
    expect(screen.getByTestId("week-caption").textContent).toBe("$456 so far · $40 unplanned on top");
    const filing = screen.getByTestId("needs-filing");
    // A COUNT OF CHARGES, never dollars.
    expect(filing.textContent).toContain("3 charges need filing");
    expect(filing.textContent).not.toContain("$");
    expect(within(filing).getByRole("link", { name: "File them" }).getAttribute("href")).toBe("/activity?unfiled=1");
  });

  it("one unfiled charge reads in the singular; none draws nothing", async () => {
    mocks.position = q({ ...POSITION, needsClassificationWeek: "25.50" });
    mocks.unfiled = q({ ...LEDGER, rows: [], matchingCount: 1 });
    await renderToday();
    expect(screen.getByTestId("needs-filing").textContent).toContain("1 charge needs filing");
    cleanup();
    mocks.unfiled = q({ ...LEDGER, rows: [], matchingCount: 0 });
    await renderToday();
    expect(screen.queryByTestId("needs-filing")).toBeNull();
  });

  it("explains the limit: owner-set, and the suggestion", async () => {
    await renderToday();
    expect((await screen.findByTestId("limit-source")).textContent).toBe("$600 a week, set by you.");
    expect((await screen.findByTestId("limit-suggested")).textContent).toBe("H2 suggests $430 a week.");
    expect(screen.queryByTestId("limit-derivation")).toBeNull();
  });

  it("explains a derived limit with its working", async () => {
    mocks.plans = q({ ...PLANS, plans: [{ ...PLANS.plans[0], source: "derived" }] });
    await renderToday();
    expect((await screen.findByTestId("limit-source")).textContent).toContain("suggested from your income");
    expect((await screen.findByTestId("limit-derivation")).textContent).toContain("Take-home $4,333 a month");
  });

  it("with no cap anywhere, says so rather than inventing one", async () => {
    mocks.position = q({ ...POSITION, weekCap: null });
    mocks.plans = q({ ...PLANS, plans: [] });
    mocks.settings = q({ weeklyAllowanceAmount: "0.00", monthlyAllowanceAmount: "0", unplannedAllowanceAmount: "0" });
    await renderToday();
    expect(screen.getByTestId("section-week").textContent).toContain("No weekly limit set yet.");
    expect(screen.queryByTestId("meter-status")).toBeNull();
  });

  it("a position that failed shows '—' and Retry, not $0", async () => {
    const refetch = vi.fn();
    mocks.position = q(undefined, { isLoadingError: true, refetch });
    await renderToday();
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

  it("orders reconnect, stale, over, bill, review; nothing only when none match", async () => {
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

  it("every title is 60 characters or fewer, however long the bill's name", async () => {
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

  it("nothing: a plain line with a check, no buttons", async () => {
    await renderToday();
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
    await renderToday();
    const title = () => screen.getByTestId("action-title").textContent;
    expect(title()).toBe("Reconnect your bank");
    expect(within(screen.getByTestId("action-card")).getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/household");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(title()).toBe("You're over this week by $55");
    expect(screen.getByTestId("action-card").textContent).toContain("Pick a way back. No lecture.");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(title()).toBe("2 charges need a look");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(title()).toBe("Reconnect your bank");
  });

  it("a bill due tomorrow is named with its amount", async () => {
    mocks.bills = q({ ...BILLS, bills: [{ item: item("b1", "Electric", "142.18"), nextOccurrence: "2026-10-08" }] });
    await renderToday();
    expect(screen.getByTestId("action-title").textContent).toBe("Electric $142 is due tomorrow");
  });

  it("charges to review link to the Activity review queue", async () => {
    mocks.spine = readSpine({ data: { ...SPINE, reviewCount: 1 } });
    await renderToday();
    expect(screen.getByTestId("action-title").textContent).toBe("1 charge needs a look");
    expect(screen.getByRole("link", { name: "Open review" }).getAttribute("href")).toBe("/activity/review");
  });
});

describe("Today — yesterday and today", () => {
  it("rows from the ledger: name, amount, day, category chip, pending word", async () => {
    await renderToday();
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
    expect(screen.getByRole("link", { name: /All activity/ }).getAttribute("href")).toBe("/activity");
  });

  it("empty: 'No charges yet today.'", async () => {
    mocks.ledger = q({ ...LEDGER, rows: [], matchingCount: 0 });
    await renderToday();
    expect(screen.getByTestId("section-activity").textContent).toContain("No charges yet today.");
  });
});

describe("Today — handled", () => {
  const action = (id: string, runId: string, type: string, over: Record<string, unknown> = {}) => ({
    id, runId, type, targetKind: "transaction", targetId: id, outcome: "applied", reversible: true, undoneAt: null,
    createdAt: "2026-10-07T14:30:00Z", ...over,
  });

  it("hidden when H2 handled nothing", async () => {
    await renderToday();
    expect(screen.queryByTestId("section-handled")).toBeNull();
  });

  it("shows the last four lines, grouped by run, linking to Activity", async () => {
    mocks.trail = q({
      actions: [
        action("a1", "r1", "set_category"),
        action("a2", "r1", "set_category"),
        action("a3", "r1", "set_category"),
        action("a4", "r2", "remember"),
        action("a5", "r3", "recap"),
        action("a6", "r4", "propose"),
        action("a7", "r5", "wishlist"),
      ],
    });
    await renderToday();
    const rows = within(await screen.findByTestId("handled-rows")).getAllByTestId("handled-row");
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain("Filed 3 charges");
    expect(rows[1]!.textContent).toContain("Remembered 1 merchant");
    expect(within(screen.getByTestId("section-handled")).getByRole("link", { name: /See details/ }).getAttribute("href")).toBe("/activity");
  });
});

describe("Today — coming up", () => {
  it("the next three from the bills summary, past ones left out, with the month's count", async () => {
    await renderToday();
    const rows = screen.getAllByTestId("coming-up-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "$142Electric" + "Mon, Oct 12",
      "$70Internet" + "Thu, Oct 15",
      "$95Phone" + "Tue, Oct 20",
    ]);
    expect(figuresIn(rows[0]!)).toEqual([["$142", "142.18"]]);
    expect(screen.getByTestId("bills-due").textContent).toBe("3 bills due this month");
  });

  it("says today and tomorrow in words", async () => {
    mocks.bills = q({
      ...BILLS,
      bills: [
        { item: item("b1", "Electric", "142.18"), nextOccurrence: "2026-10-07" },
        { item: item("b2", "Internet", "70.00"), nextOccurrence: "2026-10-08" },
      ],
    });
    await renderToday();
    const rows = screen.getAllByTestId("coming-up-row");
    expect(rows[0]!.textContent).toContain("today");
    expect(rows[1]!.textContent).toContain("tomorrow");
  });

  it("empty: a Note with a link to the bills", async () => {
    mocks.bills = q({ ...BILLS, bills: [] });
    await renderToday();
    const section = screen.getByTestId("section-coming-up");
    expect(section.textContent).toContain("Nothing scheduled.");
    expect(within(section).getByRole("link", { name: "Open bills" }).getAttribute("href")).toBe("/plan/bills");
  });
});

describe("Today — debt, and the no-amount-owed law", () => {
  it("a percentage paid, rounded as the classic landing rounds it", async () => {
    await renderToday();
    const debt = await screen.findByTestId("figure-debt");
    expect(figuresIn(debt)).toEqual([["41%", "41.30"]]);
    expect(debt.textContent).toContain("paid");
    expect(screen.queryByTestId("debt-paid-down")).toBeNull();
  });

  it("paid down this month and the next milestone, when the server sends them", async () => {
    mocks.spine = readSpine({
      data: { ...SPINE, debt: { payoffPct: 41.3, paidDownMtd: "812.00", confirmedPaymentsMtd: "812.00", newChargesMtd: 0, nextMilestone: { label: "Card One paid off", estimatedMonth: "2027-03" } } } as unknown as Spine,
    });
    await renderToday();
    expect((await screen.findByTestId("debt-paid-down")).textContent).toBe("Paid down $812 this month, confirmed by the bank");
    expect(screen.getByTestId("debt-milestone").textContent).toBe("Next: Card One paid off · Mar 2027");
  });

  it("no anchored debt is '—' with a reason, not 0%", async () => {
    mocks.spine = readSpine({ data: { ...SPINE, debt: { payoffPct: null, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 } } });
    await renderToday();
    const debt = await screen.findByTestId("figure-debt");
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
    const { container } = await renderToday();
    await screen.findByTestId("figure-debt");
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
    await renderToday();
    const dialog = await screen.findByRole("dialog", { name: "What's new in H2" });
    expect(dialog.textContent).toContain("Your numbers haven't changed — they're just read from a new page.");
    expect(figuresIn(dialog)).toEqual([["$12,346", "12345.67"], ["$412", "412.40"]]);
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(dialog.textContent).toContain("H2 files new charges for you.");
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(within(dialog).getByRole("link", { name: "Open Automation" }).getAttribute("href")).toBe("/household/automation");
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(dialog.textContent).toContain("A morning text at 7:00 can be turned on in Recap.");
    expect(within(dialog).getByRole("link", { name: "Open Recap" }).getAttribute("href")).toBe("/recap");
    expect(mocks.save).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({ data: { sidebarCollapsed: true, whatsNewSeen: "h2-1" } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closing it any other way also counts as seen, with the switch as left", async () => {
    const user = userEvent.setup();
    await renderToday();
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(mocks.save).toHaveBeenCalledWith({ data: { sidebarCollapsed: true, whatsNewSeen: "h2-1" } });
  });

  it("does not show again once seen", async () => {
    mocks.prefs = q({ whatsNewSeen: "h2-1" });
    await renderToday();
    await screen.findByTestId("today");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never shows for a new household: no bank report, nothing spent, no rows", async () => {
    mocks.spine = readSpine({
      data: { ...SPINE, spentMonth: 0, bank: { ...SPINE.bank, asOfDate: null, source: null } } as Spine,
    });
    mocks.ledger = q({ ...LEDGER, rows: [], matchingCount: 0 });
    await renderToday();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("Today — the dateline is the household's date", () => {
  it("reads 'Wednesday, October 7' at 10 pm Chicago, when UTC is already the 8th", async () => {
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
  it("cold: skeleton shapes, the date, and no figure at all", async () => {
    mocks.spine = readSpine({ data: undefined, state: "cold", isLoading: true, isFetching: true, updatedAt: null });
    const { container } = await renderToday();
    expect(screen.getByTestId("today-skeleton")).toBeTruthy();
    expect(container.querySelector("data")).toBeNull();
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).toContain("Wednesday, October 7");
  });

  it("a failed first load: every figure '—', the error said, Retry offered", async () => {
    const refetch = vi.fn();
    mocks.spine = readSpine({ data: undefined, state: "failed", updatedAt: null, refetch });
    mocks.position = q(undefined, { isLoadingError: true });
    mocks.ledger = q(undefined, { isLoadingError: true });
    mocks.bills = q(undefined, { isLoadingError: true });
    const { container } = await renderToday();
    await screen.findByTestId("figure-debt");
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

  it("refreshing: the figures stay and the badge says Updating", async () => {
    mocks.spine = readSpine({ state: "refreshing", isFetching: true });
    await renderToday();
    expect(screen.getByTestId("freshness-badge").textContent).toBe("Updating");
    expect(figuresIn(screen.getByTestId("figure-hero"))).toEqual([["$145", "144.50"]]);
  });

  it("stale bank: the badge words, and a Note offering Sync", async () => {
    mocks.spine = readSpine({
      data: { ...SPINE, bank: { ...SPINE.bank, asOfDate: "2026-10-04T13:00:00Z", lastContactAt: null, stale: true, staleReason: "old" } },
    });
    await renderToday();
    expect(screen.getByTestId("freshness-badge").textContent).toMatch(/Out of date.*last updated 3 days ago/);
    const note = screen.getByTestId("stale-note");
    expect(note.textContent).toContain("The bank balance may be out of date.");
    expect(within(note).getByRole("link", { name: "Sync" }).getAttribute("href")).toBe("/household");
  });

  it("a failed refresh keeps the last figures, says how old they are, offers Retry", async () => {
    mocks.spine = readSpine({ state: "refresh-failed", updatedAt: "2026-10-07T14:40:00Z" });
    await renderToday();
    expect(screen.getByTestId("refresh-note").textContent).toContain("Couldn't refresh. Showing numbers from 20 minutes ago.");
    expect(figuresIn(screen.getByTestId("figure-hero"))).toEqual([["$145", "144.50"]]);
  });

  it("the classic app row moved to Household", async () => {
    await renderToday();
    expect(screen.queryByTestId("classic-row")).toBeNull();
  });
});

describe("Today — the order", () => {
  it("dateline, hero, this week, one thing, debt, afford, yesterday and today, coming up", async () => {
    await renderToday();
    const ids = ["dateline", "figure-hero", "section-week", "section-one-thing", "section-debt", "section-activity", "section-coming-up"];
    const els = ids.map((id) => screen.getByTestId(id));
    const afford = screen.getByRole("button", { name: "Can we afford something?" });
    els.splice(5, 0, afford);
    for (let i = 1; i < els.length; i++) {
      expect(els[i - 1]!.compareDocumentPosition(els[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe("Today — debt rows", () => {
  const withDebt = (d: Record<string, unknown>) =>
    readSpine({ data: { ...SPINE, debt: { payoffPct: 41.3, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0, ...d } } as Spine });

  it("paid down, new charges (clay, own row) and payments-of-which, each only when its figure is not 0", async () => {
    mocks.spine = withDebt({ paidDownMtd: 300, confirmedPaymentsMtd: 1050, newChargesMtd: 240 });
    await renderToday();
    expect((await screen.findByTestId("debt-paid-down")).textContent).toBe("Paid down $300 this month, confirmed by the bank");
    const charges = screen.getByTestId("debt-new-charges");
    expect(charges.textContent).toBe("New charges $240 this month");
    expect(charges.className).toContain("text-clay");
    expect(charges.className).toContain("border-t");
    expect(screen.getByTestId("debt-payments").textContent).toBe("Payments $1,050, of which $300 reduced debt");
  });

  it("zero rows are not drawn; payments equal to paid down add nothing", async () => {
    mocks.spine = withDebt({ paidDownMtd: 300, confirmedPaymentsMtd: 300, newChargesMtd: 0 });
    await renderToday();
    await screen.findByTestId("debt-paid-down");
    expect(screen.queryByTestId("debt-new-charges")).toBeNull();
    expect(screen.queryByTestId("debt-payments")).toBeNull();
  });
});

describe("Today — the week adjustment, in words", () => {
  const adj = (weekStart: string) => ({ weekAdjustment: { amount: "-40.00", reason: "carry_over", weekStart } });
  it("next week's, then this week's", async () => {
    mocks.spine = readSpine({ data: withPosition(adj("2026-10-11")) });
    await renderToday();
    expect(screen.getByTestId("week-adjustment").textContent).toBe("Next week starts $40 lower (you chose this)");
    cleanup();
    mocks.spine = readSpine({ data: withPosition(adj("2026-10-04")) });
    await renderToday();
    expect(screen.getByTestId("week-adjustment").textContent).toBe("This week started $40 lower (you chose this)");
  });
  it("none: nothing drawn", async () => {
    await renderToday();
    expect(screen.queryByTestId("week-adjustment")).toBeNull();
  });
});

describe("Today — the way back", () => {
  async function openSheet() {
    const user = userEvent.setup();
    mocks.spine = readSpine({ data: withPosition(OVER) });
    const out = await renderToday();
    expect(screen.getByTestId("action-title").textContent).toBe("You're over this week by $55");
    await user.click(screen.getByRole("button", { name: "Pick a way back" }));
    const dialog = await screen.findByRole("dialog", { name: "A way back" });
    return { user, dialog, out };
  }

  it("the card offers it; the sheet shows three options from the response only", async () => {
    const { dialog } = await openSheet();
    expect(within(dialog).getByTestId("way-hold").textContent).toContain("Nothing non-essential until Saturday. That keeps $2,125 until payday.");
    const rows = within(dialog).getAllByTestId("way-trim-row");
    expect(rows.map((r) => r.textContent)).toEqual(["Groceriesspent $180 this week · usually $85", "Fuelspent $90 this week"]);
    for (const r of rows) expect(within(r).getByRole("link").getAttribute("href")).toBe("/plan/categories");
    expect(within(dialog).getByTestId("way-carry").textContent).toContain("Next week starts $55 lower, at $195.");
  });

  it("the owner carries it over: the POST payload, then the spine, position and ways back are marked stale", async () => {
    const { user, dialog, out } = await openSheet();
    const spy = vi.spyOn(out.client, "invalidateQueries");
    await user.click(within(dialog).getByRole("button", { name: "Carry it over" }));
    expect(mocks.carry).toHaveBeenCalledTimes(1);
    expect(mocks.carry.mock.calls[0]![0]).toEqual({ data: { weekStart: "2026-10-11", amountCents: -5520, reason: "carry_over" } });
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(["/api/spine"]));
    expect(keys).toContain(JSON.stringify(["/api/money/position"]));
    expect(keys).toContain(JSON.stringify(["/api/money/ways-back"]));
  });

  it("a member sees the option disabled, naming whom to ask", async () => {
    mocks.me = q({ userId: "u2", isOwner: false });
    const { dialog } = await openSheet();
    const ask = within(dialog).getByRole("button", { name: "Ask the owner to carry it over" }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Carry it over" })).toBeNull();
  });

  it("applied: says so, and Undo removes it", async () => {
    mocks.ways = q({
      ...WAYS,
      carryOver: { nextWeekStart: "2026-10-11", nextWeekCap: 19480, applied: true, adjustment: { weekStart: "2026-10-11", amountCents: -5520, reason: "carry_over" } },
    });
    const { user, dialog } = await openSheet();
    expect(within(dialog).getByTestId("carry-applied").textContent).toBe("Carried over. Next week starts $55 lower.");
    await user.click(within(dialog).getByRole("button", { name: "Undo" }));
    expect(mocks.undo.mock.calls[0]![0]).toEqual({ weekStart: "2026-10-11" });
  });

  it("not over: the card carries no way-back button", async () => {
    await renderToday();
    expect(screen.queryByRole("button", { name: "Pick a way back" })).toBeNull();
  });
});

describe("The sample page", () => {
  it("renders the default and the over state; the over sheet opens and carries over on made-up data", async () => {
    const { default: DesignToday } = await import("../design/DesignToday");
    const user = userEvent.setup();
    window.history.pushState({}, "", "/design/today");
    const a = render(<QueryClientProvider client={new QueryClient()}><DesignToday /></QueryClientProvider>);
    expect((await screen.findByTestId("sample-note")).textContent).toBe("Sample — every figure on this page is made up.");
    await waitFor(() => expect(screen.queryAllByTestId("section-skeleton")).toHaveLength(0));
    expect(screen.getByTestId("debt-new-charges").textContent).toBe("New charges $240 this month");
    expect(screen.queryByRole("button", { name: "Pick a way back" })).toBeNull();
    a.unmount();
    window.history.pushState({}, "", "/design/today?state=over");
    render(<QueryClientProvider client={new QueryClient()}><DesignToday /></QueryClientProvider>);
    await waitFor(() => expect(screen.queryAllByTestId("section-skeleton")).toHaveLength(0));
    expect(screen.getByTestId("action-title").textContent).toBe("You're over this week by $55");
    await user.click(screen.getByRole("button", { name: "Pick a way back" }));
    const dialog = await screen.findByRole("dialog", { name: "A way back" });
    await user.click(within(dialog).getByRole("button", { name: "Carry it over" }));
    expect(within(dialog).getByTestId("carry-applied").textContent).toBe("Carried over. Next week starts $55 lower.");
    expect(mocks.carry).not.toHaveBeenCalled();
    window.history.pushState({}, "", "/");
  });
});
