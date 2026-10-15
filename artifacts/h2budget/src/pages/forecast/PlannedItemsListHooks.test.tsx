import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { PlanLine } from "@/lib/forecastMatch";
import { hookPayoffsOf } from "@/lib/forecastHooks";

// (WP8) The register says what the curve takes for an everyday hook: the card
// payoff beside the stored plan, or the row that paid it. Display only — the
// row's amount stays the stored plan.

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
}));

import { PlannedItemsList, type PlannedItem } from "./PlannedItemsList";

afterEach(cleanup);

const plan = (itemId: string, date: string, label: string, amount: number): PlannedItem => ({
  kind: "plan",
  key: `${itemId}|${date}`,
  row: { kind: "plan", itemId, date, label, amount, status: "future" } as unknown as PlanLine,
});

const SIGNAL = {
  hookAmountIgnored: [{ itemId: "ws", cadence: "weekly" as const, storedAmount: "450.00" }],
  events: [{ date: "2026-10-10", label: "Weekly Spend", amount: "-477.57", itemId: "ws", occurrenceKey: "ws|2026-10-10" }],
  overdueAssumedPaid: [
    {
      planKey: "ws|2026-10-03", itemId: "ws", occurrenceDate: "2026-10-03", dueDate: "2026-10-03", label: "Weekly Spend",
      daysOverdue: 4, planAmount: "-450.00", txnId: "tx-pay", txnAmount: "-120.00", confidence: "card_payment", unpaidRemainder: "0.00",
    },
  ],
};

function show(
  hookPayoffs?: ReturnType<typeof hookPayoffsOf>,
  items: PlannedItem[] = [plan("ws", "2026-10-03", "Weekly Spend", -450), plan("ws", "2026-10-10", "Weekly Spend", -450), plan("mort", "2026-10-12", "Mortgage", -1650)],
) {
  const noop = () => {};
  render(
    <PlannedItemsList
      items={items}
      payoffsByItem={new Map()}
      bestSuggestionPlanKey={null}
      highlightedPlanKey={null}
      activeDragId={null}
      onSelectPlan={noop}
      onMoveStart={noop}
      onMarkMissed={noop}
      hookPayoffs={hookPayoffs}
    />,
  );
}

describe("PlannedItemsList — everyday hook words (WP8)", () => {
  it("a hook row says its card payoff beside the plan, a paid one names the row; the amount stays the stored plan; other rows say nothing", () => {
    show(hookPayoffsOf(SIGNAL as never, (id) => (id === "tx-pay" ? "AMERICAN EXPRESS ACH PMT" : null)));
    expect(screen.getByTestId("plan-hook-ws-2026-10-10").textContent).toBe("card payoff $477.57 · plan $450");
    expect(screen.getByTestId("plan-hook-ws-2026-10-03").textContent).toBe("paid on evidence by AMERICAN EXPRESS ACH PMT · plan $450");
    expect(screen.queryByTestId("plan-hook-mort-2026-10-12")).toBeNull();
    // Display only: the row's own amount is still the stored plan.
    expect(screen.getByTestId("plan-row-ws-2026-10-10").textContent).toContain("-$450.00");
    expect(screen.getByTestId("plan-row-ws-2026-10-10").textContent).not.toContain("-$477.57");
  });

  it("(S2) no weekly plan set: the hook row says it is the Weekly Spend reserve, not a plan", () => {
    const noPlan = {
      hookReserves: [
        { hook: "weekly", recurringItemId: "ws", planKey: "ws|2026-10-10", occurrenceDate: "2026-10-10", label: "Weekly Spend", amount: "380.00", basis: "stored_amount" },
      ],
      events: [{ date: "2026-10-10", label: "Weekly Spend", amount: "-380.00", itemId: "ws", occurrenceKey: "ws|2026-10-10" }],
      overdueAssumedPaid: [],
    };
    show(hookPayoffsOf(noPlan as never), [plan("ws", "2026-10-10", "Weekly Spend", -380), plan("mort", "2026-10-12", "Mortgage", -1650)]);
    expect(screen.getByTestId("plan-hook-ws-2026-10-10").textContent).toBe("Weekly Spend reserve $380 · no weekly plan set");
    expect(screen.queryByTestId("plan-hook-mort-2026-10-12")).toBeNull();
  });

  it("without hook payoffs the rows are unchanged", () => {
    show(undefined);
    expect(screen.queryAllByTestId(/^plan-hook-/)).toHaveLength(0);
  });
});

// ⭐ (F5 round 2) A card week answered "missed" whose purchases are still owed is
// never shown as "Missed": "Carried" (moved to a later week, and where to), or
// "Still owed" while its purchases are on the forecast.
describe("PlannedItemsList — a carried card week is never 'Missed' (F5)", () => {
  const answered = (date: string): PlannedItem => ({
    kind: "plan",
    key: `ws|${date}`,
    row: { kind: "plan", itemId: "ws", date, label: "Weekly Spend", amount: -300, status: "missed" } as unknown as PlanLine,
  });
  const reserve = (date: string, extra: Record<string, unknown>) => ({
    hook: "weekly", recurringItemId: "ws", planKey: `ws|${date}`, occurrenceDate: date, label: "Weekly Spend", basis: "stored_amount",
    storedAmount: "300.00", paid: "0.00", carried: "0.00", carriedFrom: [], carriedTo: null, cards: [], ...extra,
  });
  const signal = {
    hookReserves: [
      reserve("2026-10-03", { amount: "0.00", incurred: "10.00", allowanceLeft: "0.00", carriedTo: "2026-10-10" }),
      reserve("2026-10-10", { amount: "270.00", incurred: "260.00", carried: "10.00", allowanceLeft: "0.00" }),
      reserve("2026-09-26", { amount: "210.00", incurred: "0.00", paid: "210.00", allowanceLeft: "0.00" }),
    ],
    events: [{ date: "2026-10-15", label: "Weekly Spend", amount: "-270.00", itemId: "ws", occurrenceKey: "ws|2026-10-10", originalDate: "2026-10-10", assumption: "overdue_assumed_unpaid" }],
    overdueAssumedPaid: [
      {
        planKey: "ws|2026-09-26", itemId: "ws", occurrenceDate: "2026-09-26", dueDate: "2026-09-26", label: "Weekly Spend",
        daysOverdue: 18, planAmount: "-210.00", txnId: "tx-pay", txnAmount: "-150.00", confidence: "card_payment", unpaidRemainder: "0.00",
      },
    ],
  };

  it("carried → 'Carried' + 'card purchases carried to Oct 15'; on the forecast → 'Still owed' + what it holds; paid in full keeps the answer", () => {
    show(hookPayoffsOf(signal as never, () => "AMERICAN EXPRESS ACH PMT"), [answered("2026-09-26"), answered("2026-10-03"), answered("2026-10-10")]);
    const carried = screen.getByTestId("plan-row-ws-2026-10-03");
    expect(carried.textContent).toContain("Carried");
    expect(carried.textContent).not.toContain("Missed");
    expect(screen.getByTestId("plan-hook-ws-2026-10-03").textContent).toBe("card purchases carried to Oct 15");
    const owed = screen.getByTestId("plan-row-ws-2026-10-10");
    expect(owed.textContent).toContain("Still owed");
    expect(screen.getByTestId("plan-hook-ws-2026-10-10").textContent).toBe("card purchases $270.00 still owed");
    // Paid on evidence, nothing owed: the household's answer stands.
    expect(screen.getByTestId("plan-row-ws-2026-09-26").textContent).toContain("Missed");
  });
});
