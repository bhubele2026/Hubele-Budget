import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { memoryLocation } from "wouter/memory-location";

// ⭐ (Home is four numbers, 2026-11-11) Checking · Lowest · Spent this week ·
// Debt paid: one big number each, at most one short line, no status chip, and
// the link of the tile it stands for. (Home says less) Spent this week and Debt
// paid carry one thin bar; the week's line is "$X left" or "$X over". Every
// value below is invented.

const h = vi.hoisted(() => ({
  Q: {} as Record<string, unknown>,
  spine: { data: undefined as unknown, state: "loaded", refetch: vi.fn() } as { data: unknown; state: string; refetch: () => void; olderWords?: string | null },
}));
const ok = (data: unknown) => ({ data, isError: false, isLoading: false, refetch: () => {} });
const loading = { data: undefined, isError: false, isLoading: true, refetch: () => {} };
const get = (k: string) => (h.Q[k] ?? loading);
vi.mock("./queries", () => ({
  useMoneyPositionQ: () => get("pos"),
  useCashSignalQ: () => get("cash"),
}));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => h.spine }));
vi.mock("@/lib/routePrefetch", () => ({ prefetchRoute: () => {} }));

import FourNumbers from "./FourNumbers";
import { FOUR_BOX_BAR } from "./tileParts";

const bank = {
  balance: "1234.00", asOfDate: "2026-11-10T20:00:00Z", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null,
  snapshot: { balance: "1234.00", at: "2026-11-10T20:00:00Z", source: "plaid" },
  sinceSnapshot: { net: "0.00", count: 0, through: "2026-11-10" },
  account: { rowId: "c1", externalId: "p-c1", name: "Checking A", mask: "0001", subtype: "checking", via: "sole checking" },
};
const noBank = { ...bank, balance: "0.00", asOfDate: null, source: null, snapshot: null, sinceSnapshot: null, account: null };
const position = { safeToSpendNow: "100.00", remainingWeek: "160.00", knownWeek: "40.00", unresolvedWeek: "0.00", provisional: false, remainingWeekKnown: "160.00", availableUntilPayday: "500.00", paydayDate: "2026-11-13", horizonKind: "payday", withinPlan: "yes", confidence: "firm", degraded: false, weekAdjustment: null };
const spine = (o: Record<string, unknown> = {}) => ({
  asOf: "2026-11-10T15:00:00Z", bank, spentMonth: 300, spentWeek: 40, nextBill: null, billsDueCount: 0,
  forecast: { lowPoint: "600.00", lowPointDate: "2026-11-16", runwayDays: null, cashBuffer: "500.00", status: "tight" },
  debt: { payoffPct: 25.4, nextMilestone: null, paidDownMtd: 300, confirmedPaymentsMtd: 300, newChargesMtd: 0 },
  reviewCount: 0,
  position,
  monthAllowance: { plan: "1000.00", actual: "300.00", status: "within", remaining: "700.00", over: "0.00" },
  ...o,
});

function setup(spineOver: Record<string, unknown> | null = {}) {
  h.spine.data = spineOver === null ? undefined : spine(spineOver);
  const mem = memoryLocation({ path: "/home", record: true });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><Router hook={mem.hook}><FourNumbers /></Router></QueryClientProvider>);
  return mem;
}
const text = (id: string) => screen.getByTestId(id).textContent;
const href = (id: string) => screen.getByTestId(`tile-${id}-link`).getAttribute("href");
const BOXES = ["four-checking", "four-lowest", "four-spent", "four-debt"];

beforeEach(() => {
  h.Q = { pos: ok({ weekCap: "200.00" }), cash: ok({ hookReserves: [] }) };
  h.spine = { data: undefined, state: "loaded", refetch: vi.fn() };
});
afterEach(() => cleanup());

