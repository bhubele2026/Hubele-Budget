import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⭐ (Readable forecast) `/forecast` leads with one answer line and folds the old headline into "Details".
 * The owner's rule: a redesign changes how a figure is SHOWN, never what it is. So one fixture is rendered in
 * both layouts and every figure string is compared byte for byte: Checking today, the lowest point and its
 * day, the ending balance and its day, money in / out and the cash buffer. Invented household, invented names.
 */
const chartProps: Array<Record<string, unknown>> = [];
vi.mock("./ProjectedBalanceChart", () => ({
  ProjectedBalanceChart: (p: Record<string, unknown>) => {
    chartProps.push(p);
    return <div data-testid="chart-stub" data-calm={String(p.calm)} data-show-bills={String(p.showBills)} />;
  },
}));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/lib/householdDay", () => ({ householdToday: () => "2026-11-10" }));
vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children?: React.ReactNode; href?: string; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { ForecastBody } from "./ForecastBody";
import { SHOW_BILLS_KEY } from "../next/forecast/ChartPanel";

const DAYS = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-17", "2026-12-01", "2027-02-08"];
const BAL = [2475.9, 2341.9, 2290.9, 4120.9, 3500.9, 542.9, 1676.9];

function signal(over: Record<string, unknown> = {}) {
  return {
    status: "tight",
    bankToday: "2475.90",
    startingBalance: "2482.40",
    lowestProjected: "542.90",
    lowestDate: "2026-12-01",
    cashBuffer: "500.00",
    endingBalance: "1676.90",
    endingDate: "2027-02-08",
    projectedIncome: "28430.00",
    projectedExpenses: "29235.50",
    acceptedImpact: "0.00",
    fromDate: "2026-11-10",
    toDate: "2027-02-08",
    horizonDays: 90,
    maxSafeExtra: "0.00",
    account: { rowId: "r1", externalId: "e1", name: "Everyday Checking", mask: "4821", subtype: "checking", via: "pointer" },
    daily: DAYS.map((date, i) => ({ date, balance: BAL[i].toFixed(2) })),
    events: [],
    dayItems: [
      { date: "2026-11-10", kind: "bank_row", amount: "-6.50", txnId: "t-coffee" },
      { date: "2026-11-11", kind: "expense", amount: "-64.00", label: "Water & Sewer", itemId: "water", originalDate: "2026-11-01" },
      { date: "2026-11-11", kind: "expense", amount: "-70.00", label: "Internet · Ridgeway Fiber", itemId: "net" },
      { date: "2026-11-12", kind: "expense", amount: "-51.00", label: "Phone · Brightline", itemId: "phone" },
      { date: "2026-11-13", kind: "income", amount: "2450.00", label: "Paycheck · Jordan", itemId: "pay-j" },
      { date: "2026-11-13", kind: "expense", amount: "-620.00", label: "Avalanche payment → Maple Rewards Card", itemId: "avalanche:extra" },
      { date: "2026-11-17", kind: "expense", amount: "-620.00", label: "Groceries reserve", itemId: "groc" },
      { date: "2026-12-01", kind: "expense", amount: "-2450.00", label: "Rent · Elm Street", itemId: "rent" },
    ],
    ...over,
  };
}

function ctx(proj: ReturnType<typeof signal>) {
  return {
    mode: "overall",
    horizonDays: 90,
    horizonControls: <div />,
    draggingCard: null,
    bankGrid: null,
    registerBlock: null,
    monthBlock: null,
    proj,
    projReady: proj.status !== "no_data",
    dailySeries: proj.daily.map((d) => ({ date: d.date.slice(5), rawDate: d.date, balance: Number(d.balance) })),
    cashBufferNum: Number(proj.cashBuffer),
    lowestPoint: { x: proj.lowestDate, y: Number(proj.lowestProjected), rawDate: proj.lowestDate },
    bigBillMarkers: [],
    eventsByDate: new Map(),
    partialPlanKeys: new Set(),
    jumpToPlan: () => {},
    onMarkMissed: () => {},
    onSkipDraggingPlan: () => {},
    openSettings: () => {},
    cashProjectionLoading: false,
    bankBalance: proj.bankToday,
    bankReadAt: null,
    bankReading: { balance: "2482.40", at: "2026-11-10T03:05:00.000Z", source: "plaid" },
    bankSince: { net: "-6.50", count: 1 },
    bankOlder: null,
    hasCheckingLink: true,
    bankAccountName: "Everyday Checking",
    bankAccountMask: "4821",
    debtLinks: new Map(),
    bankLabel: (id: string) => (id === "t-coffee" ? "COFFEE CORNER" : null),
    listCounts: { unpaid: 1, incomeNotArrived: 0, olderUnpaid: 0 },
    inboxCount: 0,
    fromDate: "2026-11-10",
    lookbackOpen: false,
    highlightedPlanKey: null,
    reconciledNow: false,
    dateBalance: <section data-testid="forecast-date-balance">date balance</section>,
  } as never;
}

