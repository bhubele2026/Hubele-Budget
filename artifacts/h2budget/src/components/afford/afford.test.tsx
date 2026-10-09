import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (F6) The Afford sheet shows what the server worked out and sends what the
 * person typed. Ported from the frozen h2 app's afford.test.tsx. Every hook is
 * answered at the boundary; each figure is checked to the cent (`<data value>`).
 */
type Fn = ReturnType<typeof vi.fn>;
const q = (data: unknown) => ({ data, isFetching: false, isLoading: false, isError: false });
const mocks = vi.hoisted(() => ({
  afford: null as unknown as Fn,
  createWish: null as unknown as Fn,
  plans: null as unknown,
  me: null as unknown,
  members: null as unknown,
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useListCategories: () =>
    q([
      { id: "c1", name: "Dining", kind: "expense" },
      { id: "c9", name: "Uncategorized", kind: "expense", excludeFromBudget: true },
    ]),
  useGetMe: () => q(mocks.me),
  useListMembers: () => q(mocks.members),
}));
vi.mock("@workspace/api-client-react/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react/features")>()),
  useEvaluateAfford: () => ({ mutateAsync: mocks.afford, isPending: false }),
  useCreateWishlistItem: () => ({ mutateAsync: mocks.createWish, isPending: false }),
  useGetMoneyPosition: () => q({ paydayDate: "2026-10-09" }),
  useListAllowancePlans: () => q(mocks.plans),
}));

import { AffordLauncher } from "./AffordLauncher";

// Wednesday Oct 7, 2026, 10:00 in Chicago.
const fig = (safe: string, week: string, payday: string, lowest: string, over: Record<string, string | null> = {}) => ({
  safeToSpendNow: safe,
  remainingWeek: week,
  availableUntilPayday: payday,
  lowest,
  lowestDate: "2026-10-13",
  debtFreeEarliest: "2027-03",
  debtFreeLatest: "2027-06",
  totalInterestLow: "1800.00",
  ...over,
});
const result = (over: Record<string, unknown> = {}) =>
  ({
    amount: "300.00",
    dateISO: "2026-10-10",
    baseline: fig("144.50", "144.50", "2124.50", "2624.50"),
    proposed: fig("0.00", "-155.50", "1824.25", "2324.50"),
    delta: {},
    category: { categoryId: "c1", remainingBefore: "274.50", remainingAfter: "-25.50" },
    debt: { affected: false, cut: "0.00", cutMonth: null, debtFreeMonthShift: 0, interestDelta: "0.00" },
    verdict: "tight",
    assumptions: ["Bank data from Oct 7.", "Available credit is not counted."],
    ...over,
  }) as never;

const mount = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const figures = (el: HTMLElement) => Array.from(el.querySelectorAll("data"), (d) => [d.textContent, d.getAttribute("value")]);

