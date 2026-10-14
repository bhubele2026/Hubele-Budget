// ⭐ (P2) THE AMEX PAYOFF, THE AMEX SUMMARY AND THE BEHAVIOR FACTS READ THE
// PENDING PAIRS FOR THEIR OWN DATES ONLY — AND NOTHING MOVES.
//
// `computeWeeklyPayoff` (run once per hook period on every forecast build),
// `buildAmexSummary` and `buildBehaviorFacts` used `loadSupersededPendingIds`:
// the pairing over the household's WHOLE history. They now read
// `findSupersededPendingForRange` over the dates their rows come from. Proven
// on a rich synthetic household with a year of pending → posted chains on
// three cards:
//   1. property: for every range those readers ask for, the windowed set is
//      exactly the whole-history set restricted to rows dated in the range;
//   2. the readers themselves: every output is identical whether the pairs come
//      from the windowed read or from the whole-history read (the old answer).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, gte, lte } from "drizzle-orm";

const mode = vi.hoisted(() => ({ wholeHistory: false, ranges: [] as Array<[string, string]> }));

// The old answer on demand: the whole-history pairing, for every caller of the windowed read.
vi.mock("../lib/supersededPending", async (orig) => {
  const actual = (await orig()) as typeof import("../lib/supersededPending");
  return {
    ...actual,
    findSupersededPendingForRange: async (
      householdId: string,
      from: string,
      to: string,
      reader?: Parameters<typeof actual.findSupersededPendingForRange>[3],
    ) => {
      mode.ranges.push([from, to]);
      if (!mode.wholeHistory) return actual.findSupersededPendingForRange(householdId, from, to, reader);
      return { ...(await actual.findSupersededPending(householdId, reader)), queries: 1, windowStart: null };
    },
  };
});

import { db, transactionsTable } from "@workspace/db";
import { computeWeeklyPayoff } from "../lib/amexAnchor";
import { buildAmexSummary } from "../lib/amexSummary";
import { buildBehaviorFacts } from "../lib/behaviorFacts";
import { findSupersededPending, findSupersededPendingForRange } from "../lib/supersededPending";
import { TRACKING_START } from "../lib/spendingFacts";
import { RICH_NOW, RICH_TODAY, cleanupRichHouseholds, seedRichHousehold, type RichHousehold } from "./_fixtures/richHousehold";

const OWNER = `p2-window-${process.pid}-${randomUUID().slice(0, 8)}`;
let rich: RichHousehold;

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthOf = (day: string) => ({
  from: `${day.slice(0, 7)}-01`,
  to: new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).toISOString().slice(0, 10),
});
/** Every Sunday from the tracking start through this week. */
const SUNDAYS: string[] = [];
for (let d = "2026-05-03"; d <= "2026-10-11"; d = addDays(d, 7)) SUNDAYS.push(d);

/** `computeWeeklyPayoff`'s own query window for a week: the week and its calendar month. */
function payoffWindow(weekStart: string): [string, string] {
  const weekEnd = addDays(weekStart, 6);
  const m = monthOf(weekStart);
  return [m.from < weekStart ? m.from : weekStart, m.to > weekEnd ? m.to : weekEnd];
}

async function both<T>(fn: () => Promise<T>): Promise<{ windowed: T; whole: T }> {
  mode.wholeHistory = false;
  const windowed = await fn();
  mode.wholeHistory = true;
  try {
    return { windowed, whole: await fn() };
  } finally {
    mode.wholeHistory = false;
  }
}

beforeAll(async () => {
  vi.setSystemTime(RICH_NOW);
  rich = await seedRichHousehold(OWNER);
});

afterAll(async () => {
  vi.useRealTimers();
  await cleanupRichHouseholds([OWNER]);
});

describe("the windowed pending pairs, for the readers that switched to them", () => {
  it("⭐ property: windowed set = whole-history set ∩ rows dated in the range, for every range the readers ask for", async () => {
    const whole = await findSupersededPending(rich.householdId);
    // The fixture really has chains: plenty of replaced pending rows, across the year.
    expect(whole.replacedIds.size).toBeGreaterThan(80);

    const ranges: Array<[string, string]> = [
      ...SUNDAYS.map(payoffWindow),
      ...SUNDAYS.map((s): [string, string] => [s, addDays(s, 6)]),
      ...["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"].map((m): [string, string] => [
        monthOf(m).from,
        monthOf(m).to,
      ]),
      [TRACKING_START, RICH_TODAY],
      [TRACKING_START, "2026-12-31"],
    ];
    let compared = 0;
    for (const [from, to] of ranges) {
      const rows = await db
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, rich.householdId),
            gte(transactionsTable.occurredOn, from),
            lte(transactionsTable.occurredOn, to),
          ),
        );
      const inRange = new Set(rows.map((r) => r.id));
      const expected = [...whole.replacedIds].filter((id) => inRange.has(id)).sort();
      const windowed = await findSupersededPendingForRange(rich.householdId, from, to);
      expect([...windowed.replacedIds].sort(), `${from}..${to}`).toEqual(expected);
      compared += expected.length;
    }
    expect(compared).toBeGreaterThan(200);
  });

  it("⭐ computeWeeklyPayoff: every week, both coverages, identical with the whole-history pairs", async () => {
    let charged = 0;
    for (const ws of SUNDAYS) {
      for (const allCoverages of [true, false]) {
        mode.ranges.length = 0;
        const { windowed, whole } = await both(() => computeWeeklyPayoff(rich.householdId, ws, OWNER, { allCoverages }));
        expect(windowed, `${ws} allCoverages=${allCoverages}`).toEqual(whole);
        // It asked for its own query window, nothing wider.
        expect(mode.ranges[0], ws).toEqual(payoffWindow(ws));
        charged += windowed.combinedWeekCharges;
      }
    }
    expect(charged).toBeGreaterThan(0);
  });

  it("⭐ buildAmexSummary: weeks and months, every card and all, identical with the whole-history pairs", async () => {
    const periods: Array<[string, string]> = [
      ...SUNDAYS.slice(-5).map((s): [string, string] => [s, addDays(s, 6)]),
      ["2026-08-01", "2026-08-31"],
      ["2026-09-01", "2026-09-30"],
      ["2026-10-01", "2026-10-31"],
      // Clamped at the tracking start, and says so.
      ["2026-04-20", "2026-05-10"],
    ];
    for (const [from, to] of periods) {
      for (const accountId of ["all", rich.accounts.platinum, rich.accounts.gold, rich.accounts.blue]) {
        const q = { accountId, from, to, rowsPerGroup: 50 };
        const { windowed, whole } = await both(() => buildAmexSummary(rich.householdId, OWNER, q));
        expect(windowed, `${accountId} ${from}..${to}`).toEqual(whole);
      }
    }
  });

  it("⭐ buildBehaviorFacts: the default range, months, a range before tracking began, identical with the whole-history pairs", async () => {
    for (const [from, to] of [
      [undefined, undefined],
      ["2026-09-01", "2026-09-30"],
      ["2026-10-01", "2026-10-31"],
      ["2026-03-01", "2026-06-15"],
      ["2026-05-01", RICH_TODAY],
    ] as Array<[string | undefined, string | undefined]>) {
      const { windowed, whole } = await both(() => buildBehaviorFacts(rich.householdId, from, to));
      expect(windowed, `${from}..${to}`).toEqual(whole);
    }
  });
});