function show(readable: boolean, proj = signal(), setSelectedDate: (d: string | null) => void = () => {}, selectedDate: string | null = null) {
  return render(
    <ForecastBody ctx={ctx(proj)} tab="plan" selectedDate={selectedDate} setSelectedDate={setSelectedDate} title="Forecast" readable={readable} />,
  );
}

const text = (id: string) => screen.getByTestId(id).textContent ?? "";
/** A StatBlock's figure: its second line. */
const stat = (id: string) => screen.getByTestId(id).children[1]!.textContent ?? "";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* jsdom always has it */
  }
});
afterEach(() => {
  cleanup();
  chartProps.length = 0;
});

describe("Readable forecast — the figures are the old figures, byte for byte", () => {
  it("answer line + Details carry the very strings the old headline and strip showed", () => {
    show(false);
    const old = {
      checking: text("kpi-bank-today-figure"),
      lowest: stat("kpi-lowest-point"),
      lowestLink: text("kpi-lowest-see-day"),
      ending: stat("kpi-ending-balance"),
      hero: text("hero-forecast-balance"),
      heroDate: text("hero-ending-date"),
      moneyIn: stat("kpi-projected-income"),
      moneyOut: stat("kpi-projected-expenses"),
      buffer: stat("kpi-cash-buffer"),
      strip: text("forecast-kpis"),
      heroCard: text("card-forecast-hero"),
    };
    // The fixture's own words, so a formatting change anywhere shows up here.
    expect(old).toMatchObject({
      checking: "$2,475.90", lowest: "$542.90", lowestLink: "See Dec 1", ending: "$1,676.90", hero: "$1,676.90",
      heroDate: "End of Feb 8", moneyIn: "$28,430.00", moneyOut: "$29,235.50", buffer: "$500.00",
    });
    cleanup();

    show(true);
    // The answer line.
    expect(text("answer-checking-figure")).toBe(old.checking);
    expect(text("answer-lowest-figure")).toBe(old.lowest);
    expect(text("answer-lowest-date")).toBe(`on ${old.lowestLink.replace(/^See /, "")}`);
    expect(text("answer-lowest-see-day")).toBe(old.lowestLink);
    expect(text("answer-ending-figure")).toBe(old.ending);
    expect(text("answer-ending-figure")).toBe(old.hero);
    expect(text("answer-ending-date")).toBe(old.heroDate.replace(/^End of /, "on "));
    // Details: the old headline and strip, folded, every string unchanged.
    const details = screen.getByTestId("forecast-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByTestId("kpi-bank-today-figure").textContent).toBe(old.checking);
    expect(stat("kpi-lowest-point")).toBe(old.lowest);
    expect(stat("kpi-ending-balance")).toBe(old.ending);
    expect(stat("kpi-projected-income")).toBe(old.moneyIn);
    expect(stat("kpi-projected-expenses")).toBe(old.moneyOut);
    expect(stat("kpi-cash-buffer")).toBe(old.buffer);
    expect(text("forecast-kpis")).toBe(old.strip);
    expect(text("card-forecast-hero")).toBe(old.heroCard);
    expect(within(details).getByTestId("hero-adds-up")).toBeTruthy();
    expect(within(details).getByTestId("kpi-lowest-see-day").textContent).toBe(old.lowestLink);
  });

  it("the next payday is the first planned income from today, at its own amount", () => {
    show(true);
    expect(text("answer-payday")).toBe("Next payday" + "Nov 13" + "$2,450.00");
  });

  it("the low point is quiet near the buffer, the warning tone under it, rust below zero — and says so in words", () => {
    show(true);
    expect(screen.getByTestId("answer-lowest-figure").getAttribute("data-tone")).toBe("neutral");
    expect(screen.queryByTestId("answer-lowest-word")).toBeNull();
    cleanup();
    show(true, signal({ status: "not_yet", lowestProjected: "480.00" }));
    expect(screen.getByTestId("answer-lowest-figure").getAttribute("data-tone")).toBe("warn");
    expect(screen.getByTestId("answer-lowest-figure").className).toContain("text-warn");
    expect(text("answer-lowest-word")).toBe("Under the $500 buffer");
    cleanup();
    show(true, signal({ status: "not_yet", lowestProjected: "-120.00" }));
    expect(screen.getByTestId("answer-lowest-figure").getAttribute("data-tone")).toBe("bad");
    expect(text("answer-lowest-word")).toBe("Below zero on Dec 1");
    expect(text("answer-lowest-see-day")).toBe("Review shortfall");
  });

  it("no projection: dashes, never $0.00", () => {
    show(true, signal({ status: "no_data", bankToday: null }));
    expect(text("answer-checking-figure")).toBe("—");
    expect(text("answer-lowest-figure")).toBe("—");
    expect(text("answer-ending-figure")).toBe("—");
    expect(text("answer-payday-figure")).toBe("—");
  });

  it("the old layout (/review, /next/forecast) is unchanged: no answer line, no Next 14 days, the full chart", () => {
    show(false);
    expect(screen.queryByTestId("forecast-answer")).toBeNull();
    expect(screen.queryByTestId("next-days-panel")).toBeNull();
    expect(screen.queryByTestId("forecast-details")).toBeNull();
    expect(screen.getByTestId("chart-stub").getAttribute("data-calm")).toBe("false");
    expect(screen.queryByTestId("chart-show-bills")).toBeNull();
  });
});

describe("Readable forecast — Next 14 days", () => {
  it("one row per day with money moving, plus today: in, out (avalanche shortened), balance after; the lowest flagged", () => {
    show(true);
    const list = screen.getByTestId("next-days-list");
    expect([...list.querySelectorAll("[data-testid^='next-day-2']")].map((b) => b.getAttribute("data-testid"))).toEqual([
      "next-day-2026-11-10",
      "next-day-2026-11-11",
      "next-day-2026-11-12",
      "next-day-2026-11-13",
      "next-day-2026-11-17",
    ]);
    expect(text("next-day-date-2026-11-13")).toBe("Fri, Nov 13");
    expect(text("next-day-in-2026-11-13")).toBe("In$2,450.00Paycheck · Jordan");
    expect(text("next-day-out-2026-11-13")).toBe("Out$620.00Avalanche → Maple Rewards Card");
    expect(text("next-day-balance-2026-11-13")).toBe("$4,120.90");
    // Today: the counted bank row; the balance is the curve's own close.
    expect(text("next-day-out-2026-11-10")).toBe("Out$6.50COFFEE CORNER");
    expect(text("next-day-balance-2026-11-10")).toBe("$2,475.90");
    // Largest first.
    expect(text("next-day-out-2026-11-11")).toBe("Out$134.00Internet · Ridgeway Fiber, Water & Sewer");
    // The lowest row of the window is flagged (here: Nov 12).
    expect(screen.getByTestId("next-day-2026-11-12").getAttribute("data-lowest")).toBe("true");
    expect(screen.getAllByTestId("next-day-lowest")).toHaveLength(1);
  });

  it("'Show 30 days' widens the window to the low point, flagged and under-buffer words included", () => {
    show(true, signal({ lowestProjected: "480.00", status: "not_yet", daily: DAYS.map((date, i) => ({ date, balance: (date === "2026-12-01" ? 480 : BAL[i]).toFixed(2) })) }));
    expect(screen.queryByTestId("next-day-2026-12-01")).toBeNull();
    fireEvent.click(screen.getByTestId("next-days-toggle"));
    expect(text("next-days-toggle")).toBe("Show 14 days");
    const low = screen.getByTestId("next-day-2026-12-01");
    expect(low.getAttribute("data-lowest")).toBe("true");
    expect(low.getAttribute("data-under-buffer")).toBe("true");
    expect(low.textContent).toContain("under buffer");
    expect(screen.getByTestId("next-day-balance-2026-12-01").className).toContain("text-warn");
  });

  it("a row selects its day — the same selection the chart and the day panel use", () => {
    const pick = vi.fn();
    show(true, signal(), pick);
    fireEvent.click(screen.getByTestId("next-day-2026-11-13"));
    expect(pick).toHaveBeenCalledWith("2026-11-13");
    cleanup();
    show(true, signal(), pick, "2026-11-13");
    expect(screen.getByTestId("next-day-2026-11-13").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("day-panel-date").textContent).toContain("Nov 13");
  });
});

describe("Readable forecast — the calm chart's 'Show bills'", () => {
  it("starts off, turns the bills on, and is remembered for this viewer", () => {
    const first = show(true);
    expect(screen.getByTestId("chart-stub").getAttribute("data-calm")).toBe("true");
    const toggle = screen.getByTestId("chart-show-bills");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("legend-bill")).toBeNull();
    expect(screen.getByTestId("legend-payday")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByTestId("chart-stub").getAttribute("data-show-bills")).toBe("true");
    expect(screen.getByTestId("legend-bill")).toBeTruthy();
    expect(localStorage.getItem(SHOW_BILLS_KEY)).toBe("1");
    first.unmount();
    show(true);
    expect(screen.getByTestId("chart-show-bills").getAttribute("aria-pressed")).toBe("true");
  });

  it("a blocked storage still lets the toggle work", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    show(true);
    fireEvent.click(screen.getByTestId("chart-show-bills"));
    expect(screen.getByTestId("chart-show-bills").getAttribute("aria-pressed")).toBe("true");
    get.mockRestore();
    set.mockRestore();
  });

  it("the calm tooltip gets each day's in and out, grouped as the day panel groups them", () => {
    show(true);
    const totals = chartProps.at(-1)!.dayTotals as Map<string, { moneyIn: number; moneyOut: number }>;
    expect(totals.get("2026-11-13")).toEqual({ moneyIn: 2450, moneyOut: -620 });
    expect(totals.get("2026-11-10")).toEqual({ moneyIn: 0, moneyOut: -6.5 });
  });
});
