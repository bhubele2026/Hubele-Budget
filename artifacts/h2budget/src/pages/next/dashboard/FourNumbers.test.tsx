import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { memoryLocation } from "wouter/memory-location";

// ⭐ (Home is four numbers, 2026-11-11) Checking · Lowest · Spent this week ·
// Debt paid: one big number each, at most one short line, no status chip, and
// the link of the tile it stands for. Every value below is invented.

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
    expect(Array.from(grid.querySelectorAll("h2"), (e) => e.textContent)).toEqual(["Checking", "Lowest", "Spent this week", "Debt paid"]);
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
    expect(grid.textContent).not.toMatch(/[$%\d]/);
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

describe("Spent this week", () => {
  it("what counts toward the plan, 'of' the weekly plan when one is set", () => {
    h.Q.cash = ok({ hookReserves: [{ hook: "weekly", occurrenceDate: "2026-11-14", basis: "stored_amount", storedAmount: "150.00", amount: "150.00" }] });
    setup();
    expect(text("four-spent-value")).toBe("$40.00");
    expect(text("four-spent-line")).toBe("of $200"); // the plan wins over the forecast's amount
  });
  it("no plan: 'of' the forecast's own weekly amount (the first weekly occurrence)", () => {
    h.Q.pos = ok({ weekCap: null });
    h.Q.cash = ok({ hookReserves: [
      { hook: "weekly", occurrenceDate: "2026-11-21", basis: "stored_amount", storedAmount: "175.00", amount: "175.00" },
      { hook: "weekly", occurrenceDate: "2026-11-14", basis: "stored_amount", storedAmount: "150.00", amount: "150.00" },
      { hook: "monthly", occurrenceDate: "2026-11-12", basis: "stored_amount", storedAmount: "900.00", amount: "900.00" },
    ] });
    setup({ position: { ...position, remainingWeekKnown: null, remainingWeek: null, withinPlan: null } });
    expect(text("four-spent-value")).toBe("$40.00");
    expect(text("four-spent-line")).toBe("of $150");
  });
  it("no amount known (no plan, a forecast that holds a plan of $0, or nothing at all): no line", () => {
    h.Q.pos = ok({ weekCap: null });
    h.Q.cash = ok({ hookReserves: [{ hook: "weekly", occurrenceDate: "2026-11-14", basis: "plan", amount: "0.00" }] });
    setup();
    expect(screen.queryByTestId("four-spent-line")).toBeNull();
    cleanup();
    h.Q.cash = ok({});
    setup();
    expect(screen.queryByTestId("four-spent-line")).toBeNull();
  });
  it("the number never waits on the plan or the forecast", () => {
    h.Q = {};
    setup();
    expect(text("four-spent-value")).toBe("$40.00");
    expect(screen.queryByTestId("four-spent-line")).toBeNull();
  });
});

describe("Debt paid", () => {
  it("the percent paid and what came off this month", () => {
    setup();
    expect(text("four-debt-value")).toBe("25%");
    expect(text("four-debt-line")).toBe("$300 this month");
  });
  it("no starting balance: a dash and the old tile's words", () => {
    setup({ debt: { payoffPct: null, nextMilestone: null, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 } });
    expect(text("four-debt-value")).toBe("—");
    expect(text("four-debt-line")).toBe("No debt has a starting balance yet.");
  });
});