describe("four numbers", () => {
  it("four boxes in order, each ONE big number, a title, a whole-card link and no status chip", () => {
    setup();
    const grid = screen.getByTestId("dash-four");
    expect(Array.from(grid.children, (c) => c.getAttribute("data-testid"))).toEqual(BOXES.map((b) => `tile-${b}`));
    expect(Array.from(grid.querySelectorAll("h2"), (e) => e.textContent)).toEqual(["Checking", "Lowest cash · 90 days", "Spent this week", "Debt paid"]);
    for (const b of BOXES) {
      const box = screen.getByTestId(`tile-${b}`);
      expect(box.querySelectorAll(".text-kpi").length, b).toBe(1);
      expect(screen.queryByTestId(`tile-${b}-status`), b).toBeNull();
      expect(box.querySelector("details"), b).toBeNull(); // no "Why?"
    }
    // Two by two on a phone, one row of four on a desktop; never a six-tile span.
    expect(grid.className).toContain("grid-cols-2");
    expect(grid.className).toContain("lg:grid-cols-4");
    expect(grid.innerHTML).not.toContain("span-4");
  });

  it("links are the old tiles' own", () => {
    setup();
    expect(href("four-checking")).toBe("/banking?account=c1");
    expect(href("four-lowest")).toBe("/forecast?horizon=90");
    expect(href("four-spent")).toBe("/spending/week");
    expect(href("four-debt")).toBe("/avalanche");
  });

  it("loading: four skeleton boxes and no figure", () => {
    setup(null);
    const grid = screen.getByTestId("dash-four");
    expect(grid.children.length).toBe(4);
    expect(grid.querySelectorAll(".skeleton").length).toBe(4);
    // The only digits are the title's own "90 days": no figure before the numbers arrive.
    expect(grid.textContent!.replace("Lowest cash · 90 days", "")).not.toMatch(/[$%\d]/);
    // The two boxes that will carry a bar hold its height from the skeleton on.
    expect(Array.from(grid.children, (c) => c.className.includes(FOUR_BOX_BAR))).toEqual([false, false, true, true]);
  });

  it("a failed first load says so, with a way to try again", () => {
    h.spine.state = "failed";
    setup(null);
    expect(screen.queryByTestId("dash-four")).toBeNull();
    fireEvent.click(screen.getByText("Try again"));
    expect(h.spine.refetch).toHaveBeenCalled();
  });
});

describe("Checking", () => {
  it("the balance, and no line when nothing is waiting to be matched", () => {
    setup();
    expect(text("four-checking-value")).toBe("$1,234.00");
    expect(screen.queryByTestId("four-checking-line")).toBeNull();
  });
  it("'N to match' only when rows wait; one row is singular", () => {
    setup({ reviewCount: 3 });
    expect(text("four-checking-line")).toBe("3 to match");
    cleanup();
    setup({ reviewCount: 1 });
    expect(text("four-checking-line")).toBe("1 to match");
  });
  it("no balance: a dash and the old tile's words, never $0", () => {
    setup({ bank: noBank, reviewCount: 3 });
    expect(text("four-checking-value")).toBe("—");
    expect(text("four-checking-line")).toBe("No bank balance yet.");
    expect(href("four-checking")).toBe("/banking");
  });
});

describe("Lowest", () => {
  it("the forecast's low point and its day", () => {
    setup();
    expect(text("four-lowest-value")).toBe("$600.00");
    expect(text("four-lowest-line")).toBe("Mon Nov 16");
    expect(screen.getByTestId("four-lowest-value").className).not.toContain("text-bad-ink");
  });
  it("under the buffer but above zero is not an alarm", () => {
    setup({ forecast: { lowPoint: "40.00", lowPointDate: "2026-11-16", runwayDays: null, cashBuffer: "500.00", status: "not_yet" } });
    expect(text("four-lowest-line")).toBe("Mon Nov 16");
    expect(screen.getByTestId("four-lowest-value").className).not.toContain("text-bad-ink");
  });
  it("below zero: the number takes the rust, the line says so, and the link opens that day", () => {
    setup({ forecast: { lowPoint: "-40.00", lowPointDate: "2026-11-16", runwayDays: 6, cashBuffer: "500.00", status: "not_yet" } });
    expect(text("four-lowest-value")).toBe("-$40.00");
    expect(screen.getByTestId("four-lowest-value").className).toContain("text-bad-ink");
    expect(text("four-lowest-line")).toBe("Below zero · Mon Nov 16");
    expect(href("four-lowest")).toBe("/forecast?horizon=90&day=2026-11-16");
  });
  it("no projection: a dash and the old tile's words", () => {
    setup({ bank: noBank, forecast: { lowPoint: null, lowPointDate: null, runwayDays: null, cashBuffer: "500.00", status: "no_data" } });
    expect(text("four-lowest-value")).toBe("—");
    expect(text("four-lowest-line")).toBe("No bank balance yet, so no forecast");
  });
});

