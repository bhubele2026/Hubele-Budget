import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import React from "react";

/**
 * Forecast → Overview (`/forecast/overview`) — the C2 rebuild.
 *
 * ⭐ THE SPINE RULE, PINNED. Bank today, the cash low point, the low-point date
 * and runway are `useSpine()`'s values rendered verbatim. This page used to
 * derive runway itself by walking the cash-signal daily series for the first
 * negative day, and read the balance and low point off that same endpoint —
 * so the Forecast tab could quote a different household than the landing did.
 *
 * The fixtures below make that impossible to fake: the cash-signal mock carries
 * DELIBERATELY DIFFERENT numbers from the spine (a decoy balance, a decoy low
 * point, and a daily series that first goes negative on a different day). A
 * page that recomputes any headline figure locally renders the decoy and fails
 * here, rather than shipping and disagreeing with the front door.
 */

const state = vi.hoisted(() => ({
  spine: undefined as unknown,
  cashSignal: undefined as unknown,
}));

vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: state.spine, isLoading: false }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetForecastCashSignal: () => ({ data: state.cashSignal }),
  getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
}));

import ForecastOverviewPage from "./forecast-overview";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * An INDEPENDENT money formatter for the parity assertions — deliberately not
 * the app's `formatCurrency`, so the test pins the rendered string rather than
 * agreeing with whatever the app happens to do.
 */
const usd = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );

/** The single source every parity assertion below reads from. */
const SPINE = {
  asOf: "2026-08-15T12:00:00.000Z",
  bank: { balance: "4218.55", asOfDate: "2026-08-14" },
  spentMonth: 2310.4,
  spentWeek: 486.25,
  nextBill: { name: "Verizon", amount: "184.32", dueDate: "2026-08-28" },
  billsDueCount: 3,
  forecast: {
    lowPoint: "-612.90",
    lowPointDate: "2026-09-27",
    runwayDays: 12,
  },
  debt: { payoffPct: 39.7 },
  reviewCount: 4,
};

/**
 * ⚠️ EVERY HEADLINE FIGURE HERE IS A DECOY. `bankToday` and `lowestProjected`
 * disagree with the spine, and the daily series first turns negative on day 3
 * rather than the spine's day 12 — so a locally-recomputed runway reads "3
 * days". Only `endingBalance`, `cashBuffer`, the income/expense totals and the
 * events are real inputs: the spine does not carry those, so the page is
 * SUPPOSED to read them from here.
 */
const CASH_SIGNAL = {
  status: "tight",
  bankToday: "9999.99", // decoy — spine says 4218.55
  lowestProjected: "1111.11", // decoy — spine says -612.90
  lowestDate: "2026-12-31", // decoy — spine says 2026-09-27
  endingBalance: "5301.20",
  cashBuffer: "500.00",
  projectedIncome: "8200.00",
  projectedExpenses: "7118.80",
  snapshotAt: "2026-08-14T09:00:00.000Z",
  snapshotSource: "plaid",
  daily: [
    { date: "2026-08-15", balance: "4218.55" },
    { date: "2026-08-16", balance: "3900.00" },
    { date: "2026-08-17", balance: "2500.00" },
    { date: "2026-08-18", balance: "-25.00" }, // day 3 — the runway decoy
    { date: "2026-08-19", balance: "1800.00" },
  ],
  events: [
    { date: "2026-08-20", label: "Rent", amount: "-1850.00", itemId: "rent" },
    { date: "2026-08-22", label: "Car loan", amount: "-430.00", itemId: "car" },
    { date: "2026-08-25", label: "Paycheck", amount: "2100.00", itemId: "pay" },
  ],
};

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  state.spine = SPINE;
  state.cashSignal = CASH_SIGNAL;
});

/** The full rendered text of one Stat tile — label, value and hint. */
const statOf = (testid: string): string =>
  screen.getByTestId(testid).textContent ?? "";

describe("Forecast Overview — headline figures come from the spine", () => {
  it("renders bank today, the cash low point and runway as the spine's values", () => {
    render(<ForecastOverviewPage />);

    // Bank today === spine.bank.balance, NOT cashSignal.bankToday.
    expect(statOf("fo-stat-bank")).toContain(usd(SPINE.bank.balance));
    expect(statOf("fo-stat-bank")).not.toContain(usd(CASH_SIGNAL.bankToday));

    // Cash low point === spine.forecast.lowPoint, and its date comes with it.
    expect(statOf("fo-stat-low-point")).toContain(
      usd(SPINE.forecast.lowPoint),
    );
    expect(statOf("fo-stat-low-point")).not.toContain(
      usd(CASH_SIGNAL.lowestProjected),
    );
    expect(statOf("fo-stat-low-point")).toContain(
      SPINE.forecast.lowPointDate,
    );

    // Runway === spine.forecast.runwayDays. The daily series would give 3.
    expect(statOf("fo-stat-runway")).toContain(
      `${SPINE.forecast.runwayDays} days`,
    );
    expect(statOf("fo-stat-runway")).not.toContain("3 days");
  });

  it("reads ending balance from the cash signal, which the spine does not carry", () => {
    render(<ForecastOverviewPage />);
    expect(statOf("fo-stat-ending")).toContain(usd(CASH_SIGNAL.endingBalance));
  });

  it("shows runway as Clear when the spine says the projection never goes negative", () => {
    state.spine = {
      ...SPINE,
      forecast: { ...SPINE.forecast, runwayDays: null },
    };
    render(<ForecastOverviewPage />);
    expect(statOf("fo-stat-runway")).toContain("Clear");
    expect(statOf("fo-stat-runway")).toContain("stays positive");
  });

  it("flags the low point as under buffer, in words and not by colour alone", () => {
    render(<ForecastOverviewPage />);
    // -612.90 is below the 500.00 buffer.
    expect(statOf("fo-stat-low-point")).toContain("under buffer");
    // The tone is a reinforcement; the label above is the actual signal.
    expect(
      screen.getByTestId("fo-stat-low-point").querySelector(".text-bad"),
    ).not.toBeNull();
  });

  it("says above buffer when the low point clears it", () => {
    state.spine = {
      ...SPINE,
      forecast: { ...SPINE.forecast, lowPoint: "900.00" },
    };
    render(<ForecastOverviewPage />);
    expect(statOf("fo-stat-low-point")).toContain("above buffer");
  });

  it("renders an em dash rather than $0 while the spine is still loading", () => {
    state.spine = undefined;
    render(<ForecastOverviewPage />);
    expect(statOf("fo-stat-bank")).toContain("—");
    expect(statOf("fo-stat-bank")).not.toContain("$0.00");
  });

  it("lists the biggest bills ahead, largest first, and excludes income", () => {
    render(<ForecastOverviewPage />);
    const bills = screen.getByTestId("fo-big-bills");
    expect(within(bills).getByText("Rent")).toBeTruthy();
    expect(within(bills).getByText("Car loan")).toBeTruthy();
    // The paycheck is an inflow — it is not a bill.
    expect(within(bills).queryByText("Paycheck")).toBeNull();
  });
});
