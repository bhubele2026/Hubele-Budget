import { describe, it, expect } from "vitest";
import {
  expandItem,
  parseISO,
  fmtISO,
  addDays,
  nextBusinessDay,
} from "./cashSignal";

// Minimal stand-in for the recurring_items row shape — we only feed
// `expandItem` the fields it actually reads.
type MinRecurringRow = Parameters<typeof expandItem>[0];
function rec(overrides: Partial<MinRecurringRow>): MinRecurringRow {
  return {
    id: overrides.id ?? "ri-1",
    userId: "u",
    householdId: null,
    name: overrides.name ?? "Test",
    kind: overrides.kind ?? "expense",
    amount: overrides.amount ?? "100",
    frequency: overrides.frequency ?? "monthly",
    dayOfMonth: overrides.dayOfMonth ?? null,
    anchorDate: overrides.anchorDate ?? null,
    active: overrides.active ?? "true",
    debtId: overrides.debtId ?? null,
    categoryId: overrides.categoryId ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  };
}

describe("parseISO / fmtISO / addDays", () => {
  it("round-trips an ISO date string", () => {
    expect(fmtISO(parseISO("2026-04-15"))).toBe("2026-04-15");
  });

  it("addDays correctly crosses a month boundary", () => {
    expect(fmtISO(addDays(parseISO("2026-04-28"), 5))).toBe("2026-05-03");
  });

  it("addDays correctly crosses a year boundary", () => {
    expect(fmtISO(addDays(parseISO("2026-12-30"), 5))).toBe("2027-01-04");
  });
});

describe("nextBusinessDay (#751)", () => {
  it("Wed → Thu (weekday to weekday)", () => {
    // 2026-05-27 is a Wednesday.
    expect(fmtISO(nextBusinessDay(parseISO("2026-05-27")))).toBe("2026-05-28");
  });
  it("Fri → Mon (skip weekend)", () => {
    // 2026-05-29 is a Friday.
    expect(fmtISO(nextBusinessDay(parseISO("2026-05-29")))).toBe("2026-06-01");
  });
  it("Sat → Mon", () => {
    // 2026-05-30 is a Saturday.
    expect(fmtISO(nextBusinessDay(parseISO("2026-05-30")))).toBe("2026-06-01");
  });
  it("Sun → Mon", () => {
    // 2026-05-31 is a Sunday.
    expect(fmtISO(nextBusinessDay(parseISO("2026-05-31")))).toBe("2026-06-01");
  });
});

describe("expandItem - active flag", () => {
  it("returns no events when active is not 'true'", () => {
    const item = rec({ active: "false", frequency: "weekly", anchorDate: "2026-04-01" });
    expect(expandItem(item, parseISO("2026-04-01"), parseISO("2026-04-30"))).toEqual([]);
  });
});