const overPosition = { ...position, knownWeek: "530.61", remainingWeekKnown: "-180.61", remainingWeek: "-180.61", withinPlan: "over" };
const fill = (id: string) => screen.getByTestId(id).querySelector(".bar-sweep") as HTMLElement;

describe("Spent this week", () => {
  it("under the plan: what is left (the spine's own remaining figure), and a navy bar of spent against the plan", () => {
    h.Q.cash = ok({ hookReserves: [{ hook: "weekly", occurrenceDate: "2026-11-14", basis: "stored_amount", storedAmount: "150.00", amount: "150.00" }] });
    setup();
    expect(text("four-spent-value")).toBe("$40.00");
    expect(text("four-spent-line")).toBe("$160 left of the $200 planned for this week"); // the last words are for a screen reader only
    expect(screen.getByTestId("four-spent-line").querySelector(".sr-only")!.textContent).toBe(" of the $200 planned for this week");
    expect(screen.getByTestId("four-spent-line").parentElement!.className).not.toContain("text-bad-ink");
    // $40 of $200 is a fifth of the track.
    expect(fill("four-spent-bar").style.width).toBe("20%");
    expect(fill("four-spent-bar").className).toContain("bg-brand-navy");
    expect(fill("four-spent-bar").className).toContain("grow-x");
    // The bar is a picture of words already in the box.
    expect(screen.getByTestId("four-spent-bar").firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
  it("over the plan: how far over, in the alarm ink, and the bar takes the deep orange with a mark where the plan ran out", () => {
    setup({ position: overPosition });
    expect(text("four-spent-value")).toBe("$530.61");
    expect(screen.getByTestId("four-spent-line").firstChild!.textContent).toBe("$180.61 over");
    expect(screen.getByTestId("four-spent-line").parentElement!.className).toContain("text-bad-ink");
    const bar = screen.getByTestId("four-spent-bar").firstElementChild as HTMLElement;
    expect(bar.getAttribute("data-over")).toBe("true");
    expect(fill("four-spent-bar").style.width).toBe("100%");
    expect(fill("four-spent-bar").className).toContain("bg-brand-orange-deep");
    // The plan ($350) sits at 350 / 530.61 of the track.
    expect(parseFloat((bar.lastElementChild as HTMLElement).style.left)).toBeCloseTo((350 / 530.61) * 100, 3);
  });
  it("exactly on the plan: '$0 left', a full navy bar, no alarm", () => {
    setup({ position: { ...position, knownWeek: "200.00", remainingWeekKnown: "0.00" } });
    expect(screen.getByTestId("four-spent-line").firstChild!.textContent).toBe("$0 left");
    expect(screen.getByTestId("four-spent-line").parentElement!.className).not.toContain("text-bad-ink");
    expect(fill("four-spent-bar").style.width).toBe("100%");
    expect(fill("four-spent-bar").className).toContain("bg-brand-navy");
  });
  it("cents stay when the figure has them", () => {
    setup({ position: { ...position, knownWeek: "40.25", remainingWeekKnown: "159.75" } });
    expect(screen.getByTestId("four-spent-line").firstChild!.textContent).toBe("$159.75 left");
  });
  it("no plan: left or over against the forecast's own weekly amount (the first weekly occurrence), with a bar", () => {
    h.Q.pos = ok({ weekCap: null });
    h.Q.cash = ok({ hookReserves: [
      { hook: "weekly", occurrenceDate: "2026-11-21", basis: "stored_amount", storedAmount: "175.00", amount: "175.00" },
      { hook: "weekly", occurrenceDate: "2026-11-14", basis: "stored_amount", storedAmount: "150.00", amount: "150.00" },
      { hook: "monthly", occurrenceDate: "2026-11-12", basis: "stored_amount", storedAmount: "900.00", amount: "900.00" },
    ] });
    setup({ position: { ...position, remainingWeekKnown: null, remainingWeek: null, withinPlan: null } });
    expect(text("four-spent-value")).toBe("$40.00");
    expect(screen.getByTestId("four-spent-line").firstChild!.textContent).toBe("$110 left");
    expect(screen.getByTestId("four-spent-line").querySelector(".sr-only")!.textContent).toBe(" of the $150 the forecast sets aside for this week");
    expect(screen.getByTestId("four-spent-bar")).not.toBeNull();
    cleanup();
    setup({ position: { ...position, knownWeek: "626.66", remainingWeekKnown: null, remainingWeek: null, withinPlan: null } });
    expect(screen.getByTestId("four-spent-line").firstChild!.textContent).toBe("$476.66 over");
    expect(screen.getByTestId("four-spent-line").parentElement!.className).toContain("text-bad-ink");
  });
  it("no amount known (no plan, a forecast that holds a plan of $0, or nothing at all): no line and no bar", () => {
    const noPlan = { position: { ...position, remainingWeekKnown: null, remainingWeek: null, withinPlan: null } };
    h.Q.pos = ok({ weekCap: null });
    h.Q.cash = ok({ hookReserves: [{ hook: "weekly", occurrenceDate: "2026-11-14", basis: "plan", amount: "0.00" }] });
    setup(noPlan);
    expect(screen.queryByTestId("four-spent-line")).toBeNull();
    expect(screen.queryByTestId("four-spent-bar")).toBeNull();
    cleanup();
    h.Q.cash = ok({});
    setup(noPlan);
    expect(screen.queryByTestId("four-spent-line")).toBeNull();
    expect(screen.queryByTestId("four-spent-bar")).toBeNull();
  });
  it("the number, its line and its bar never wait on the plan or the forecast requests", () => {
    h.Q = {};
    setup();
    expect(text("four-spent-value")).toBe("$40.00");
    expect(text("four-spent-line")).toBe("$160 left");
    expect(fill("four-spent-bar").style.width).toBe("20%");
  });
  it("a refresh that changes nothing keeps the same bar element: the sweep does not replay", () => {
    const mem = memoryLocation({ path: "/home", record: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    h.spine.data = spine();
    const ui = () => <QueryClientProvider client={qc}><Router hook={mem.hook}><FourNumbers /></Router></QueryClientProvider>;
    const { rerender } = render(ui());
    const before = [fill("four-spent-bar"), fill("four-debt-bar")];
    // A background refetch hands the page a new object with the same figures.
    h.spine.data = spine();
    rerender(ui());
    expect([fill("four-spent-bar"), fill("four-debt-bar")]).toEqual(before);
    expect(fill("four-spent-bar")).toBe(before[0]);
    expect(fill("four-debt-bar")).toBe(before[1]);
  });
});

describe("Debt paid", () => {
  it("the percent paid and what came off this month", () => {
    setup();
    expect(text("four-debt-value")).toBe("25%");
    expect(text("four-debt-line")).toBe("$300 this month");
  });
  it("a thin bar of the percent paid, out of 100", () => {
    setup();
    expect(fill("four-debt-bar").style.width).toBe("25.4%");
    expect(fill("four-debt-bar").className).toContain("bg-brand-navy");
  });
  it("no starting balance: a dash and the old tile's words", () => {
    setup({ debt: { payoffPct: null, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 } });
    expect(text("four-debt-value")).toBe("—");
    expect(text("four-debt-line")).toBe("No debt has a starting balance yet.");
    expect(screen.queryByTestId("four-debt-bar")).toBeNull();
  });
});
