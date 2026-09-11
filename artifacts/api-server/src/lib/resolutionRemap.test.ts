import { describe, it, expect } from "vitest";
import { expandItem } from "./cashSignal";
import { remapOrphanResolutions, type ResolutionSchedule } from "./resolutionRemap";

// ⭐ PR6 — a resolution a schedule edit orphaned follows its bill (read-only).

type Row = Parameters<typeof expandItem>[0];
function rec(over: Partial<Row> & { id: string }): Row {
  return {
    userId: "u",
    householdId: null,
    name: over.name ?? "Bill",
    kind: over.kind ?? "expense",
    amount: over.amount ?? "40",
    frequency: over.frequency ?? "monthly",
    dayOfMonth: over.dayOfMonth ?? null,
    anchorDate: over.anchorDate ?? null,
    active: over.active ?? "true",
    debtId: null,
    categoryId: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    ...over,
  };
}

const lookup =
  (...items: Row[]) =>
  (itemId: string): ResolutionSchedule | null => {
    const r = items.find((i) => i.id === itemId);
    return r ? { cadence: r.frequency, occurrences: (f, t) => expandItem(r, f, t).map((e) => e.date) } : null;
  };

type Res = { id: string; recurringItemId: string | null; occurrenceDate: string | null; status: string };
const res = (id: string, recurringItemId: string | null, occurrenceDate: string | null, status = "matched"): Res => ({
  id,
  recurringItemId,
  occurrenceDate,
  status,
});
const datesById = (rows: Res[]) => Object.fromEntries(rows.map((r) => [r.id, r.occurrenceDate]));

describe("remapOrphanResolutions (PR6)", () => {
  // The gym bill's due day moved from the 14th to the 20th after May was matched.
  const gym = rec({ id: "gym", dayOfMonth: 20, anchorDate: "2026-01-20" });

  it("monthly: due day 14 → 20 moves the 14th's match to the 20th of the same month", () => {
    const out = remapOrphanResolutions([res("may", "gym", "2026-05-14"), res("apr", "gym", "2026-04-14")], lookup(gym));
    expect(datesById(out)).toEqual({ may: "2026-05-20", apr: "2026-04-20" });
  });

  it("never moves a resolution that sits on a real occurrence", () => {
    const rows = [res("may", "gym", "2026-05-20")];
    expect(remapOrphanResolutions(rows, lookup(gym))).toBe(rows);
  });

  it("does not move onto an occurrence that has a resolution of its own", () => {
    const out = remapOrphanResolutions(
      [res("old", "gym", "2026-05-14", "matched"), res("own", "gym", "2026-05-20", "missed")],
      lookup(gym),
    );
    expect(datesById(out)).toEqual({ old: "2026-05-14", own: "2026-05-20" });
  });

  it("a 'Not this' at the orphaned date moves with its bill", () => {
    const out = remapOrphanResolutions(
      [res("match", "gym", "2026-05-14", "matched"), res("reject", "gym", "2026-05-14", "not_match")],
      lookup(gym),
    );
    expect(datesById(out)).toEqual({ match: "2026-05-20", reject: "2026-05-20" });
  });

  it("two orphans in one month: the earlier one claims the occurrence, the later one stays", () => {
    const out = remapOrphanResolutions(
      [res("late", "gym", "2026-05-14"), res("early", "gym", "2026-05-10")],
      lookup(gym),
    );
    expect(datesById(out)).toEqual({ early: "2026-05-20", late: "2026-05-14" });
  });

  it("weekly: Saturday → Monday maps to the occurrence within 3 days", () => {
    const spend = rec({ id: "spend", frequency: "weekly", anchorDate: "2026-05-11" }); // Mondays
    const out = remapOrphanResolutions([res("sat", "spend", "2026-05-09", "skipped")], lookup(spend));
    expect(datesById(out)).toEqual({ sat: "2026-05-11" });
  });

  it("biweekly: an exact tie between two occurrences maps nowhere", () => {
    const pay = rec({ id: "pay", kind: "income", frequency: "biweekly", anchorDate: "2026-05-01" });
    const rows = [res("mid", "pay", "2026-05-08")]; // 05-01 and 05-15 are both 7 days away
    expect(datesById(remapOrphanResolutions(rows, lookup(pay)))).toEqual({ mid: "2026-05-08" });
  });

  it("semimonthly: the nearest occurrence within 7 days", () => {
    // Was the 1st and 15th; now the 5th and 19th.
    const lawn = rec({ id: "lawn", frequency: "semimonthly", dayOfMonth: 5, anchorDate: "2026-01-05" });
    const out = remapOrphanResolutions(
      [res("first", "lawn", "2026-05-01"), res("fifteenth", "lawn", "2026-05-15")],
      lookup(lawn),
    );
    expect(datesById(out)).toEqual({ first: "2026-05-05", fifteenth: "2026-05-19" });
  });

  it("quarterly: an orphan maps inside its month, and stays when that month has no occurrence", () => {
    const tax = rec({ id: "tax", frequency: "quarterly", anchorDate: "2026-01-31" }); // Apr 30, Jul 31
    const out = remapOrphanResolutions(
      [res("apr", "tax", "2026-04-15"), res("may", "tax", "2026-05-31")],
      lookup(tax),
    );
    expect(datesById(out)).toEqual({ apr: "2026-04-30", may: "2026-05-31" });
  });

  it("one-time, inactive and unknown items never move; rows without an item or date pass through", () => {
    const once = rec({ id: "once", frequency: "onetime", anchorDate: "2026-05-12" });
    const paused = rec({ id: "paused", dayOfMonth: 20, anchorDate: "2026-01-20", active: "false" });
    const rows = [
      res("once", "once", "2026-05-10"),
      res("paused", "paused", "2026-05-14"),
      res("gone", "deleted-item", "2026-05-14"),
      res("row-only", null, null, "ignored_unforecasted"),
    ];
    const out = remapOrphanResolutions(rows, lookup(once, paused));
    expect(out).toBe(rows);
  });

  it("does not mutate its input", () => {
    const rows = [res("may", "gym", "2026-05-14")];
    const out = remapOrphanResolutions(rows, lookup(gym));
    expect(rows[0]!.occurrenceDate).toBe("2026-05-14");
    expect(out[0]).not.toBe(rows[0]);
  });
});
