import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";
import type { AvalancheSettings, AvalancheWeeklyPlan, AvalancheWeeklyWeek } from "@workspace/api-client-react";

// ⭐ (AVAL-W) The Debt page's "Avalanche payments" panel: the Weekly / Monthly
// switch (owner only), "This Friday: $X → card", the next 12 payments with
// their PAID OFF / "goes up $N a week" markers, and the debt-free date. Every
// figure is the server's plan; the panel only picks and formats.

const h = vi.hoisted(() => ({
  owner: true as boolean | "unknown",
  plan: undefined as AvalancheWeeklyPlan | undefined,
  enabled: [] as boolean[],
}));
vi.mock("@/hooks/useOwner", () => ({ useOwner: () => h.owner }));
vi.mock("@workspace/api-client-react/features", () => ({
  useGetAvalancheWeekly: (opts?: { query?: { enabled?: boolean } }) => {
    h.enabled.push(opts?.query?.enabled ?? true);
    return { data: opts?.query?.enabled === false ? undefined : h.plan, isLoading: false, isError: false };
  },
}));

import { AvalancheWeeklyPanel, weekCardLabel } from "./avalanche-weekly-panel";

const CARD_A = { debtId: "a", name: "Card A" };
const CARD_B = { debtId: "b", name: "Card B" };

function week(over: Partial<AvalancheWeeklyWeek> & { date: string; paid: number }): AvalancheWeeklyWeek {
  return {
    planned: 600,
    room: over.paid,
    due: over.paid,
    basis: "curve",
    answered: false,
    nextTarget: CARD_A,
    targets: over.paid > 0 ? [{ ...CARD_A, amount: over.paid, paidOff: false }] : [],
    paidOff: [],
    ...over,
  };
}

// Fridays in 2030, so none is "today".
const WEEKS: AvalancheWeeklyWeek[] = [
  week({ date: "2030-01-04", paid: 350 }),
  week({ date: "2030-01-11", paid: 0 }),
  week({
    date: "2030-01-18",
    paid: 1500,
    targets: [
      { ...CARD_A, amount: 600, paidOff: true },
      { ...CARD_B, amount: 900, paidOff: false },
    ],
    paidOff: [{ ...CARD_A, date: "2030-01-18", freedWeekly: 23.08 }],
  }),
  ...Array.from({ length: 14 }, (_, i) =>
    week({ date: `2030-0${2 + Math.floor(i / 4)}-0${1 + (i % 4)}`, paid: 100 + i, nextTarget: CARD_B, targets: [{ ...CARD_B, amount: 100 + i, paidOff: false }] }),
  ),
];
const PLAN: AvalancheWeeklyPlan = {
  cadence: "weekly",
  weekday: 5,
  monthlyTarget: 2600,
  targetWeekly: 600,
  cashBuffer: 500,
  weeks: WEEKS,
  payoffs: [{ ...CARD_A, date: "2030-01-18", freedWeekly: 23.08 }],
  debtFreeDate: "2031-10-29",
  curveThrough: "2030-12-06",
  ranOutOfTime: false,
};

const settings = (over: Partial<AvalancheSettings> = {}): AvalancheSettings => ({
  strategy: "avalanche",
  extraSource: "manual",
  extraBudgetCategoryId: null,
  manualExtra: "2600.00",
  budgetMode: "budgeted",
  extraCadence: "weekly",
  extraWeekday: 5,
  ...over,
});

beforeEach(() => {
  h.owner = true;
  h.plan = PLAN;
  h.enabled = [];
});
afterEach(cleanup);

describe("AvalancheWeeklyPanel — weekly", () => {
  it("leads with this Friday's payment and the card it goes to, beside the monthly target and the debt-free date", () => {
    render(<AvalancheWeeklyPanel settings={settings()} onUpdate={vi.fn()} />);
    const head = screen.getByTestId("avalanche-this-week");
    expect(head.textContent).toContain("This Friday");
    expect(head.textContent).toContain("$350.00");
    expect(head.textContent).toContain("→ Card A");
    expect(screen.getByTestId("avalanche-target-line").textContent).toBe(
      "Target $2,600.00/mo · this Friday $350.00 · debt-free Oct 29, 2031",
    );
  });

  it("lists the next 12 payments that pay something, with PAID OFF and how much the week goes up", () => {
    render(<AvalancheWeeklyPanel settings={settings()} onUpdate={vi.fn()} />);
    const list = screen.getByTestId("avalanche-weekly-list");
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(12);
    // The $0 week is left out.
    expect(screen.queryByTestId("avalanche-week-2030-01-11")).toBeNull();
    const paidOff = screen.getByTestId("avalanche-week-2030-01-18");
    expect(paidOff.textContent).toContain("$1,500.00");
    expect(paidOff.textContent).toContain("Card A + Card B");
    expect(paidOff.textContent).toContain("PAID OFF");
    expect(paidOff.textContent).toContain("goes up $23.08 a week");
    expect(screen.getByTestId("avalanche-week-2030-01-04").textContent).not.toContain("PAID OFF");
  });

  it("a week with nothing safe to pay says so instead of naming a card", () => {
    h.plan = { ...PLAN, weeks: [week({ date: "2030-01-04", paid: 0 }), ...WEEKS.slice(1)] };
    render(<AvalancheWeeklyPanel settings={settings()} onUpdate={vi.fn()} />);
    expect(screen.getByTestId("avalanche-this-week").textContent).toContain("nothing is safe to pay this week");
  });

  it("the owner switches back to monthly and picks the day; the panel writes only the setting", () => {
    const onUpdate = vi.fn();
    render(<AvalancheWeeklyPanel settings={settings()} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", { name: /Monthly/ }));
    expect(onUpdate).toHaveBeenCalledWith({ extraCadence: "monthly" });
    expect(screen.getByLabelText("Payment day")).toBeTruthy();
  });

  it("a member sees how it is paid, without the switch", () => {
    h.owner = false;
    render(<AvalancheWeeklyPanel settings={settings()} onUpdate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Monthly/ })).toBeNull();
    expect(screen.queryByLabelText("Payment day")).toBeNull();
    expect(screen.getByTestId("avalanche-cadence-member").textContent).toBe("Paid weekly, on Fridays. The owner sets this.");
  });
});

describe("AvalancheWeeklyPanel — monthly", () => {
  it("says the month-end amount, does not ask for the weekly plan, and the owner can turn Weekly on", () => {
    const onUpdate = vi.fn();
    render(<AvalancheWeeklyPanel settings={settings({ extraCadence: "monthly" })} onUpdate={onUpdate} />);
    expect(h.enabled.every((e) => e === false)).toBe(true);
    expect(screen.getByTestId("avalanche-monthly-line").textContent).toContain("Paying $2,600.00 at the end of each month");
    expect(screen.queryByTestId("avalanche-weekly-list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Weekly/ }));
    expect(onUpdate).toHaveBeenCalledWith({ extraCadence: "weekly" });
  });
});

describe("weekCardLabel", () => {
  it("names the debts a week pays, else the one next in line", () => {
    expect(weekCardLabel({ targets: [{ ...CARD_A, amount: 1, paidOff: true }, { ...CARD_B, amount: 2, paidOff: false }], nextTarget: CARD_A })).toBe(
      "Card A + Card B",
    );
    expect(weekCardLabel({ targets: [], nextTarget: CARD_B })).toBe("Card B");
    expect(weekCardLabel({ targets: [], nextTarget: null })).toBe("—");
  });
});
