import { describe, it, expect } from "vitest";
import {
  buildDraggingPlans,
  buildEventsByDate,
  draggingPlanLine,
  occurrenceDateOf,
  tooltipPlanLine,
  type SignalEvent,
} from "./forecastPastDue";

// ⭐ PR6 — the Past-due card and the chart tooltip act on the occurrence key.
//
// "Internet" was due 05-05, moved to 05-11, and is still unpaid, so the cash
// signal dragged it onto Fri 05-15. Resolutions are keyed on 05-05. Before PR6
// the card and the tooltip sent 05-11, so Mark missed / Skip / match did nothing
// on the curve. The page's handlers send `line.originalDate ?? line.date`
// (`onMarkMissed`, `matchInboxToPlan`) and `row.occurrenceDate` (`onSkipDraggingPlan`).

const movedThenOverdue: SignalEvent = {
  date: "2026-05-15",
  label: "Internet",
  amount: "-80.00",
  itemId: "internet",
  originalDate: "2026-05-11",
  occurrenceDate: "2026-05-05",
};
const overdue: SignalEvent = {
  date: "2026-05-15",
  label: "Phone",
  amount: "-95.00",
  itemId: "phone",
  originalDate: "2026-05-12",
  occurrenceDate: "2026-05-12",
};
const dueThatDay: SignalEvent = {
  date: "2026-05-15",
  label: "Water",
  amount: "-30.00",
  itemId: "water",
  originalDate: "2026-05-15",
  occurrenceDate: "2026-05-15",
};
const sent = (line: { originalDate?: string; date: string }) => line.originalDate ?? line.date;

describe("Past-due card and tooltip send the occurrence key (PR6)", () => {
  it("the card lists dragged plans only, oldest due first, each with its occurrence date", () => {
    const rows = buildDraggingPlans([dueThatDay, overdue, movedThenOverdue]);
    expect(rows).toEqual([
      { itemId: "internet", label: "Internet", amount: -80, originalDate: "2026-05-11", occurrenceDate: "2026-05-05", effectiveDate: "2026-05-15" },
      { itemId: "phone", label: "Phone", amount: -95, originalDate: "2026-05-12", occurrenceDate: "2026-05-12", effectiveDate: "2026-05-15" },
    ]);
  });

  it("the card's Mark missed, match and Skip act on 05-05, not the moved-to 05-11", () => {
    const [internet] = buildDraggingPlans([movedThenOverdue]);
    const line = draggingPlanLine(internet!);
    expect(sent(line)).toBe("2026-05-05");
    expect(line).toMatchObject({ itemId: "internet", date: "2026-05-15", status: "pending_plan" });
    expect(internet!.occurrenceDate).toBe("2026-05-05");
  });

  it("the tooltip's Mark missed acts on 05-05", () => {
    const day = buildEventsByDate([dueThatDay, movedThenOverdue]).get("2026-05-15")!;
    const internet = day.find((b) => b.itemId === "internet")!;
    expect(internet).toMatchObject({ dragged: true, originalDate: "2026-05-11", occurrenceDate: "2026-05-05" });
    expect(sent(tooltipPlanLine({ ...internet, itemId: "internet" }, "2026-05-15"))).toBe("2026-05-05");
    // A bill due that very day is not dragged, and sorts after the larger outflow.
    expect(day.map((b) => [b.itemId, b.dragged])).toEqual([
      ["internet", true],
      ["water", false],
    ]);
  });

  it("an unmoved overdue bill sends its own due date", () => {
    const [phone] = buildDraggingPlans([overdue]);
    expect(sent(draggingPlanLine(phone!))).toBe("2026-05-12");
  });

  it("a payload without occurrenceDate (a pre-PR6 server) falls back to originalDate", () => {
    expect(occurrenceDateOf({ date: "2026-05-15", originalDate: "2026-05-12" })).toBe("2026-05-12");
    expect(occurrenceDateOf({ date: "2026-05-15" })).toBe("2026-05-15");
  });
});
