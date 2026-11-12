// The home page's extra answers, from the same invented household (fixture.mjs).
// Every name and amount is made up.
import * as fx from "./fixture.mjs";

// Scenario for this request (set by the middleware from the x-scenario header). Invented figures only.
export const state = { scenario: "under" };
const has = (w) => state.scenario.split(",").includes(w);

export function spine() {
  const s = fx.spine();
  const position = has("over")
    ? { ...s.position, knownWeek: "505.61", remainingWeekKnown: "-180.61", remainingWeek: "-180.61", safeToSpendNow: "0.00", withinPlan: "over" }
    : s.position;
  return { ...s, position, debt: { ...s.debt, paidDownMtd: 400, confirmedPaymentsMtd: 400 } };
}

export function moneyPosition() {
  const p = spine().position;
  return {
    todayISO: fx.TODAY, status: "ok", paydayDate: p.paydayDate, payday: null, horizon: { kind: "payday", through: p.paydayDate },
    lowestUntilPayday: "1740.00", lowestUntilPaydayDate: "2026-11-12", committedUntilPayday: "0.00", cashBuffer: String(fx.CASH_BUFFER),
    reservesHeld: "0.00", availableUntilPayday: p.availableUntilPayday, weekStart: "2026-11-08", weekEnd: "2026-11-14",
    weekCap: "325.00", weekAdjustment: null, spentWeekDiscretionary: p.knownWeek, needsClassificationWeek: "0.00", unplannedWeek: "0.00", monthlyWeek: "0.00",
    remainingWeek: p.remainingWeek, knownWeek: p.knownWeek, unresolvedWeek: p.unresolvedWeek, provisional: false, remainingWeekKnown: p.remainingWeekKnown,
    paceAllowedToday: null, withinPlan: p.withinPlan, safeToSpendNow: p.safeToSpendNow, confidence: "firm", estimates: [], assumptions: [],
  };
}

export const settings = { preferences: {} };

const CARD_A = { debtId: "debt-card-a", name: "Card A" };
const CARD_B = { debtId: "debt-card-b", name: "Card B" };
const week = (date, paid, targets) => ({ date, planned: 600, room: paid, due: paid, paid, basis: "curve", answered: false, nextTarget: CARD_A, targets: targets ?? [{ ...CARD_A, amount: paid, paidOff: false }], paidOff: [] });
const TWO = (a, b) => [{ ...CARD_A, amount: a, paidOff: true }, { ...CARD_B, amount: b, paidOff: false }];
export function avalancheWeekly() {
  const base = {
    cadence: "weekly", weekday: 5, monthlyTarget: 2600, targetWeekly: 600, cashBuffer: fx.CASH_BUFFER,
    weeks: [week("2026-11-13", 450), week("2026-11-20", 600)],
    payoffs: [], debtFreeDate: null, curveThrough: "2027-02-08", ranOutOfTime: false, lastPaid: null,
  };
  if (has("topay2")) return { ...base, weeks: [week("2026-11-13", 450, TWO(250, 200)), week("2026-11-20", 600)] };
  if (has("paid2") || has("paidmulti") || has("paid1")) {
    const answered = { ...week("2026-11-13", 0, []), answered: true };
    const next = has("paid1") ? week("2026-11-20", 600) : week("2026-11-20", 600, TWO(350, 250));
    const lastPaid = has("paidmulti")
      ? { id: "rec-1", date: "2026-11-13", total: 450, undoable: true, targets: [{ ...CARD_A, amount: 250, linked: false, paidOff: true }, { ...CARD_B, amount: 200, linked: true, paidOff: false }] }
      : { id: "rec-1", date: "2026-11-13", total: 450, undoable: true, targets: [{ ...CARD_A, amount: 450, linked: has("paid1"), paidOff: false }] };
    return { ...base, weeks: [answered, next], lastPaid };
  }
  return base;
}

export const amexSummary = { purchases: { amount: null } };
export const recapPreview = { text: "Good morning. Checking has what this week needs." };