async function open() {
  mount(<AffordLauncher />);
  fireEvent.click(screen.getByTestId("afford-open"));
  return screen.findByTestId("afford-form");
}
async function check(r: unknown, amount = "300") {
  mocks.afford.mockResolvedValue(r);
  await open();
  fireEvent.change(screen.getByTestId("afford-amount"), { target: { value: amount } });
  fireEvent.click(screen.getByTestId("afford-check"));
  return screen.findByTestId("afford-result");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T15:00:00Z") });
  mocks.afford = vi.fn().mockResolvedValue(result());
  mocks.createWish = vi.fn().mockResolvedValue({});
  mocks.plans = { plans: [{ id: "p1", memberUserId: null }], suggested: {} };
  mocks.me = { userId: "u1", isOwner: true };
  mocks.members = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Afford launcher and sheet", () => {
  it("the sheet is not mounted until the button is pressed", () => {
    mount(<AffordLauncher />);
    expect(screen.getByTestId("afford-open").textContent).toBe("Can we afford something?");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("amount is required: nothing is sent, and the field says why", async () => {
    await open();
    fireEvent.click(screen.getByTestId("afford-check"));
    expect(mocks.afford).not.toHaveBeenCalled();
    expect((await screen.findAllByRole("alert"))[0].textContent).toContain("above $0");
    fireEvent.change(screen.getByTestId("afford-amount"), { target: { value: "100001" } });
    fireEvent.click(screen.getByTestId("afford-check"));
    expect(mocks.afford).not.toHaveBeenCalled();
  });

  it("sends dollars, today's date by default, and no category or member", async () => {
    await check(result(), "$1,120.50");
    expect(mocks.afford).toHaveBeenCalledWith({ data: { amount: 1120.5, date: "2026-10-07" } });
  });

  it("chips set the date: this weekend is the coming Saturday, next payday is the position's", async () => {
    await open();
    fireEvent.click(screen.getByTestId("afford-when-weekend"));
    expect((screen.getByTestId("afford-date") as HTMLInputElement).value).toBe("2026-10-10");
    expect(screen.getByTestId("afford-when-weekend").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("afford-when-payday"));
    fireEvent.change(screen.getByTestId("afford-amount"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("afford-check"));
    await waitFor(() => expect(mocks.afford).toHaveBeenCalledWith({ data: { amount: 50, date: "2026-10-09" } }));
  });

  it("a category goes in the body; the excluded system category is not offered", async () => {
    await open();
    expect(within(screen.getByTestId("afford-category")).queryByText("Uncategorized")).toBeNull();
    fireEvent.change(screen.getByTestId("afford-category"), { target: { value: "c1" } });
    fireEvent.change(screen.getByTestId("afford-amount"), { target: { value: "75" } });
    fireEvent.click(screen.getByTestId("afford-check"));
    await waitFor(() =>
      expect(mocks.afford).toHaveBeenCalledWith({ data: { amount: 75, date: "2026-10-07", categoryId: "c1" } }),
    );
  });

  it("the member picker appears only when personal allowances exist", async () => {
    await open();
    expect(screen.queryByTestId("afford-member")).toBeNull();
    cleanup();
    mocks.plans = { plans: [{ id: "p2", memberUserId: "u2" }], suggested: {} };
    mocks.members = [{ id: "u2", displayName: "Sam", isOwner: false }];
    await open();
    fireEvent.change(screen.getByTestId("afford-member"), { target: { value: "u2" } });
    expect(within(screen.getByTestId("afford-member")).getByText("Sam")).toBeTruthy();
    fireEvent.change(screen.getByTestId("afford-amount"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("afford-check"));
    await waitFor(() =>
      expect(mocks.afford).toHaveBeenCalledWith({ data: { amount: 20, date: "2026-10-07", member: "u2" } }),
    );
  });

  it.each([
    ["fits", "Fits"],
    ["tight", "Tight"],
    ["breaks_buffer", "Would dip below your buffer"],
    ["breaks_zero", "Would overdraw"],
  ] as const)("the %s verdict reads as the word %s, first in the result", async (verdict, word) => {
    const block = await check(result({ verdict }));
    expect(block.getAttribute("data-verdict")).toBe(verdict);
    expect(screen.getByTestId("afford-verdict").textContent).toBe(word);
    expect(block.firstElementChild).toBe(screen.getByTestId("afford-verdict"));
  });

  it("each delta shows both figures, to the cent", async () => {
    await check(result());
    expect(figures(screen.getByTestId("delta-payday"))).toEqual([["$2,124.50", "2124.50"], ["$1,824.25", "1824.25"]]);
    expect(figures(screen.getByTestId("delta-week"))).toEqual([["$144.50", "144.50"], ["-$155.50", "-155.50"]]);
    expect(screen.getByTestId("delta-category").textContent).toContain("Dining");
  });

  it("no category asked: no category line", async () => {
    await check(result({ category: null }));
    expect(screen.queryByTestId("delta-category")).toBeNull();
  });

  it("debt-free: the range as sent, 'unchanged' or 'later by N months'", async () => {
    await check(result());
    expect(screen.getByTestId("afford-debt").textContent).toBe("Debt-free: Mar 2027–Jun 2027 · unchanged");
    cleanup();
    await check(result({ debt: { affected: true, cut: "300.00", cutMonth: "2026-10", debtFreeMonthShift: 2, interestDelta: "30.00" } }));
    expect(screen.getByTestId("afford-debt-shift").textContent).toBe("later by 2 months");
  });

  it("the server's refusals get words", async () => {
    mocks.afford.mockRejectedValue({ data: { error: "date_past_window" } });
    await open();
    fireEvent.change(screen.getByTestId("afford-amount"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("afford-check"));
    expect((await screen.findByTestId("afford-problem")).textContent).toContain("further out");
    expect(screen.queryByTestId("afford-result")).toBeNull();
  });

  it("changing the question clears the answer; Add to wish list sends title, amount and category", async () => {
    await check(result());
    fireEvent.change(screen.getByTestId("afford-category"), { target: { value: "c1" } });
    expect(screen.queryByTestId("afford-result")).toBeNull();
    mocks.afford.mockResolvedValue(result());
    fireEvent.click(screen.getByTestId("afford-check"));
    await screen.findByTestId("afford-result");
    fireEvent.click(screen.getByTestId("afford-wish"));
    fireEvent.click(screen.getByTestId("afford-wish-save"));
    expect(mocks.createWish).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("afford-wish-title"), { target: { value: "Standing desk" } });
    fireEvent.click(screen.getByTestId("afford-wish-save"));
    await waitFor(() =>
      expect(mocks.createWish).toHaveBeenCalledWith({ data: { title: "Standing desk", amount: 300, categoryId: "c1" } }),
    );
    expect((await screen.findByTestId("afford-added")).textContent).toContain("Added to the wish list");
  });
});
