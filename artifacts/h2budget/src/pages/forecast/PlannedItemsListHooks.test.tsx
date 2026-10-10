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

function show(hookPayoffs?: ReturnType<typeof hookPayoffsOf>) {
  const noop = () => {};
  render(
    <PlannedItemsList
      items={[plan("ws", "2026-10-03", "Weekly Spend", -450), plan("ws", "2026-10-10", "Weekly Spend", -450), plan("mort", "2026-10-12", "Mortgage", -1650)]}
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

  it("without hook payoffs the rows are unchanged", () => {
    show(undefined);
    expect(screen.queryAllByTestId(/^plan-hook-/)).toHaveLength(0);
  });
});
