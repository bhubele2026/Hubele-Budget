// ⭐ (F1) THE HOOKS' CARD FIGURES ARE THE CARD PAGE'S — proven on the rich
// synthetic household (a year of history, pending → posted chains on every
// card, refunds, "not mine" rows none).
//
// `readCardPeriods` (the everyday hooks' obligations, every card, every
// period, one read) and `computeWeeklyPayoff` (the Amex page's per-card
// weekly / monthly charges) share one per-row rule (`cardRowOwed`). For every
// week since tracking began, each card the payoff bills (Gold weekly, Blue
// monthly) has the same figure to the cent; a debt-linked card the payoff
// leaves out (Platinum) has the Amex summary's purchases − refunds for its
// window (floored at 0). And with the defaults the forecast's own figure for
// this week is the page's combined weekly charges.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { computeWeeklyPayoff, readCardPeriods } from "../lib/amexAnchor";
import { buildAmexSummary } from "../lib/amexSummary";
import { discoverAmexCards } from "../lib/amexCardCadence";
import { computeCashSignalDetailed } from "../lib/cashSignal";
import { TRACKING_START } from "../lib/spendingFacts";
import { RICH_NOW, RICH_TODAY, cleanupRichHouseholds, seedRichHousehold, type RichHousehold } from "./_fixtures/richHousehold";

const OWNER = `f1-parity-${process.pid}-${randomUUID().slice(0, 8)}`;
let rich: RichHousehold;

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const SUNDAYS: string[] = [];
for (let d = "2026-05-03"; d <= RICH_TODAY; d = addDays(d, 7)) SUNDAYS.push(d);
const cents = (n: number) => Math.round(n * 100);

beforeAll(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(RICH_NOW);
  rich = await seedRichHousehold(OWNER);
});
afterAll(async () => {
  vi.useRealTimers();
  await cleanupRichHouseholds([OWNER]);
});

describe("(F1) readCardPeriods = the card page, every week, every card", () => {
  it("⭐ every week since tracking began: Gold (weekly) and Blue (monthly) to the cent; Platinum (debt-linked) = the summary's purchases − refunds", async () => {
    const roster = await discoverAmexCards(rich.householdId, OWNER);
    const periods = SUNDAYS.flatMap((s) => [
      { cadence: "weekly" as const, start: s, end: addDays(s, 6) },
      { cadence: "monthly" as const, start: `${s.slice(0, 8)}01`, end: new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0)).toISOString().slice(0, 10) },
    ]);
    const read = await readCardPeriods(rich.householdId, roster, periods, null);
    let compared = 0;
    for (const s of SUNDAYS) {
      const payoff = await computeWeeklyPayoff(rich.householdId, s, OWNER, { allCoverages: true });
      const weekly = read.charges.get(`weekly|${s}`)!;
      const monthly = read.charges.get(`monthly|${s.slice(0, 8)}01`)!;
      for (const c of payoff.cards) {
        const mine = c.cadence === "weekly" ? weekly.get(c.accountId) : monthly.get(c.accountId);
        expect(mine, `${s} ${c.name}`).toBe(cents(c.weekCharges));
        compared += 1;
      }
      // The debt-linked Platinum (weekly): the summary's purchases − refunds over its week, floored.
      const sum = await buildAmexSummary(rich.householdId, OWNER, { accountId: rich.accounts.platinum, from: s < TRACKING_START ? TRACKING_START : s, to: addDays(s, 6) > RICH_TODAY ? RICH_TODAY : addDays(s, 6), rowsPerGroup: 1 });
      expect(weekly.get(rich.accounts.platinum), `${s} Platinum`).toBe(Math.max(0, cents(Number(sum.purchases.amount)) - cents(Number(sum.refunds.amount))));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(60);
  });

  it("with the defaults, this week's hook bills exactly the page's combined weekly charges (Platinum's active debt → debt plan; Gold → in full)", async () => {
    const { ledger } = await computeCashSignalDetailed(rich.householdId, OWNER, { horizonDays: 90 });
    const week = [...ledger.hookPayoffs.values()].find((p) => p.cadence === "weekly" && p.periodStart === "2026-10-11")!;
    const payoff = await computeWeeklyPayoff(rich.householdId, "2026-10-11", OWNER, { allCoverages: true });
    expect(week.ownCents).toBe(cents(payoff.combinedWeekCharges));
    expect(week.cards.map((c) => [c.accountId, c.mode])).toEqual([[rich.accounts.gold, "in_full"]]);
  });
});
