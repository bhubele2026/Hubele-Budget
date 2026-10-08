import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  AllowancePlans,
  BillsSummary,
  BudgetMonthDetail,
  Category,
  Debt,
  DebtPlan,
  MeResponse,
  Member,
  MoneyPosition,
  RecurringItem,
  Spine,
} from "@workspace/api-client-react";
import type { Read } from "@/data/todayData";
import type { SpineRead } from "@/data/useSpine";

/**
 * ⭐ PLAN READS ITS FIGURES AND SENDS ITS EDITS; IT NEVER WORKS A MONEY FIGURE OUT.
 *
 * The views are rendered on data they are handed, and every mutation hook is
 * mocked at the boundary, so each test checks what was read off the screen and
 * exactly what was sent. The standing laws are here too: the debt page never
 * shows an amount owed and never one payoff date.
 */
type Fn = ReturnType<typeof vi.fn>;
const mocks = vi.hoisted(() => ({
  updatePlan: null as unknown as Fn,
  createItem: null as unknown as Fn,
  updateItem: null as unknown as Fn,
  deleteItem: null as unknown as Fn,
  putSettings: null as unknown as Fn,
  createPayment: null as unknown as Fn,
  createDebt: null as unknown as Fn,
  updateDebt: null as unknown as Fn,
  upsertLine: null as unknown as Fn,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  const hook = (key: keyof typeof mocks) => () => ({ mutate: mocks[key], isPending: false });
  return {
  ...actual,
  useUpdateAllowancePlan: hook("updatePlan"),
  useCreateRecurringItem: hook("createItem"),
  useUpdateRecurringItem: hook("updateItem"),
  useDeleteRecurringItem: hook("deleteItem"),
  useUpdateAvalancheSettings: hook("putSettings"),
  useCreateDebtPayment: hook("createPayment"),
  useCreateDebt: hook("createDebt"),
  useUpdateDebt: hook("updateDebt"),
  useUpsertBudgetLine: hook("upsertLine"),
  };
});

import { WeekView } from "./PlanWeek";
import { BillsView, blankForm, payloadOf, validateForm } from "./PlanBills";
import { DebtView, LOGGED_TOAST } from "./PlanDebt";
import { CategoriesView, isEditableLine } from "./PlanCategories";
import type { BillsData, CategoriesData, DebtData, WeekData } from "./planData";

const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday, 10:00 in Chicago

const loaded = <T,>(data: T | undefined, over: Partial<Read<T>> = {}): Read<T> => ({
  data,
  state: data === undefined ? "cold" : "loaded",
  isFetching: false,
  refetch: vi.fn(),
  ...over,
});

const SPINE = {
  asOf: "2026-10-07T14:59:00Z",
  bank: { balance: "12345.67", asOfDate: "2026-10-07T14:48:00Z", source: "plaid", lastContactAt: "2026-10-07T14:48:00Z", lastFailureAt: null, stale: false, staleReason: null },
  spentMonth: 1890.12,
  spentWeek: 455.5,
  nextBill: null,
  billsDueCount: 0,
  forecast: { lowPoint: "800.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "ready" },
  debt: { payoffPct: 41.3, nextMilestone: null, paidDownMtd: 0 },
  reviewCount: 0,
  position: { safeToSpendNow: "144.50", remainingWeek: "144.50", availableUntilPayday: "2124.50", paydayDate: "2026-10-09", horizonKind: "payday", withinPlan: "yes", confidence: "firm", degraded: false },
} as unknown as Spine;
const spineRead = (data: Spine = SPINE, over: Partial<SpineRead> = {}): SpineRead => ({
  data, isLoading: false, isFetching: false, state: "loaded", error: null, updatedAt: "2026-10-07T14:59:00Z", refetch: vi.fn(), ...over,
});

function renderUi(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

/** A mutation that succeeds, handing the success callback `result`. */
const succeeds = (result: unknown = {}) => vi.fn((_vars: unknown, o?: { onSuccess?: (r: unknown) => void }) => o?.onSuccess?.(result));

beforeEach(() => {
  for (const k of Object.keys(mocks) as Array<keyof typeof mocks>) mocks[k] = succeeds();
});
afterEach(cleanup);

/** Every <data> in a region, as [face, exact value]. */
const figuresIn = (el: HTMLElement) => Array.from(el.querySelectorAll("data"), (d) => [d.textContent, d.getAttribute("value")]);

// ── THE WEEK ─────────────────────────────────────────────────────────────────

const PLAN_ROW = { id: "p1", memberUserId: null, period: "weekly", amount: "600.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null, createdAt: "2026-09-27T00:00:00Z" };
const MEMBER_ROW = { id: "p2", memberUserId: "u2", period: "weekly", amount: "60.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null, createdAt: "2026-09-27T00:00:00Z" };
const PLANS = {
  plans: [PLAN_ROW, MEMBER_ROW],
  suggested: {
    weekly: "430.00",
    derivation: { takeHomeMonthly: "4333.33", committedMonthly: "1815.99", debtMinimumsMonthly: "395.00", extraMonthly: "250.00", goalsMonthly: "0.00", discretionaryMonthly: "1872.34" },
  },
} as unknown as AllowancePlans;
const POSITION = { weekCap: "600.00", spentWeekDiscretionary: "455.50", remainingWeek: "144.50", withinPlan: "yes" } as unknown as MoneyPosition;
const OWNER = { userId: "u1", isOwner: true } as MeResponse;
const MEMBERS = [
  { id: "u1", displayName: "Sam", isOwner: true },
  { id: "u2", displayName: "Alex", isOwner: false },
] as Member[];

function week(over: Partial<WeekData> = {}): WeekData {
  return { spine: spineRead(), plans: loaded(PLANS), position: loaded(POSITION), me: loaded(OWNER), members: loaded(MEMBERS), ...over };
}

describe("The week — the limit and where it comes from", () => {
  it("the hero is the shared weekly plan, exact, the one figure-xl, with its source word", () => {
    const { container } = renderUi(<WeekView data={week()} now={NOW} />);
    expect(container.querySelectorAll("[data-size='xl']")).toHaveLength(1);
    const hero = screen.getByTestId("figure-hero");
    expect(figuresIn(hero)).toEqual([["$600", "600.00"]]);
    expect(hero.textContent).toContain("Weekly limit");
    expect(screen.getByTestId("limit-source-word").textContent).toBe("set by you");
  });

  it("a derived plan reads 'suggested'; a member reads who set it", () => {
    const derived = { ...PLANS, plans: [{ ...PLAN_ROW, source: "derived" }] } as unknown as AllowancePlans;
    renderUi(<WeekView data={week({ plans: loaded(derived) })} now={NOW} />);
    expect(screen.getByTestId("limit-source-word").textContent).toBe("suggested");
    cleanup();
    renderUi(<WeekView data={week({ me: loaded({ userId: "u2", isOwner: false } as MeResponse), members: loaded<Member[]>(undefined) })} now={NOW} />);
    expect(screen.getByTestId("limit-source-word").textContent).toBe("set by the owner");
    expect(screen.queryByTestId("save-own")).toBeNull();
    expect(screen.queryByTestId("use-suggestion")).toBeNull();
    expect(screen.getByTestId("read-only").textContent).toContain("set by the owner");
  });

  it("the suggestion is a short ledger of the server's own working, each line exact", () => {
    renderUi(<WeekView data={week()} now={NOW} />);
    const ledger = screen.getByTestId("suggestion-ledger");
    expect(figuresIn(ledger)).toEqual([
      ["$4,333", "4333.33"],
      ["$1,816", "1815.99"],
      ["$395", "395.00"],
      ["$250", "250.00"],
      ["$0", "0.00"],
      ["$1,872", "1872.34"],
      ["$430", "430.00"],
    ]);
    const labels = Array.from(ledger.querySelectorAll("li"), (li) => li.firstElementChild!.textContent);
    expect(labels).toEqual([
      "Take-home pay, per month",
      "Less bills",
      "Less debt minimums",
      "Less extra toward debt",
      "Less goals",
      "Left to spend, per month",
      "A week, rounded down to $5",
    ]);
    const text = ledger.textContent!;
    expect(text).toContain("A week, rounded down to $5");
  });

  it("'Use the suggestion' PUTs the plan to the suggested amount", async () => {
    const user = userEvent.setup();
    renderUi(<WeekView data={week()} now={NOW} />);
    await user.click(screen.getByTestId("use-suggestion"));
    expect(mocks.updatePlan).toHaveBeenCalledTimes(1);
    expect(mocks.updatePlan.mock.calls[0]![0]).toEqual({ id: "p1", data: { amount: "430.00" } });
    expect(screen.getByTestId("toast").textContent).toBe("Using the suggestion.");
  });

  it("when the limit already matches, the button gives way to a word", () => {
    const same = { ...PLANS, plans: [{ ...PLAN_ROW, amount: "430" }] } as unknown as AllowancePlans;
    renderUi(<WeekView data={week({ plans: loaded(same) })} now={NOW} />);
    expect(screen.queryByTestId("use-suggestion")).toBeNull();
    expect(screen.getByTestId("matches-suggestion")).toBeTruthy();
  });

  it("your own amount: validated, then PUT as dollars with two decimals", async () => {
    const user = userEvent.setup();
    renderUi(<WeekView data={week()} now={NOW} />);
    const input = screen.getByTestId("input-own");
    for (const bad of ["abc", "0", "12.345"]) {
      await user.clear(input);
      await user.type(input, bad);
      await user.click(screen.getByTestId("save-own"));
      expect(screen.getByRole("alert").textContent).toContain("Enter a dollar amount above $0");
    }
    expect(mocks.updatePlan).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "$350.5");
    await user.click(screen.getByTestId("save-own"));
    expect(mocks.updatePlan.mock.calls[0]![0]).toEqual({ id: "p1", data: { amount: "350.50" } });
    expect(screen.getByTestId("toast").textContent).toBe("Weekly limit saved.");
  });

  it("a 403 is answered in words, not swallowed", async () => {
    mocks.updatePlan = vi.fn((_v: unknown, o?: { onError?: (e: unknown) => void }) => o?.onError?.({ status: 403 }));
    const user = userEvent.setup();
    renderUi(<WeekView data={week({ me: loaded<MeResponse>(undefined, { state: "failed" }) })} now={NOW} />);
    await user.click(screen.getByTestId("use-suggestion"));
    expect(screen.getByTestId("toast").textContent).toBe("Only the household owner can change this.");
    expect(screen.getByTestId("toast").getAttribute("role")).toBe("alert");
  });

  it("personal allowances: a row per member plan, saved by its own id, with the attribution line", async () => {
    const user = userEvent.setup();
    renderUi(<WeekView data={week()} now={NOW} />);
    const row = screen.getByTestId("member-plan");
    expect(row.textContent).toContain("Alex");
    const input = within(row).getByRole("textbox");
    expect((input as HTMLInputElement).value).toBe("60");
    await user.clear(input);
    await user.type(input, "75");
    await user.click(within(row).getByRole("button", { name: /save alex/i }));
    expect(mocks.updatePlan.mock.calls[0]![0]).toEqual({ id: "p2", data: { amount: "75.00" } });
    expect(screen.getByTestId("section-personal").textContent).toContain("counted against the member on the row, or against the account's owner");
  });

  it("this week is Today's meter on the position, with the server's words", () => {
    renderUi(<WeekView data={week()} now={NOW} />);
    const meter = screen.getByTestId("meter-week");
    expect(figuresIn(meter)).toEqual([["$456", "455.50"], ["$600", "600.00"]]);
    expect(meter.getAttribute("data-status")).toBe("on");
    expect(screen.getByTestId("meter-status").textContent).toBe("On plan");
  });

  it("over plan says by how much, from the server's remainder", () => {
    const over = { ...SPINE, position: { ...SPINE.position, withinPlan: "over", remainingWeek: "-55.00" } } as unknown as Spine;
    renderUi(<WeekView data={week({ spine: spineRead(over) })} now={NOW} />);
    expect(screen.getByTestId("meter-status").textContent).toBe("Over by $55");
  });

  it("states: cold is a skeleton once; failed is a Note with Retry and no zero", async () => {
    const user = userEvent.setup();
    const { unmount } = renderUi(<WeekView data={week({ plans: loaded<AllowancePlans>(undefined) })} now={NOW} />);
    expect(screen.getByTestId("plan-skeleton")).toBeTruthy();
    unmount();
    const refetch = vi.fn();
    renderUi(<WeekView data={week({ plans: loaded<AllowancePlans>(undefined, { state: "failed", refetch }) })} now={NOW} />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load your plan.");
    expect(screen.getByTestId("figure-hero").textContent).not.toContain("$0");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});

// ── BILLS ────────────────────────────────────────────────────────────────────

const item = (id: string, name: string, kind: string, amount: string, frequency: string, extra: Partial<RecurringItem> = {}) =>
  ({ id, name, kind, amount, frequency, active: "true", amountKind: "fixed", dayOfMonth: null, anchorDate: null, categoryId: null, ...extra }) as RecurringItem;
const ITEMS = [
  item("i1", "Paycheck", "income", "2000.00", "biweekly", { anchorDate: "2026-10-09" }),
  item("i2", "Rent", "bill", "1450.00", "monthly", { dayOfMonth: 1 }),
  item("i3", "Electric", "bill", "142.18", "monthly", { dayOfMonth: 12, amountKind: "estimate", categoryId: "c2" }),
  item("i4", "Streaming", "subscription", "15.99", "monthly", { dayOfMonth: 20 }),
  item("i5", "Weekly Spend", "bill", "350.00", "weekly"),
  item("i6", "Monthly Spend", "bill", "120.00", "monthly"),
];
const srow = (i: RecurringItem, next: string | null) => ({ item: i, nextOccurrence: next, monthlyAmount: i.amount, actualAmount: "0.00" });
const SUMMARY = { income: [srow(ITEMS[0]!, "2026-10-09")], bills: [srow(ITEMS[1]!, "2026-11-01"), srow(ITEMS[2]!, "2026-10-12")], debtMins: [], monthly: {} } as unknown as BillsSummary;
const CATS = [
  { id: "c1", name: "Housing", kind: "expense" },
  { id: "c2", name: "Utilities", kind: "expense" },
  { id: "c3", name: "Pay", kind: "income" },
] as Category[];
const bills = (over: Partial<BillsData> = {}): BillsData => ({ items: loaded(ITEMS), summary: loaded(SUMMARY), categories: loaded(CATS), ...over });

describe("Bills — grouped by kind, edited in a sheet", () => {
  it("groups Income · Bills · Subscriptions; a row shows amount, the word 'estimate', cadence and next date", () => {
    renderUi(<BillsView data={bills()} />);
    expect(screen.getByTestId("group-income").textContent).toContain("Paycheck");
    expect(screen.getByTestId("group-bills").textContent).toContain("Rent");
    expect(screen.getByTestId("group-subscriptions").textContent).toContain("Streaming");
    const electric = screen.getAllByTestId("bill-row").find((r) => r.textContent!.includes("Electric"))!;
    expect(figuresIn(electric)).toEqual([["$142", "142.18"]]);
    expect(within(electric).getByTestId("estimate-word").textContent).toBe("estimate");
    expect(electric.textContent).toContain("monthly, the 12th");
    expect(electric.textContent).toContain("next Oct 12");
    const rent = screen.getAllByTestId("bill-row").find((r) => r.textContent!.includes("Rent"))!;
    expect(within(rent).queryByTestId("estimate-word")).toBeNull();
  });

  it("the two funding items are visible and read-only, with the word 'allowance hook' and a way to The week", async () => {
    const user = userEvent.setup();
    renderUi(<BillsView data={bills()} />);
    const rows = screen.getAllByTestId("funding-row");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Weekly Spend"), expect.stringContaining("Monthly Spend")]);
    for (const r of rows) {
      expect(r.textContent).toContain("allowance hook");
      expect(within(r).queryByRole("button")).toBeNull();
      expect(within(r).queryByRole("switch")).toBeNull();
    }
    expect(screen.queryByTestId("group-bills")!.textContent).not.toContain("Weekly Spend");
    await user.click(screen.getByText("Why can't I edit these?"));
    expect(within(screen.getByTestId("group-funding")).getByRole("link", { name: "The week" }).getAttribute("href")).toBe("/plan");
  });

  it("form validation: a name, an amount above $0, a day, and a date for a one-time bill", () => {
    expect(validateForm(blankForm())).toMatchObject({ name: expect.any(String), amount: expect.any(String) });
    expect(validateForm(blankForm({ name: "Rent", amount: "0" })).amount).toBeTruthy();
    expect(validateForm(blankForm({ name: "Rent", amount: "10" }))).toEqual({});
    expect(validateForm(blankForm({ name: "Rent", amount: "10", dayOfMonth: "32" })).day).toBeTruthy();
    expect(validateForm(blankForm({ name: "Tax", amount: "10", frequency: "onetime" })).date).toBeTruthy();
    expect(validateForm(blankForm({ name: "Tax", amount: "10", frequency: "onetime", oneTimeDate: "2026-02-30" })).date).toBeTruthy();
    expect(validateForm(blankForm({ name: "Tax", amount: "10", frequency: "onetime", oneTimeDate: "2026-10-30" }))).toEqual({});
    expect(payloadOf(blankForm({ name: " Tax ", amount: "10", frequency: "onetime", oneTimeDate: "2026-10-30" }))).toMatchObject({
      name: "Tax", amount: "10.00", frequency: "onetime", anchorDate: "2026-10-30", dayOfMonth: null,
    });
  });

  it("Add: nothing is sent until the form is valid; then the item is created", async () => {
    const user = userEvent.setup();
    renderUi(<BillsView data={bills()} />);
    await user.click(screen.getByTestId("add-item"));
    await user.click(screen.getByTestId("item-save"));
    expect(screen.getByText("Give it a name.")).toBeTruthy();
    expect(screen.getByText(/Enter an amount above \$0/)).toBeTruthy();
    expect(mocks.createItem).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("item-name"), "Gym");
    await user.type(screen.getByTestId("item-amount"), "0");
    await user.click(screen.getByTestId("item-save"));
    expect(mocks.createItem).not.toHaveBeenCalled();
    await user.clear(screen.getByTestId("item-amount"));
    await user.type(screen.getByTestId("item-amount"), "29.99");
    await user.click(screen.getByTestId("item-estimate"));
    await user.click(screen.getByTestId("item-save"));
    expect(mocks.createItem.mock.calls[0]![0]).toEqual({
      data: { name: "Gym", kind: "bill", amount: "29.99", amountKind: "estimate", frequency: "monthly", dayOfMonth: 1, anchorDate: null, categoryId: null, active: "true" },
    });
    expect(screen.getByTestId("toast").textContent).toBe("Added.");
    expect(screen.queryByTestId("item-save")).toBeNull();
  });

  it("a one-time bill is the same sheet: 'One time' and a date, which it insists on", async () => {
    const user = userEvent.setup();
    renderUi(<BillsView data={bills()} />);
    await user.click(screen.getByTestId("add-one-time"));
    expect((screen.getByTestId("item-frequency") as HTMLSelectElement).value).toBe("onetime");
    await user.type(screen.getByTestId("item-name"), "Car registration");
    await user.type(screen.getByTestId("item-amount"), "89");
    await user.click(screen.getByTestId("item-save"));
    expect(screen.getByText("Pick the date it is due.")).toBeTruthy();
    expect(mocks.createItem).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("item-date"), "2026-10-30");
    await user.click(screen.getByTestId("item-save"));
    expect(mocks.createItem.mock.calls[0]![0]).toEqual({
      data: expect.objectContaining({ name: "Car registration", frequency: "onetime", anchorDate: "2026-10-30", dayOfMonth: null, amount: "89.00" }),
    });
  });

  it("Edit: a row opens its sheet and saves the change by id", async () => {
    const user = userEvent.setup();
    renderUi(<BillsView data={bills()} />);
    await user.click(screen.getByRole("button", { name: "Edit Rent" }));
    const amount = screen.getByTestId("item-amount") as HTMLInputElement;
    expect(amount.value).toBe("1450");
    await user.clear(amount);
    await user.type(amount, "1475");
    await user.click(screen.getByTestId("item-save"));
    expect(mocks.updateItem.mock.calls[0]![0]).toEqual({ id: "i2", data: expect.objectContaining({ name: "Rent", amount: "1475.00", frequency: "monthly", dayOfMonth: 1, active: "true" }) });
    expect(screen.getByTestId("toast").textContent).toBe("Saved.");
  });

  it("Delete asks first, in a sheet, and only then deletes", async () => {
    const user = userEvent.setup();
    renderUi(<BillsView data={bills()} />);
    await user.click(screen.getByRole("button", { name: "Edit Rent" }));
    await user.click(screen.getByTestId("item-delete"));
    expect(mocks.deleteItem).not.toHaveBeenCalled();
    expect(screen.getByText("Delete Rent?")).toBeTruthy();
    await user.click(screen.getByTestId("confirm-delete"));
    expect(mocks.deleteItem.mock.calls[0]![0]).toEqual({ id: "i2" });
    expect(screen.getByTestId("toast").textContent).toBe("Deleted Rent.");
  });

  it("the active toggle sends the whole item with only `active` changed", async () => {
    const user = userEvent.setup();
    renderUi(<BillsView data={bills()} />);
    await user.click(screen.getByRole("switch", { name: "Electric active" }));
    expect(mocks.updateItem.mock.calls[0]![0]).toEqual({
      id: "i3",
      data: { name: "Electric", kind: "bill", amount: "142.18", amountKind: "estimate", frequency: "monthly", dayOfMonth: 12, anchorDate: null, categoryId: "c2", debtId: null, active: "false" },
    });
    expect(screen.getByTestId("toast").textContent).toBe("Electric paused.");
  });

  it("states: skeleton once, an error Note with Retry, an empty Note", async () => {
    const { unmount } = renderUi(<BillsView data={bills({ items: loaded<RecurringItem[]>(undefined) })} />);
    expect(screen.getByTestId("plan-skeleton")).toBeTruthy();
    unmount();
    const user = userEvent.setup();
    const refetch = vi.fn();
    const failed = renderUi(<BillsView data={bills({ items: loaded<RecurringItem[]>(undefined, { state: "failed", refetch }) })} />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
    failed.unmount();
    renderUi(<BillsView data={bills({ items: loaded<RecurringItem[]>([]) })} />);
    expect(screen.getByText(/Nothing in your plan yet/)).toBeTruthy();
  });
});

// ── DEBT ─────────────────────────────────────────────────────────────────────

const debt = (id: string, name: string, apr: string, min: string, over: Partial<Debt> = {}) =>
  ({ id, name, balance: "4200.00", apr, minPayment: min, payment: min, status: "active", sortOrder: 1, dueDay: 12, balanceSource: "plaid", aprSource: "plaid", minPaymentSource: "manual", ...over }) as Debt;
const DEBTS = [debt("d1", "Card A", "0.2499", "95.00"), debt("d2", "Card B", "0.1899", "60.00", { dueDay: 21, aprSource: "manual", balanceSource: "manual" })];
const PLAN = {
  asOf: "2026-10-07",
  strategy: "avalanche",
  extraMonthly: 250,
  comparison: {
    avalanche: { monthsToFreedom: 29, debtFreeMonth: "2029-03", totalInterest: 3480, firstKill: { debtId: "d2", month: "2027-01" } },
    snowball: { monthsToFreedom: 30, debtFreeMonth: "2029-04", totalInterest: 3720, firstKill: { debtId: "d2", month: "2027-01" } },
    delta: { months: 1, interest: 240 },
    killMonths: [],
    detail: { debts: [{ debtId: "d1", name: "Card A", apr: 0.2499, balance: 98765.43, minPayment: 95, minPaymentSource: "manual" }] },
  },
  range: {
    earliestMonth: "2029-03", latestMonth: "2029-11", interestLow: 3480, interestHigh: 4650, newChargesPerMonth: 0, runs: [],
    assumptions: [{ key: "a1", text: "Payments continue at today's minimums plus your extra." }],
  },
  milestones: {
    achieved: [{ key: "m1", label: "First card at zero", debtId: null, achievedOn: "2026-08-14" }],
    next: { key: "m2", label: "Half paid", estimatedMonth: "2027-06" },
    upcoming: [],
  },
  planned60d: [{ date: "2026-10-12", itemId: "x1", debtId: "d1", label: "Card A minimum", amount: 95 }],
  confirmedMtd: 155,
  paidDownGenuineMtd: 155,
  assumptions: [],
} as unknown as DebtPlan;
const debtData = (over: Partial<DebtData> = {}): DebtData => ({
  spine: spineRead(),
  plan: loaded(PLAN),
  settings: loaded({ strategy: "avalanche", extraSource: "manual", manualExtra: "250.00", budgetMode: "budgeted" } as DebtData["settings"]["data"]),
  extra: loaded({ source: "manual", amount: "250.00", monthStart: "2026-10-01", availableMoney: "420.00" } as DebtData["extra"]["data"]),
  debts: loaded(DEBTS),
  ...over,
});

describe("Debt — % paid, a range, never an amount owed", () => {
  it("the hero is the percent paid and nothing else", () => {
    const { container } = renderUi(<DebtView data={debtData()} now={NOW} />);
    expect(container.querySelectorAll("[data-size='xl']")).toHaveLength(1);
    const hero = screen.getByTestId("debt-hero");
    expect(hero.textContent).toContain("41%");
    expect(hero.textContent).toContain("paid");
    expect(hero.textContent).not.toContain("$");
  });

  it("⭐ the law: no amount owed reaches the page, even if one were smuggled onto the spine and the plan", () => {
    const smuggled = { ...SPINE, debt: { payoffPct: 41.3, balance: "98765.43", owed: "98765.43", totalOwed: 98765.43 } } as unknown as Spine;
    renderUi(<DebtView data={debtData({ spine: spineRead(smuggled) })} now={NOW} />);
    const text = document.body.textContent!;
    expect(text).not.toMatch(/98,?765/);
    expect(text).not.toMatch(/4,?200/); // a per-debt balance lives inside its sheet only
    const hero = screen.getByTestId("debt-hero").textContent!;
    expect(hero.toLowerCase()).not.toMatch(/\bowed?\b|\bowing\b|balance due|balance remaining|remaining debt|\blimit of\b|credit limit/);
    expect(text.toLowerCase()).not.toMatch(/\bowed?\b|\bowing\b|balance due|balance remaining|remaining debt|total balance/);
  });

  it("the finish is a range of months and a range of interest — never one date", () => {
    renderUi(<DebtView data={debtData()} now={NOW} />);
    expect(screen.getByTestId("range-line").textContent).toBe("Debt-free around Mar 2029 to Nov 2029");
    expect(screen.getByTestId("interest-range").textContent).toBe("Projected interest $3,480 to $4,650");
    expect(document.body.textContent).not.toMatch(/debt[- ]free on\b/i);
    expect(document.body.textContent).not.toMatch(/debt[- ]free (by|on) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/i);
  });

  it("an open-ended latest month says 'or later', not a date", () => {
    const open = { ...PLAN, range: { ...PLAN.range, latestMonth: null } } as DebtPlan;
    renderUi(<DebtView data={debtData({ plan: loaded(open) })} now={NOW} />);
    expect(screen.getByTestId("range-line").textContent).toBe("Debt-free around Mar 2029 or later");
  });

  it("the strategy switch PUTs the setting; the comparison shows both, months, interest and first kill", async () => {
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    const table = screen.getByTestId("comparison");
    expect(table.textContent).toContain("29");
    expect(table.textContent).toContain("Mar 2029");
    expect(table.textContent).toContain("$3,480");
    expect(table.textContent).toContain("$3,720");
    expect(table.textContent).toContain("Card B, Jan 2027");
    expect(within(table).getByText("your plan").closest("th")!.textContent).toContain("Avalanche");
    expect(screen.getByRole("radio", { name: "Avalanche" }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("radio", { name: "Snowball" }));
    expect(mocks.putSettings.mock.calls[0]![0]).toEqual({ data: { strategy: "snowball" } });
  });

  it("the extra: 'safe up to', a warning past it, and a PUT of manualExtra", async () => {
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    expect(screen.getByTestId("safe-cap").textContent).toBe("safe up to $420");
    const input = screen.getByTestId("input-extra") as HTMLInputElement;
    expect(input.value).toBe("250");
    await user.clear(input);
    await user.type(input, "500");
    expect(screen.getByTestId("over-safe")).toBeTruthy();
    await user.click(screen.getByTestId("save-extra"));
    expect(mocks.putSettings.mock.calls[0]![0]).toEqual({ data: { manualExtra: "500.00" } });
    expect(screen.getByTestId("toast").textContent).toBe("Extra payment saved.");
  });

  it("a bad extra is refused in words; a budget-sourced extra becomes a fixed one only on Save", async () => {
    const user = userEvent.setup();
    const settings = loaded({ strategy: "avalanche", extraSource: "budget_net", manualExtra: "250.00", budgetMode: "budgeted" } as DebtData["settings"]["data"]);
    renderUi(<DebtView data={debtData({ settings })} now={NOW} />);
    const input = screen.getByTestId("input-extra");
    await user.clear(input);
    await user.type(input, "lots");
    await user.click(screen.getByTestId("save-extra"));
    expect(screen.getByRole("alert").textContent).toContain("Enter a dollar amount");
    expect(mocks.putSettings).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "100");
    await user.click(screen.getByTestId("save-extra"));
    expect(mocks.putSettings.mock.calls[0]![0]).toEqual({ data: { manualExtra: "100.00", extraSource: "manual" } });
  });

  it("milestones: achieved with their dates, the next with its estimated month", () => {
    renderUi(<DebtView data={debtData()} now={NOW} />);
    expect(screen.getByTestId("milestone-achieved").textContent).toContain("First card at zero");
    expect(screen.getByTestId("milestone-achieved").textContent).toContain("reached Aug 14");
    expect(screen.getByTestId("milestone-next").textContent).toContain("Next: Half paid");
    expect(screen.getByTestId("milestone-next").textContent).toContain("around Jun 2027");
  });

  it("paid down this month, and the next 60 days, each with a way to log a payment", () => {
    renderUi(<DebtView data={debtData()} now={NOW} />);
    expect(screen.getByTestId("paid-down").textContent).toBe("Paid down $155 this month");
    const planned = screen.getByTestId("planned-list");
    expect(planned.textContent).toContain("Card A minimum");
    expect(planned.textContent).toContain("Mon, Oct 12");
    expect(figuresIn(planned)).toEqual([["$95", "95.00"]]);
  });

  it("nothing paid down says so, without a zero amount", () => {
    renderUi(<DebtView data={debtData({ plan: loaded({ ...PLAN, paidDownGenuineMtd: 0 } as DebtPlan) })} now={NOW} />);
    expect(screen.getByTestId("paid-down").textContent).toBe("Nothing paid down yet this month.");
  });

  it("Log a payment POSTs the claim and says exactly what it means", async () => {
    mocks.createPayment = succeeds({ killed: false });
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Log a payment to Card A" }));
    await user.click(screen.getByTestId("pay-submit"));
    expect(screen.getByRole("alert").textContent).toContain("Enter an amount above $0");
    expect(mocks.createPayment).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("pay-amount"), "100");
    expect((screen.getByTestId("pay-date") as HTMLInputElement).value).toBe("2026-10-07");
    await user.click(screen.getByTestId("pay-submit"));
    expect(mocks.createPayment.mock.calls[0]![0]).toEqual({ id: "d1", data: { amount: "100.00", occurredOn: "2026-10-07" } });
    expect(screen.getByTestId("toast").textContent).toBe("Logged. It counts as paid once the bank shows it.");
    expect(LOGGED_TOAST).toBe("Logged. It counts as paid once the bank shows it.");
  });

  it("a payment that clears a debt says so after the claim", async () => {
    mocks.createPayment = succeeds({ killed: true });
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Log a payment to Card B" }));
    await user.type(screen.getByTestId("pay-amount"), "60");
    await user.click(screen.getByTestId("pay-submit"));
    expect(screen.getByTestId("toast").textContent).toBe(`${LOGGED_TOAST} Card B is paid off.`);
  });

  it("logging from the planned list starts with the planned amount", async () => {
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    await user.click(within(screen.getByTestId("planned-list")).getByRole("button", { name: "Log a payment" }));
    expect((screen.getByTestId("pay-amount") as HTMLInputElement).value).toBe("95");
  });

  it("the debts list: APR, minimum, due day and where each came from; edit sends only what changed", async () => {
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    const rows = screen.getAllByTestId("debt-row");
    expect(rows[0]!.textContent).toContain("24.99% APR (from the bank)");
    expect(rows[0]!.textContent).toContain("minimum $95 (entered by you)");
    expect(rows[0]!.textContent).toContain("due the 12th");
    await user.click(screen.getByRole("button", { name: "Edit Card A" }));
    expect(screen.getByTestId("debt-sheet-balance").textContent).toContain("$4,200");
    expect((screen.getByTestId("debt-apr") as HTMLInputElement).disabled).toBe(true);
    const min = screen.getByTestId("debt-min");
    await user.clear(min);
    await user.type(min, "120");
    await user.click(screen.getByTestId("debt-save"));
    expect(mocks.updateDebt.mock.calls[0]![0]).toEqual({ id: "d1", data: { minPayment: "120.00" } });
  });

  it("editing a typed debt converts the percent back to the API's fraction", async () => {
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Edit Card B" }));
    const apr = screen.getByTestId("debt-apr");
    await user.clear(apr);
    await user.type(apr, "17.5");
    await user.click(screen.getByTestId("debt-save"));
    expect(mocks.updateDebt.mock.calls[0]![0]).toEqual({ id: "d2", data: { apr: "0.1750" } });
  });

  it("Archive asks first, then sets the status", async () => {
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Edit Card B" }));
    await user.click(screen.getByTestId("debt-archive"));
    expect(mocks.updateDebt).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("confirm-archive"));
    expect(mocks.updateDebt.mock.calls[0]![0]).toEqual({ id: "d2", data: { status: "archived" } });
    expect(screen.getByTestId("toast").textContent).toBe("Card B archived.");
  });

  it("Add a debt validates, then creates it", async () => {
    const user = userEvent.setup();
    renderUi(<DebtView data={debtData()} now={NOW} />);
    await user.click(screen.getByTestId("add-debt"));
    await user.click(screen.getByTestId("debt-save"));
    expect(screen.getByText("Give it a name.")).toBeTruthy();
    expect(mocks.createDebt).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("debt-name"), "Store card");
    await user.type(screen.getByTestId("debt-balance"), "800");
    await user.type(screen.getByTestId("debt-apr"), "22.9");
    await user.type(screen.getByTestId("debt-min"), "35");
    await user.type(screen.getByTestId("debt-due"), "15");
    await user.click(screen.getByTestId("debt-save"));
    expect(mocks.createDebt.mock.calls[0]![0]).toEqual({ data: { name: "Store card", apr: "0.2290", minPayment: "35.00", balance: "800.00", dueDay: 15 } });
  });

  it("states: nothing to project is a Note; a failed plan keeps the page and offers Retry; no debts is an empty Note", async () => {
    const user = userEvent.setup();
    const none = { ...PLAN, range: { ...PLAN.range, earliestMonth: null, latestMonth: null } } as DebtPlan;
    const a = renderUi(<DebtView data={debtData({ plan: loaded(none), debts: loaded<Debt[]>([]) })} now={NOW} />);
    expect(screen.getByText("Not enough on file to project a finish yet.")).toBeTruthy();
    expect(screen.getByText(/No debts on the plan yet/)).toBeTruthy();
    a.unmount();
    const refetch = vi.fn();
    renderUi(<DebtView data={debtData({ plan: loaded<DebtPlan>(undefined, { state: "failed", refetch }) })} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.getByTestId("debt-hero").textContent).toContain("41%");
  });

  it("no starting balance: the hero says so rather than showing 0%", () => {
    const empty = { ...SPINE, debt: { payoffPct: null } } as unknown as Spine;
    renderUi(<DebtView data={debtData({ spine: spineRead(empty) })} now={NOW} />);
    const hero = screen.getByTestId("debt-hero");
    expect(hero.textContent).toContain("—");
    expect(hero.textContent).toContain("No debt has a starting balance yet.");
  });
});

// ── CATEGORIES ───────────────────────────────────────────────────────────────

const line = (id: string, name: string, planned: string, posted: string, pending: string, over: Record<string, unknown> = {}) =>
  ({
    id, categoryId: id, categoryName: name, plannedAmount: planned, actualAmount: (Number(posted) + Number(pending)).toFixed(2),
    postedAmount: posted, pendingAmount: pending, combinedAmount: (Number(posted) + Number(pending)).toFixed(2),
    groupName: "Home", sourceKind: "manual", planSource: "unbacked", sortOrder: 1, kind: "expense", pinned: false,
    plannedSource: { kind: "manual", bills: [] }, ...over,
  }) as unknown as BudgetMonthDetail["lines"][number];
const HOUSING = line("c1", "Housing", "1450.00", "1450.00", "0.00", { sourceKind: "auto_bills", planSource: "bills", plannedSource: { kind: "bills", bills: [{ id: "i2", name: "Rent", amount: "1450.00", frequency: "monthly", eventCount: 1 }] } });
const UTIL = line("c2", "Utilities", "260.00", "142.18", "30.00");
const FOOD = line("c4", "Groceries", "100.00", "112.00", "0.00", { groupName: "Everyday" });
const MONTH = {
  monthStart: "2026-10-01",
  monthPinned: false,
  lines: [HOUSING, UTIL, FOOD],
  groups: [
    { groupName: "Home", plannedTotal: "1710.00", actualTotal: "1622.18", lines: [HOUSING, UTIL] },
    { groupName: "Everyday", plannedTotal: "100.00", actualTotal: "112.00", lines: [FOOD] },
  ],
  summary: { expenses: { budget: "1810.00", actual: "1734.18" }, income: { budget: "0", actual: "0" }, net: { budget: "0", actual: "0" }, percentSpent: { budget: "0", actual: "0" } },
  replacedPendingIds: [],
  inheritedCategories: [],
} as unknown as BudgetMonthDetail;
const cats = (over: Partial<CategoriesData> = {}): CategoriesData => ({ month: loaded(MONTH), ...over });

describe("Categories — the month's plan, line by line", () => {
  it("groups by the server's group names; planned, spent (posted + pending) and what is left", () => {
    renderUi(<CategoriesView data={cats()} monthStart="2026-10-01" onMonth={() => {}} now={NOW} />);
    expect(screen.getAllByTestId("group").map((g) => g.querySelector("h2")!.textContent)).toEqual(["Home", "Everyday"]);
    const util = screen.getAllByTestId("plan-line")[1]!;
    expect(util.textContent).toContain("Utilities");
    expect(within(util).getByTestId("line-actual").textContent).toBe("$172");
    expect(util.textContent).toContain("$142 posted, $30 pending");
    expect(util.textContent).toContain("$88 left");
    const food = screen.getAllByTestId("plan-line")[2]!;
    expect(food.textContent).toContain("over by $12");
    expect(figuresIn(screen.getByTestId("figure-month"))).toEqual([["$1,810", "1810.00"], ["$1,734", "1734.18"]]);
  });

  it("tapping the spent figure opens that category's Activity for the month", () => {
    renderUi(<CategoriesView data={cats()} monthStart="2026-10-01" onMonth={() => {}} now={NOW} />);
    const link = within(screen.getAllByTestId("plan-line")[1]!).getByTestId("line-actual");
    expect(link.getAttribute("href")).toBe("/activity?categoryId=c2&from=2026-10-01&to=2026-10-31");
  });

  it("only an envelope you set is editable; a bill-backed line is read-only and says where it comes from", async () => {
    const user = userEvent.setup();
    expect(isEditableLine(UTIL)).toBe(true);
    expect(isEditableLine(HOUSING)).toBe(false);
    renderUi(<CategoriesView data={cats()} monthStart="2026-10-01" onMonth={() => {}} now={NOW} />);
    const housing = screen.getAllByTestId("plan-line")[0]!;
    expect(within(housing).queryByRole("textbox")).toBeNull();
    expect(within(housing).getByTestId("line-planned-readonly").textContent).toBe("Planned $1,450");
    await user.click(within(housing).getByText("Where this comes from"));
    expect(housing.textContent).toContain("comes from the bills filed under it");
    expect(housing.textContent).toContain("Rent");
  });

  it("inline edit: leaving the field saves the planned amount to the budget line", async () => {
    const user = userEvent.setup();
    renderUi(<CategoriesView data={cats()} monthStart="2026-10-01" onMonth={() => {}} now={NOW} />);
    const input = screen.getByRole("textbox", { name: "Planned for Utilities" }) as HTMLInputElement;
    expect(input.value).toBe("260");
    await user.clear(input);
    await user.type(input, "275");
    await user.tab();
    expect(mocks.upsertLine).toHaveBeenCalledTimes(1);
    expect(mocks.upsertLine.mock.calls[0]![0]).toEqual({ data: { monthStart: "2026-10-01", categoryId: "c2", plannedAmount: "275.00" } });
    expect(screen.getByTestId("toast").textContent).toBe("Utilities planned at $275.");
  });

  it("an unchanged or invalid amount sends nothing", async () => {
    const user = userEvent.setup();
    renderUi(<CategoriesView data={cats()} monthStart="2026-10-01" onMonth={() => {}} now={NOW} />);
    const input = screen.getByRole("textbox", { name: "Planned for Groceries" });
    await user.click(input);
    await user.tab();
    expect(mocks.upsertLine).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "ten");
    await user.tab();
    expect(mocks.upsertLine).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Enter a dollar amount");
  });

  it("the month picker moves a month at a time", async () => {
    const user = userEvent.setup();
    const onMonth = vi.fn();
    renderUi(<CategoriesView data={cats()} monthStart="2026-10-01" onMonth={onMonth} now={NOW} />);
    expect(screen.getByTestId("month-label").textContent).toBe("October 2026");
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(onMonth.mock.calls.map((c) => c[0])).toEqual(["2026-11-01", "2026-09-01"]);
  });

  it("states: skeleton once, error with Retry, an empty month", async () => {
    const user = userEvent.setup();
    const a = renderUi(<CategoriesView data={cats({ month: loaded<BudgetMonthDetail>(undefined) })} monthStart="2026-10-01" onMonth={() => {}} now={NOW} />);
    expect(screen.getByTestId("plan-skeleton")).toBeTruthy();
    a.unmount();
    const refetch = vi.fn();
    const b = renderUi(<CategoriesView data={cats({ month: loaded<BudgetMonthDetail>(undefined, { state: "failed", refetch }) })} monthStart="2026-10-01" onMonth={() => {}} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
    b.unmount();
    renderUi(<CategoriesView data={cats({ month: loaded({ ...MONTH, groups: [] } as BudgetMonthDetail) })} monthStart="2026-10-01" onMonth={() => {}} now={NOW} />);
    expect(screen.getByText(/Nothing is planned for October 2026 yet/)).toBeTruthy();
  });
});

// ── WISH LIST ────────────────────────────────────────────────────────────────

// The wish list is a real page now: see screens/ask/askPages.test.tsx.

// ── THE FRAME ────────────────────────────────────────────────────────────────

describe("the section index", () => {
  it("six links, the current page marked", () => {
    renderUi(<WeekView data={week()} now={NOW} />);
    const nav = screen.getByRole("navigation", { name: "Plan sections" });
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["The week", "/plan"],
      ["Bills", "/plan/bills"],
      ["Debt", "/plan/debt"],
      ["Categories", "/plan/categories"],
      ["Wish list", "/plan/wishlist"],
      ["Proposals", "/plan/proposals"],
    ]);
    expect(within(nav).getByRole("link", { name: "The week" }).getAttribute("aria-current")).toBe("page");
  });
});
