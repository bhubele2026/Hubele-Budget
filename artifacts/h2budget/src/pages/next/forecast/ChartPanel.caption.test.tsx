import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ⭐ (C2) The chart's first point is ONE moment in words: the day the window opens, the balance at the START of
 * that day (`cashSignal.opening.balance`), the first plotted point (`daily[0]` = that day's CLOSE) and the reading
 * + rows it rolls from. Synthetic figures.
 */
vi.mock("../../forecast/ProjectedBalanceChart", () => ({
  ProjectedBalanceChart: (p: { startLabel?: string | string[] | null; openingBalance?: number | null }) => (
    <div data-testid="chart-stub" data-opening={String(p.openingBalance)}>
      {(Array.isArray(p.startLabel) ? p.startLabel : p.startLabel ? [p.startLabel] : []).map((l, i) => (
        <span key={i} data-testid={`start-line-${i}`}>{l}</span>
      ))}
    </div>
  ),
}));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/lib/householdDay", () => ({ householdToday: () => "2026-10-16" }));

import { ChartPanel } from "./ChartPanel";

afterEach(cleanup);

const READING = { balance: "0.00", at: "2026-10-15T21:19:00.000Z", source: "plaid" as const };

function ctx(over: { opening?: unknown; closeFirst?: number; bankBalance?: string | null }) {
  return {
    proj: {
      status: "ready",
      opening: "opening" in over ? over.opening : { date: "2026-10-16", balance: "0.00", reading: READING, since: { net: "3374.60", count: 2, through: "2026-10-16" } },
    },
    dailySeries: [{ date: "Oct 16", rawDate: "2026-10-16", balance: over.closeFirst ?? 3374.6 }],
    bankBalance: "bankBalance" in over ? over.bankBalance : "3374.60",
    bankAccountName: "Everyday Checking",
    bankAccountMask: "0001",
    horizonDays: 90,
    cashProjectionLoading: false,
    cashBufferNum: 500,
    lowestPoint: null,
    bigBillMarkers: [],
    eventsByDate: new Map(),
    partialPlanKeys: new Set(),
    hasCheckingLink: true,
    jumpToPlan: () => {},
    onMarkMissed: () => {},
  } as never;
}

function show(c: ReturnType<typeof ctx>) {
  render(<ChartPanel ctx={c} kinded={[]} markers={[]} incomeByDate={new Map()} selectedDate={null} onSelectDate={() => {}} />);
}

describe("ChartPanel start caption", () => {
  it("rows dated the opening day: opens at the bare reading, closes at Checking today, '+2 rows today'", () => {
    show(ctx({}));
    expect(screen.getByTestId("start-line-0").textContent).toBe("Oct 16 · opens $0.00 · closes $3,374.60");
    expect(screen.getByTestId("start-line-1").textContent).toBe("Bank read $0.00 Oct 15, 4:19 PM · +2 rows today");
    expect(screen.getByTestId("chart-stub").getAttribute("data-opening")).toBe("0");
  });

  it("rows all dated before the opening day: opening = Checking today, '+2 rows since'", () => {
    show(ctx({
      opening: { date: "2026-10-16", balance: "3374.60", reading: READING, since: { net: "3374.60", count: 2, through: "2026-10-16" } },
      closeFirst: 3300,
    }));
    expect(screen.getByTestId("start-line-0").textContent).toBe("Oct 16 · opens $3,374.60 · closes $3,300.00");
    expect(screen.getByTestId("start-line-1").textContent).toBe("Bank read $0.00 Oct 15, 4:19 PM · +2 rows since");
  });

  it("the caption's figures are opening.balance and daily[0].balance, to the cent", () => {
    show(ctx({ opening: { date: "2026-10-16", balance: "12.30", reading: { ...READING, balance: "12.30" }, since: { net: "0.00", count: 0, through: "2026-10-16" } }, closeFirst: 98.76, bankBalance: "12.30" }));
    expect(screen.getByTestId("start-line-0").textContent).toBe("Oct 16 · opens $12.30 · closes $98.76");
    expect(screen.getByTestId("start-line-1").textContent).toBe("Bank read $12.30 Oct 15, 4:19 PM · no rows since");
  });

  it("no reading: dashes and 'No bank reading yet', never $0.00", () => {
    show(ctx({ opening: { date: "2026-10-16", balance: "0.00", reading: null, since: null }, bankBalance: null }));
    expect(screen.getByTestId("start-line-0").textContent).toBe("Oct 16 · opens — · closes —");
    expect(screen.getByTestId("start-line-1").textContent).toBe("No bank reading yet");
    expect(screen.getByTestId("chart-stub").getAttribute("data-opening")).toBe("null");
  });

  it("an older answer without `opening` draws no caption (and invents none)", () => {
    show(ctx({ opening: undefined }));
    expect(screen.queryByTestId("start-line-0")).toBeNull();
  });

  it("has one Details button", () => {
    show(ctx({}));
    expect(screen.getAllByText("Details")).toHaveLength(1);
  });
});
