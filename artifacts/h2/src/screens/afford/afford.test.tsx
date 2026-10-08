import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AffordResult, WishlistItem, WishlistList } from "@workspace/api-client-react";
import type { Read } from "@/data/todayData";

/**
 * ⭐ THE AFFORD SHEET shows what the server worked out and sends what the
 * person typed. Every hook is answered at the boundary; each figure on screen
 * is checked to the cent (`<data value>`) and its whole-dollar face.
 */
type Fn = ReturnType<typeof vi.fn>;
const q = (data: unknown) => ({ data, isFetching: false, isLoadingError: false, isRefetchError: false, isPlaceholderData: false, refetch: vi.fn() });
const mocks = vi.hoisted(() => ({
  afford: null as unknown as Fn,
  createWish: null as unknown as Fn,
  evalWish: null as unknown as Fn,
  plans: null as unknown,
  me: null as unknown,
  members: null as unknown,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  const mut = (k: "afford" | "createWish" | "evalWish") => () => ({ mutateAsync: mocks[k], mutate: mocks[k], isPending: false });
  return {
    ...actual,
    useEvaluateAfford: mut("afford"),
    useCreateWishlistItem: mut("createWish"),
    useEvaluateWishlistItem: mut("evalWish"),
    useUpdateWishlistItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useListCategories: () => q([{ id: "c1", name: "Dining", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 1 }, { id: "c9", name: "Uncategorized", kind: "expense", groupName: "x", sourceKind: "manual", sortOrder: 9, excludeFromBudget: true }]),
    useGetMoneyPosition: () => q({ paydayDate: "2026-10-09" }),
    useListAllowancePlans: () => q(mocks.plans),
    useGetMe: () => q(mocks.me),
    useListMembers: () => q(mocks.members),
  };
});

import { AffordLauncher } from "./AffordLauncher";
import { comingSaturday } from "./AffordSheet";
import { monthWord } from "./verdict";
import { WishlistView } from "@/screens/plan/PlanWishlist";

// Wednesday Oct 7, 2026, 10:00 in Chicago.
const NOW = new Date("2026-10-07T15:00:00Z");
const fig = (safe: string, week: string, payday: string, lowest: string, over: Record<string, string | null> = {}) => ({
  safeToSpendNow: safe, remainingWeek: week, availableUntilPayday: payday, lowest, lowestDate: "2026-10-13",
  debtFreeEarliest: "2027-03", debtFreeLatest: "2027-06", totalInterestLow: "1800.00", ...over,
});
const result = (over: Partial<AffordResult> = {}): AffordResult =>
  ({
    amount: "300.00", dateISO: "2026-10-10",
    baseline: fig("144.50", "144.50", "2124.50", "2624.50"),
    proposed: fig("0.00", "-155.50", "1824.25", "2324.50"),
    delta: { safeToSpendNow: "-144.50", remainingWeek: "-300.00", availableUntilPayday: "-300.25", lowest: "-300.00", lowestDate: null, debtFreeEarliest: 0, debtFreeLatest: 0, totalInterestLow: "0.00" },
    category: { categoryId: "c1", remainingBefore: "274.50", remainingAfter: "-25.50" },
    debt: { affected: false, cut: "0.00", cutMonth: null, debtFreeMonthShift: 0, interestDelta: "0.00" },
    verdict: "tight",
    assumptions: ["Bank data from Oct 7.", "Available credit is not counted."],
    ...over,
  }) as AffordResult;

const mount = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const figures = (el: HTMLElement): Array<[string | null, string | null]> => Array.from(el.querySelectorAll("data"), (d) => [d.textContent, d.getAttribute("value")]);

async function open(user: ReturnType<typeof userEvent.setup>) {
  mount(<AffordLauncher variant="quiet" className="w-full" />);
  await user.click(screen.getByTestId("afford-open"));
  return screen.findByTestId("afford-form");
}
async function check(user: ReturnType<typeof userEvent.setup>, r: AffordResult, amount = "300") {
  mocks.afford.mockResolvedValue(r);
  await open(user);
  await user.type(screen.getByTestId("afford-amount"), amount);
  await user.click(screen.getByTestId("afford-check"));
  return screen.findByTestId("afford-result");
}

beforeEach(() => {
  // Only the clock: user-event and timers keep running for real.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  mocks.afford = vi.fn().mockResolvedValue(result());
  mocks.createWish = vi.fn().mockResolvedValue({});
  mocks.evalWish = vi.fn();
  mocks.plans = { plans: [{ id: "p1", memberUserId: null, period: "weekly", amount: "250.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null }], suggested: {} };
  mocks.me = { userId: "u1", isOwner: true };
  mocks.members = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Afford — the launcher and the sheet", () => {
  it("the sheet is not mounted until the button is pressed, and the button is quiet and full width", async () => {
    mount(<AffordLauncher variant="quiet" className="w-full" />);
    const b = screen.getByTestId("afford-open");
    expect(b.textContent).toBe("Can we afford something?");
    expect(b.className).toContain("w-full");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("amount is required: nothing is sent, and the field says why", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByTestId("afford-check"));
    expect(mocks.afford).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain("above $0");
    await user.type(screen.getByTestId("afford-amount"), "0");
    await user.click(screen.getByTestId("afford-check"));
    expect(mocks.afford).not.toHaveBeenCalled();
    await user.clear(screen.getByTestId("afford-amount"));
    await user.type(screen.getByTestId("afford-amount"), "100001");
    await user.click(screen.getByTestId("afford-check"));
    expect(mocks.afford).not.toHaveBeenCalled();
  });

  it("sends the amount in dollars, today's date by default, and no category or member", async () => {
    const user = userEvent.setup();
    await check(user, result(), "$1,120.50");
    expect(mocks.afford).toHaveBeenCalledWith({ data: { amount: 1120.5, date: "2026-10-07" } });
  });

  it("chips set the date: this weekend is the coming Saturday, next payday is the position's", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByTestId("afford-when-weekend"));
    expect((screen.getByTestId("afford-date") as HTMLInputElement).value).toBe("2026-10-10");
    expect(screen.getByTestId("afford-when-weekend").getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByTestId("afford-when-payday"));
    await user.type(screen.getByTestId("afford-amount"), "50");
    await user.click(screen.getByTestId("afford-check"));
    await waitFor(() => expect(mocks.afford).toHaveBeenCalledWith({ data: { amount: 50, date: "2026-10-09" } }));
    expect(comingSaturday("2026-10-10")).toBe("2026-10-10");
    expect(comingSaturday("2026-10-11")).toBe("2026-10-17");
  });

  it("a category goes in the body; the uncategorized system category is not offered", async () => {
    const user = userEvent.setup();
    await open(user);
    const select = screen.getByTestId("afford-category");
    expect(within(select).queryByText("Uncategorized")).toBeNull();
    await user.selectOptions(select, "c1");
    await user.type(screen.getByTestId("afford-amount"), "75");
    await user.click(screen.getByTestId("afford-check"));
    await waitFor(() => expect(mocks.afford).toHaveBeenCalledWith({ data: { amount: 75, date: "2026-10-07", categoryId: "c1" } }));
  });

  it("the member picker appears only when personal allowances exist, and sends the member", async () => {
    const user = userEvent.setup();
    await open(user);
    expect(screen.queryByTestId("afford-member")).toBeNull();
    cleanup();
    mocks.plans = { plans: [{ id: "p2", memberUserId: "u2", period: "weekly", amount: "40.00", effectiveFrom: "2026-09-27", source: "owner", derivation: null }], suggested: {} };
    mocks.members = [{ id: "u2", displayName: "Sam", isOwner: false }];
    await open(user);
    await user.selectOptions(screen.getByTestId("afford-member"), "u2");
    expect(within(screen.getByTestId("afford-member")).getByText("Sam")).toBeTruthy();
    await user.type(screen.getByTestId("afford-amount"), "20");
    await user.click(screen.getByTestId("afford-check"));
    await waitFor(() => expect(mocks.afford).toHaveBeenCalledWith({ data: { amount: 20, date: "2026-10-07", member: "u2" } }));
  });

  it.each([
    ["fits", "Fits"],
    ["tight", "Tight"],
    ["breaks_buffer", "Would dip below your buffer"],
    ["breaks_zero", "Would overdraw"],
  ] as const)("the %s verdict reads as the word %s, first in the result", async (verdict, word) => {
    const user = userEvent.setup();
    const block = await check(user, result({ verdict }));
    expect(block.getAttribute("data-verdict")).toBe(verdict);
    expect(screen.getByTestId("afford-verdict").textContent).toBe(word);
    expect(block.firstElementChild).toBe(screen.getByTestId("afford-verdict"));
  });

  it("each delta shows both figures, to the cent, with the whole-dollar face", async () => {
    const user = userEvent.setup();
    await check(user, result());
    expect(figures(screen.getByTestId("delta-payday"))).toEqual([["$2,125", "2124.50"], ["$1,824", "1824.25"]]);
    expect(figures(screen.getByTestId("delta-week"))).toEqual([["$145", "144.50"], ["-$156", "-155.50"]]);
    expect(screen.getByTestId("delta-week").textContent).toContain("left");
    expect(screen.getByTestId("delta-payday").textContent).toContain("Free until payday");
    expect(screen.getByTestId("delta-category").textContent).toContain("Dining");
    expect(figures(screen.getByTestId("delta-category"))).toEqual([["$275", "274.50"], ["-$26", "-25.50"]]);
  });

  it("no category asked: no category line", async () => {
    const user = userEvent.setup();
    await check(user, result({ category: null }));
    expect(screen.queryByTestId("delta-category")).toBeNull();
  });

  it("debt-free: the range as the server sent it, 'unchanged' or 'later by N months'", async () => {
    const user = userEvent.setup();
    await check(user, result());
    expect(screen.getByTestId("afford-debt").textContent).toBe("Debt-free: Mar 2027–Jun 2027 · unchanged");
    cleanup();
    await check(user, result({ proposed: fig("0.00", "-155.50", "1824.25", "2324.50", { debtFreeEarliest: "2027-05", debtFreeLatest: "2027-08" }), debt: { affected: true, cut: "300.00", cutMonth: "2026-10", debtFreeMonthShift: 2, interestDelta: "30.00" } }));
    expect(screen.getByTestId("afford-debt").textContent).toBe("Debt-free: May 2027–Aug 2027 · later by 2 months");
    cleanup();
    await check(user, result({ debt: { affected: true, cut: "10.00", cutMonth: "2026-10", debtFreeMonthShift: 1, interestDelta: "1.00" } }));
    expect(screen.getByTestId("afford-debt-shift").textContent).toBe("later by 1 month");
    cleanup();
    await check(user, result({ baseline: fig("1", "1", "1", "1", { debtFreeEarliest: null, debtFreeLatest: null }), proposed: fig("1", "1", "1", "1", { debtFreeEarliest: null, debtFreeLatest: null }) }));
    expect(screen.queryByTestId("afford-debt")).toBeNull();
  });

  it("the assumptions sit behind a disclosure", async () => {
    const user = userEvent.setup();
    await check(user, result());
    const list = screen.getByTestId("afford-assumptions");
    expect(list.closest("details")).toBeTruthy();
    expect(list.textContent).toContain("Available credit is not counted.");
  });

  it("changing an input clears the answer so it never sits beside a different question", async () => {
    const user = userEvent.setup();
    await check(user, result());
    await user.type(screen.getByTestId("afford-amount"), "5");
    expect(screen.queryByTestId("afford-result")).toBeNull();
  });

  it("a date past the server's window is said in words", async () => {
    const user = userEvent.setup();
    mocks.afford.mockRejectedValue({ status: 400, data: { error: "date_past_window" } });
    await open(user);
    await user.type(screen.getByTestId("afford-amount"), "20");
    await user.click(screen.getByTestId("afford-check"));
    expect((await screen.findByTestId("afford-problem")).textContent).toContain("further out than H2 can see");
  });

  it("Add to wish list asks for a title, then posts the title, amount and category; nothing else is saved", async () => {
    const user = userEvent.setup();
    await check(user, result(), "480.50");
    await user.selectOptions(screen.getByTestId("afford-category"), "c1");
    // The answer was cleared by the category change; ask again.
    await user.click(screen.getByTestId("afford-check"));
    await screen.findByTestId("afford-result");
    expect(mocks.createWish).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("afford-wish"));
    await user.click(screen.getByTestId("afford-wish-save"));
    expect(mocks.createWish).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("afford-wish-title"), "Standing desk");
    await user.click(screen.getByTestId("afford-wish-save"));
    await waitFor(() => expect(mocks.createWish).toHaveBeenCalledWith({ data: { title: "Standing desk", amount: 480.5, categoryId: "c1" } }));
    expect((await screen.findByTestId("afford-added")).textContent).toBe("Added to the wish list.");
  });

  it("Close hands focus back to the button that opened it", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByTestId("afford-close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("afford-open"));
    await user.click(screen.getByTestId("afford-open"));
    await screen.findByTestId("afford-form");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("afford-open"));
  });

  it("the link variant is the same sheet", async () => {
    const user = userEvent.setup();
    mount(<AffordLauncher variant="link" data-testid="afford-open-week" />);
    await user.click(screen.getByTestId("afford-open-week"));
    expect(await screen.findByTestId("afford-form")).toBeTruthy();
  });

  it("months read as words", () => {
    expect(monthWord("2027-03")).toBe("Mar 2027");
    expect(monthWord(null)).toBeNull();
  });
});