describe("expandItem - one-time", () => {
  it("emits a single event on the anchor date when in window", () => {
    const item = rec({
      frequency: "onetime",
      anchorDate: "2026-04-15",
      amount: "250",
      kind: "expense",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-04-30"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: "2026-04-15", amount: -250, kind: "expense" });
  });

  it("emits nothing when the anchor falls outside the window", () => {
    const item = rec({
      frequency: "onetime",
      anchorDate: "2026-03-31",
      amount: "250",
    });
    expect(
      expandItem(item, parseISO("2026-04-01"), parseISO("2026-04-30")),
    ).toEqual([]);
  });
});

describe("expandItem - weekly", () => {
  it("emits exactly one event per 7-day stride within the window", () => {
    // Anchor on a Wednesday. April 1 2026 is a Wed.
    const item = rec({
      frequency: "weekly",
      anchorDate: "2026-04-01",
      amount: "50",
      kind: "expense",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-04-30"));
    expect(out.map((e) => e.date)).toEqual([
      "2026-04-01",
      "2026-04-08",
      "2026-04-15",
      "2026-04-22",
      "2026-04-29",
    ]);
    expect(out.every((e) => e.amount === -50)).toBe(true);
  });

  it("walks back from a future anchor to find the first occurrence in the window", () => {
    // Anchor in May, but window is April — should still walk back to April 8.
    const item = rec({
      frequency: "weekly",
      anchorDate: "2026-05-13",
      amount: "30",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-04-30"));
    expect(out.map((e) => e.date)).toEqual([
      "2026-04-01",
      "2026-04-08",
      "2026-04-15",
      "2026-04-22",
      "2026-04-29",
    ]);
  });
});

describe("expandItem - biweekly", () => {
  it("strides every 14 days from the anchor", () => {
    // Anchor April 3 2026 (Friday) — biweekly paycheck pattern.
    const item = rec({
      frequency: "biweekly",
      anchorDate: "2026-04-03",
      amount: "1500",
      kind: "income",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-05-31"));
    expect(out.map((e) => e.date)).toEqual([
      "2026-04-03",
      "2026-04-17",
      "2026-05-01",
      "2026-05-15",
      "2026-05-29",
    ]);
    expect(out.every((e) => e.amount === 1500 && e.kind === "income")).toBe(true);
  });
});

describe("expandItem - monthly", () => {
  it("emits one event per month at dayOfMonth", () => {
    const item = rec({
      frequency: "monthly",
      dayOfMonth: 15,
      anchorDate: "2026-01-15",
      amount: "200",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-06-30"));
    expect(out.map((e) => e.date)).toEqual([
      "2026-04-15",
      "2026-05-15",
      "2026-06-15",
    ]);
  });

  it("clamps dayOfMonth to the last valid day in short months", () => {
    // Day 31 in February → clamps to 28 (or 29 in a leap year).
    const item = rec({
      frequency: "monthly",
      dayOfMonth: 31,
      anchorDate: "2026-01-31",
      amount: "100",
    });
    const out = expandItem(item, parseISO("2026-02-01"), parseISO("2026-02-28"));
    expect(out.map((e) => e.date)).toEqual(["2026-02-28"]);
  });

  it("falls back to anchor's day when dayOfMonth is null", () => {
    const item = rec({
      frequency: "monthly",
      dayOfMonth: null,
      anchorDate: "2026-04-07",
      amount: "100",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-06-30"));
    expect(out.map((e) => e.date)).toEqual([
      "2026-04-07",
      "2026-05-07",
      "2026-06-07",
    ]);
  });

  it("does not emit events before the anchor month even when dayOfMonth is in the window", () => {
    // Anchor June 15, window = April → June. Should only emit June 15.
    const item = rec({
      frequency: "monthly",
      dayOfMonth: 15,
      anchorDate: "2026-06-15",
      amount: "100",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-06-30"));
    expect(out.map((e) => e.date)).toEqual(["2026-06-15"]);
  });
});

describe("expandItem - semimonthly", () => {
  it("emits two events per month, ~14 days apart", () => {
    // dayOfMonth = 1 → second event = day 15.
    const item = rec({
      frequency: "semimonthly",
      dayOfMonth: 1,
      anchorDate: "2026-04-01",
      amount: "1000",
      kind: "income",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-05-31"));
    expect(out.map((e) => e.date)).toEqual([
      "2026-04-01",
      "2026-04-15",
      "2026-05-01",
      "2026-05-15",
    ]);
  });
});

describe("expandItem - quarterly / annual", () => {
  it("quarterly strides every 3 months from the anchor", () => {
    const item = rec({
      frequency: "quarterly",
      anchorDate: "2026-01-15",
      amount: "300",
    });
    const out = expandItem(item, parseISO("2026-01-01"), parseISO("2026-12-31"));
    expect(out.map((e) => e.date)).toEqual([
      "2026-01-15",
      "2026-04-15",
      "2026-07-15",
      "2026-10-15",
    ]);
  });

  it("annual strides every 12 months from the anchor", () => {
    const item = rec({
      frequency: "annual",
      anchorDate: "2024-06-30",
      amount: "1200",
    });
    const out = expandItem(item, parseISO("2026-01-01"), parseISO("2027-12-31"));
    expect(out.map((e) => e.date)).toEqual(["2026-06-30", "2027-06-30"]);
  });
});

describe("expandItem - sign convention", () => {
  it("expense amounts are emitted as negative regardless of input sign", () => {
    const item = rec({
      frequency: "onetime",
      anchorDate: "2026-04-15",
      amount: "-500", // user enters either sign; magnitude is what matters
      kind: "expense",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-04-30"));
    expect(out[0].amount).toBe(-500);
  });

  it("income amounts are emitted as positive regardless of input sign", () => {
    const item = rec({
      frequency: "onetime",
      anchorDate: "2026-04-15",
      amount: "-1500",
      kind: "income",
    });
    const out = expandItem(item, parseISO("2026-04-01"), parseISO("2026-04-30"));
    expect(out[0].amount).toBe(1500);
  });
});
