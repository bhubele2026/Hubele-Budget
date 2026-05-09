import { describe, expect, it } from "vitest";
import type {
  ForecastEvent,
  ForecastResolution,
} from "@workspace/api-client-react";

import {
  buildMissedRows,
  buildPlanRows,
  validateNewDate,
} from "./forecastBucket";

/**
 * (#536) Mobile Forecast tab actions — Mark missed / Set new date / Skip /
 * Undo. The mobile artifact runs vitest in a node environment with no
 * react-native renderer, so these tests exercise the data layer the
 * Forecast screen reads from after each action's upsert/delete: the
 * action handlers in `forecast.tsx` post a resolution row, then the
 * screen re-projects via `buildPlanRows` / `buildMissedRows`. Asserting
 * those projections is the closest we can get to UI coverage and would
 * catch regressions in the resolution wiring or the new `skipped`
 * filter.
 */

const MAY = "2026-05";
const TODAY = new Date(2026, 4, 9); // 2026-05-09 — same as repo "today"

function ev(overrides: Partial<ForecastEvent> & { itemId: string; date: string }): ForecastEvent {
  return {
    itemId: overrides.itemId,
    date: overrides.date,
    label: "Rent",
    kind: "expense",
    amount: -1500,
    ...overrides,
  } as ForecastEvent;
}

function res(
  overrides: Partial<ForecastResolution> & {
    id: string;
    recurringItemId: string;
    occurrenceDate: string;
    status: string;
  },
): ForecastResolution {
  return {
    id: overrides.id,
    recurringItemId: overrides.recurringItemId,
    occurrenceDate: overrides.occurrenceDate,
    status: overrides.status,
    matchedTxnId: null,
    rescheduledTo: null,
    ...overrides,
  } as ForecastResolution;
}

describe("(#536) Forecast actions — pending plan rows", () => {
  const pendingEvent = ev({ itemId: "rent", date: "2026-05-05" }); // before TODAY → pending
  const futureEvent = ev({
    itemId: "internet",
    date: "2026-05-20",
    label: "Internet",
    amount: -80,
  });

  it("exposes pending and future rows so 'Mark missed' and 'Set new date' actions can target them", () => {
    const rows = buildPlanRows({
      events: [pendingEvent, futureEvent],
      resolutions: [],
      today: TODAY,
    });
    const byItem = Object.fromEntries(rows.map((r) => [r.itemId, r]));
    expect(byItem.rent.status).toBe("pending");
    expect(byItem.rent.occurrenceDate).toBe("2026-05-05");
    expect(byItem.internet.status).toBe("future");
  });

  it("'Mark missed' moves the row out of pending and into the missed bucket", () => {
    // The screen calls upsertResolution({status: "missed", recurringItemId,
    // occurrenceDate}); after the cache invalidates the resolution comes
    // back attached to the same occurrence.
    const resolutions = [
      res({
        id: "r-missed-1",
        recurringItemId: "rent",
        occurrenceDate: "2026-05-05",
        status: "missed",
      }),
    ];
    const planRows = buildPlanRows({
      events: [pendingEvent],
      resolutions,
      today: TODAY,
    });
    expect(planRows).toHaveLength(1);
    expect(planRows[0].status).toBe("missed");
    expect(planRows[0].resolutionId).toBe("r-missed-1");

    const missed = buildMissedRows({
      events: [pendingEvent],
      resolutions,
      monthKey: MAY,
    });
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({
      resolutionId: "r-missed-1",
      itemId: "rent",
      occurrenceDate: "2026-05-05",
      label: "Rent",
      amount: -1500,
    });
  });

  it("'Set new date' reroutes the row to the rescheduled date and keeps the original occurrenceDate as the upsert key", () => {
    // Validation matches the desktop rule the modal enforces.
    expect(validateNewDate("2026-05-15", "2026-05-05", TODAY)).toBeNull();
    expect(validateNewDate("2026-05-05", "2026-05-05", TODAY)).toMatch(/after/);
    expect(validateNewDate("not-a-date", "2026-05-05", TODAY)).toMatch(/YYYY/);

    const resolutions = [
      res({
        id: "r-resched-1",
        recurringItemId: "rent",
        occurrenceDate: "2026-05-05",
        status: "rescheduled",
        rescheduledTo: "2026-05-15",
      }),
    ];
    const rows = buildPlanRows({
      events: [pendingEvent],
      resolutions,
      today: TODAY,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-05-15");
    expect(rows[0].occurrenceDate).toBe("2026-05-05");
    // 2026-05-15 > today (2026-05-09) → moved into the future
    expect(rows[0].status).toBe("future");
  });
});

describe("(#536) Forecast actions — missed rows", () => {
  const event = ev({ itemId: "rent", date: "2026-05-05" });
  const missedRes = res({
    id: "r-missed-2",
    recurringItemId: "rent",
    occurrenceDate: "2026-05-05",
    status: "missed",
  });

  it("'Set new date' on a missed row moves it back to a future plan row and clears the missed bucket", () => {
    // The screen overwrites the same resolution with status=rescheduled.
    const resolutions = [
      res({
        ...missedRes,
        status: "rescheduled",
        rescheduledTo: "2026-05-22",
      }),
    ];
    const plan = buildPlanRows({
      events: [event],
      resolutions,
      today: TODAY,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].date).toBe("2026-05-22");
    expect(plan[0].status).toBe("future");

    const missed = buildMissedRows({
      events: [event],
      resolutions,
      monthKey: MAY,
    });
    expect(missed).toEqual([]);
  });

  it("'Skip' removes the occurrence from both the plan list and the missed bucket (covers the new `skipped` filter)", () => {
    const resolutions = [
      res({
        ...missedRes,
        status: "skipped",
      }),
    ];
    const plan = buildPlanRows({
      events: [event],
      resolutions,
      today: TODAY,
    });
    expect(plan).toEqual([]);

    const missed = buildMissedRows({
      events: [event],
      resolutions,
      monthKey: MAY,
    });
    expect(missed).toEqual([]);
  });

  it("'Undo' (delete resolution) restores the original pending plan row — same path the snackbar UNDO button takes", () => {
    // Before Undo: a "Skipped" snackbar is shown with undoResolutionId
    // pointing at the just-created resolution. Tapping UNDO deletes
    // that resolution; after the cache invalidates the row should be
    // back to pending and the missed bucket empty.
    const before = buildPlanRows({
      events: [event],
      resolutions: [res({ ...missedRes, status: "skipped" })],
      today: TODAY,
    });
    expect(before).toEqual([]);

    const after = buildPlanRows({
      events: [event],
      resolutions: [], // resolution deleted
      today: TODAY,
    });
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("pending");
    expect(after[0].resolutionId).toBeUndefined();

    const missedAfter = buildMissedRows({
      events: [event],
      resolutions: [],
      monthKey: MAY,
    });
    expect(missedAfter).toEqual([]);
  });
});