describe("Wish list — Check now", () => {
  const item = (id: string, title: string, over: Partial<WishlistItem> = {}): WishlistItem => ({
    id, title, amount: 480, url: null, categoryId: null, targetDate: null, requestedBy: "u1", requestedAt: "2026-10-05T12:00:00Z",
    waitingUntil: "2026-10-12", waitingDaysLeft: 5, decision: "pending", decidedAt: null, ...over,
  });
  const list = (items: WishlistItem[]): Read<WishlistList> => ({ data: { items, waitDays: 7 }, state: "loaded", isFetching: false, refetch: vi.fn() });

  it("Check now evaluates the item and shows the stored answer: the word, the date and the figure after", async () => {
    const user = userEvent.setup();
    mocks.evalWish.mockResolvedValue({ itemId: "w1", lastEvaluation: { evaluatedAt: "2026-10-07T15:00:00Z", verdict: "tight", safeToSpendNowAfter: "0.00", availableUntilPaydayAfter: "1644.50" } });
    mount(<WishlistView list={list([item("w1", "Standing desk"), item("w2", "No price", { amount: null }), item("w3", "Approved one", { decision: "approved" })])} />);
    expect(screen.getAllByTestId("wish-check")).toHaveLength(1);
    expect(screen.queryByTestId("wish-eval")).toBeNull();
    await user.click(screen.getByTestId("wish-check"));
    await waitFor(() => expect(mocks.evalWish).toHaveBeenCalledWith({ id: "w1" }));
    const ev = await screen.findByTestId("wish-eval");
    expect(screen.getByTestId("wish-eval-word").textContent).toBe("Tight");
    expect(screen.getByTestId("wish-eval-date").textContent).toBe("evaluated Oct 7");
    expect(figures(ev)).toEqual([["$1,645", "1644.50"]]);
  });

  it("a row that already carries the server's last evaluation shows its verdict word inline", () => {
    const row = { ...item("w1", "Standing desk"), lastEvaluation: { evaluatedAt: "2026-10-06T08:00:00Z", verdict: "breaks_zero", safeToSpendNowAfter: null, availableUntilPaydayAfter: null } } as WishlistItem;
    mount(<WishlistView list={list([row])} />);
    expect(screen.getByTestId("wish-eval-word").textContent).toBe("Would overdraw");
    expect(screen.queryByTestId("wish-eval-after")).toBeNull();
  });

  it("the wish list page links to the same sheet", () => {
    mount(<WishlistView list={list([])} />);
    expect(within(screen.getByTestId("afford-note")).getByRole("button").textContent).toBe("Can we afford something?");
  });
});
