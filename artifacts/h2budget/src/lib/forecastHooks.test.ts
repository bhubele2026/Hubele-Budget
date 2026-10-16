import { describe, it, expect } from "vitest";
import { hookCurveOf, hookLineOf, hookOwedStatus, hookPayoffsOf, hookPayoffWords, itemAmountWords, type HookPayoffLine } from "./forecastHooks";

// (WP8) The register's words for an everyday hook: display only.
const signal = {
  hookAmountIgnored: [{ itemId: "ws", cadence: "weekly" as const, storedAmount: "450.00" }],
  events: [
    { date: "2026-10-10", label: "Weekly Spend", amount: "-477.57", itemId: "ws", occurrenceKey: "ws|2026-10-10" },
    { date: "2026-10-17", label: "Weekly Spend", amount: "-450.00", itemId: "ws", occurrenceKey: "ws|2026-10-17" },
    // An overdue occurrence moved to the next business day keeps its occurrence key.
    { date: "2026-10-08", label: "Weekly Spend", amount: "-120.00", itemId: "ws", originalDate: "2026-09-26", assumption: "overdue_assumed_unpaid" },
    { date: "2026-10-12", label: "Mortgage", amount: "-1650.00", itemId: "mort", occurrenceKey: "mort|2026-10-12" },
  ],
  overdueAssumedPaid: [
    {
      planKey: "ws|2026-10-03", itemId: "ws", occurrenceDate: "2026-10-03", dueDate: "2026-10-03", label: "Weekly Spend",
      daysOverdue: 4, planAmount: "-120.00", txnId: "tx-pay", txnAmount: "-120.00", confidence: "card_payment", unpaidRemainder: "0.00",
    },
    {
      planKey: "mort|2026-10-01", itemId: "mort", occurrenceDate: "2026-10-01", dueDate: "2026-10-01", label: "Mortgage",
      daysOverdue: 6, planAmount: "-1650.00", txnId: "tx-mort", txnAmount: "-1650.00", confidence: "high", unpaidRemainder: "0.00",
    },
  ],
};

describe("hookPayoffsOf", () => {
  it("keys each hook occurrence by its plan key: the payoff, the plan, and the row that paid it", () => {
    const m = hookPayoffsOf(signal as never, (id) => (id === "tx-pay" ? "AMERICAN EXPRESS ACH PMT" : null));
    expect([...m.keys()].sort()).toEqual(["ws|2026-09-26", "ws|2026-10-03", "ws|2026-10-10", "ws|2026-10-17"]);
    expect(m.get("ws|2026-10-10")).toEqual({ planKey: "ws|2026-10-10", cadence: "weekly", plan: 450, payoff: 477.57, paidOnEvidence: null, basis: null, label: null, parts: null });
    expect(m.get("ws|2026-09-26")!.payoff).toBe(120);
    expect(m.get("ws|2026-10-03")).toMatchObject({ payoff: null, paidOnEvidence: { txnId: "tx-pay", amount: 120, description: "AMERICAN EXPRESS ACH PMT" } });
    // Not a hook: nothing.
    expect(m.has("mort|2026-10-12")).toBe(false);
    expect(m.has("mort|2026-10-01")).toBe(false);
  });

  it("no hooks, or no signal: empty", () => {
    expect(hookPayoffsOf(undefined).size).toBe(0);
    expect(hookPayoffsOf({ ...signal, hookAmountIgnored: undefined } as never).size).toBe(0);
  });
});

describe("hookPayoffWords", () => {
  it("the dashboard's words: card payoff and the plan; on evidence, the row; a row with no description says its amount", () => {
    const m = hookPayoffsOf(signal as never, (id) => (id === "tx-pay" ? "AMERICAN EXPRESS ACH PMT" : null));
    expect(hookPayoffWords(m.get("ws|2026-10-10")!)).toBe("card payoff $477.57 · plan $450");
    expect(hookPayoffWords(m.get("ws|2026-10-03")!)).toBe("paid on evidence by AMERICAN EXPRESS ACH PMT · plan $450");
    const unnamed = hookPayoffsOf(signal as never);
    expect(hookPayoffWords(unnamed.get("ws|2026-10-03")!)).toBe("paid on evidence by a $120.00 card payment · plan $450");
    expect(hookPayoffWords({ planKey: "k", cadence: "weekly", plan: 451.2, payoff: null, paidOnEvidence: null, basis: null, label: null, parts: null })).toBe("card payoff · plan $451.20");
  });
});

// (S2) "No weekly plan set": the forecast keeps the hook item's stored amount.
// It is a reserve, never a plan — the words must not say "plan $380".
const noPlanSignal = {
  // Every occurrence kept its stored amount, so the server lists no ignored hook.
  hookAmountIgnored: undefined,
  hookReserves: [
    { hook: "weekly" as const, recurringItemId: "ws", planKey: "ws|2026-10-10", occurrenceDate: "2026-10-10", label: "Weekly Spend", amount: "380.00", basis: "stored_amount" as const },
    { hook: "weekly" as const, recurringItemId: "ws", planKey: "ws|2026-10-17", occurrenceDate: "2026-10-17", label: "Weekly Spend", amount: "380.00", basis: "stored_amount" as const },
  ],
  events: [
    { date: "2026-10-15", label: "Weekly Spend", amount: "-380.00", itemId: "ws", occurrenceKey: "ws|2026-10-10", assumption: "overdue_assumed_unpaid" },
    { date: "2026-10-17", label: "Weekly Spend", amount: "-380.00", itemId: "ws", occurrenceKey: "ws|2026-10-17" },
    { date: "2026-10-12", label: "Mortgage", amount: "-1650.00", itemId: "mort", occurrenceKey: "mort|2026-10-12" },
  ],
  overdueAssumedPaid: [],
};

// A plan set from this week: last week (no plan then) keeps the stored reserve; this week is the payoff.
const mixedSignal = {
  hookAmountIgnored: [{ itemId: "ws", cadence: "weekly" as const, storedAmount: "380.00" }],
  hookReserves: [
    { hook: "weekly" as const, recurringItemId: "ws", planKey: "ws|2026-10-10", occurrenceDate: "2026-10-10", label: "Weekly Spend", amount: "380.00", basis: "stored_amount" as const },
    { hook: "weekly" as const, recurringItemId: "ws", planKey: "ws|2026-10-17", occurrenceDate: "2026-10-17", label: "Weekly Spend", amount: "355.00", basis: "plan" as const },
  ],
  events: [
    { date: "2026-10-15", label: "Weekly Spend", amount: "-380.00", itemId: "ws", occurrenceKey: "ws|2026-10-10", assumption: "overdue_assumed_unpaid" },
    { date: "2026-10-17", label: "Weekly Spend", amount: "-355.00", itemId: "ws", occurrenceKey: "ws|2026-10-17" },
  ],
  overdueAssumedPaid: [],
};

describe("(S2) the reserve when no plan is set", () => {
  it("no plan: every occurrence reads 'Assumed $380 · no weekly plan set' — never 'plan $380'", () => {
    const m = hookPayoffsOf(noPlanSignal as never);
    expect([...m.keys()].sort()).toEqual(["ws|2026-10-10", "ws|2026-10-17"]);
    expect(m.get("ws|2026-10-17")).toEqual({
      planKey: "ws|2026-10-17", cadence: "weekly", plan: 380, payoff: 380, paidOnEvidence: null, basis: "stored_amount", label: "Weekly Spend", parts: null,
      // (C5) No plan for this week or a later one: the row may offer "Set a weekly plan →".
      planLink: "week",
    });
    expect(hookPayoffWords(m.get("ws|2026-10-17")!)).toBe("Assumed $380 · no weekly plan set");
    // (C4) Dragged to the next business day: it names its own week and the day the forecast takes it.
    expect(hookPayoffWords(m.get("ws|2026-10-10")!)).toBe("Weekly Spend of Oct 10, due Oct 15: assumed $380 · no weekly plan set");
    for (const k of ["ws|2026-10-10", "ws|2026-10-17"]) expect(hookPayoffWords(m.get(k)!)).not.toContain("plan $");
    expect(m.has("mort|2026-10-12")).toBe(false);
  });

  it("a plan from this week: this week keeps 'card payoff $X · plan $Y'; last week still says the reserve", () => {
    const m = hookPayoffsOf(mixedSignal as never);
    expect(hookPayoffWords(m.get("ws|2026-10-17")!)).toBe("card payoff $355.00 · plan $380");
    expect(hookPayoffWords(m.get("ws|2026-10-10")!)).toBe("Weekly Spend of Oct 10, due Oct 15: assumed $380 · no weekly plan set");
    // (C5) A plan is set from this week: last week's reserve offers no "Set a weekly plan".
    expect(m.get("ws|2026-10-10")!.planLink).toBeUndefined();
  });

  it("a monthly hook says 'no monthly plan set'; one paid on evidence names the row and that no plan is set", () => {
    expect(
      hookPayoffWords({ planKey: "ms|2026-10-31", cadence: "monthly", plan: 900, payoff: 900, paidOnEvidence: null, basis: "stored_amount", label: "Monthly Spend", parts: null }),
    ).toBe("Assumed $900 · no monthly plan set");
    expect(
      hookPayoffWords({
        planKey: "ws|2026-10-03", cadence: "weekly", plan: 380, payoff: null, basis: "stored_amount", label: "Weekly Spend", parts: null,
        paidOnEvidence: { txnId: "t", amount: 380, description: "AMEX EPAYMENT" },
      }),
    ).toBe("paid on evidence by AMEX EPAYMENT · no weekly plan set");
  });

  it("(F1, C4) a closed no-plan week reserves its card purchases ($120), not the stored $380: the words say the $120 the forecast takes, never 'reserve $380'", () => {
    const f1 = {
      ...noPlanSignal,
      hookReserves: [
        { ...noPlanSignal.hookReserves[0]!, amount: "120.00", storedAmount: "380.00" },
        { ...noPlanSignal.hookReserves[1]!, storedAmount: "380.00" },
      ],
      events: [{ ...noPlanSignal.events[0]!, amount: "-120.00" }, noPlanSignal.events[1]!],
    };
    const m = hookPayoffsOf(f1 as never);
    expect(m.get("ws|2026-10-10")).toMatchObject({ plan: 380, payoff: 120, basis: "stored_amount" });
    // Before C4: "Weekly Spend reserve $380 · no weekly plan set" over a $120 curve event.
    expect(hookPayoffWords(m.get("ws|2026-10-10")!)).toBe("Weekly Spend of Oct 10, due Oct 15: $120.00 on the forecast · no weekly plan set");
  });

  it("a signal without hookReserves (an older server) reads as before", () => {
    const m = hookPayoffsOf({ ...signal, hookReserves: undefined } as never);
    expect(hookPayoffWords(m.get("ws|2026-10-10")!)).toBe("card payoff $477.57 · plan $450");
  });
});

describe("(F4) the reserve says what it is made of", () => {
  const planSignal = {
    hookAmountIgnored: [{ itemId: "ws", cadence: "weekly" as const, storedAmount: "450.00" }],
    hookReserves: [
      { hook: "weekly" as const, recurringItemId: "ws", planKey: "ws|2026-10-17", occurrenceDate: "2026-10-17", label: "Weekly Spend", amount: "240.00", basis: "plan" as const, incurred: "120.00", carried: "0.00", allowanceLeft: "120.00", paid: "0.00" },
      { hook: "weekly" as const, recurringItemId: "ws", planKey: "ws|2026-10-10", occurrenceDate: "2026-10-10", label: "Weekly Spend", amount: "290.00", basis: "plan" as const, incurred: "240.00", carried: "50.00", allowanceLeft: "0.00", paid: "0.00" },
    ],
    events: [
      { date: "2026-10-17", label: "Weekly Spend", amount: "-240.00", itemId: "ws", occurrenceKey: "ws|2026-10-17" },
      { date: "2026-10-15", label: "Weekly Spend", amount: "-290.00", itemId: "ws", occurrenceKey: "ws|2026-10-10" },
    ],
    overdueAssumedPaid: [],
  };
  it("card purchases + left to spend; carried only when there is some", () => {
    const m = hookPayoffsOf(planSignal as never);
    expect(hookPayoffWords(m.get("ws|2026-10-17")!)).toBe("Weekly Spend: card purchases $120.00 + left to spend $120.00");
    expect(hookPayoffWords(m.get("ws|2026-10-10")!)).toBe("Weekly Spend of Oct 10, due Oct 15: card purchases $240.00 (+ carried $50.00) + left to spend $0.00");
  });
});

// ⭐ (F5 round 2) The words never hide a card week that is still owed.
describe("(F5) a carried or part-paid week says so", () => {
  const base = { cadence: "weekly" as const, plan: 300, basis: "stored_amount" as const, label: "Weekly Spend", parts: null };
  it("carried on: 'card purchases carried to <day>'; status carried", () => {
    const line = { ...base, planKey: "ws|2026-10-03", payoff: null, paidOnEvidence: null, carriedTo: "2026-10-15", left: 0 };
    expect(hookPayoffWords(line)).toBe("card purchases carried to Oct 15");
    expect(hookOwedStatus(line)).toBe("carried");
  });
  it("paid in part, the rest on the forecast: 'part paid by <row> · $X still owed'", () => {
    const line = { ...base, planKey: "ws|2026-10-10", payoff: 210, paidOnEvidence: { txnId: "t", amount: 30, description: "AMERICAN EXPRESS" }, left: 0 };
    expect(hookPayoffWords(line)).toBe("part paid by AMERICAN EXPRESS · $210.00 still owed");
    expect(hookOwedStatus(line)).toBe("still_owed");
  });
  it("a closed (or answered) week with nothing left to spend holds card purchases, never 'reserve $300'", () => {
    expect(hookPayoffWords({ ...base, planKey: "ws|2026-10-10", payoff: 180, paidOnEvidence: null, left: 0 })).toBe("card purchases $180.00 still owed");
    // The open week keeps the reserve words.
    expect(hookPayoffWords({ ...base, planKey: "ws|2026-10-17", payoff: 300, paidOnEvidence: null, left: 210 })).toBe("Assumed $300 · no weekly plan set");
    expect(hookOwedStatus(null)).toBe(null);
    expect(hookOwedStatus({ ...base, planKey: "k", payoff: null, paidOnEvidence: null })).toBe(null);
  });
  it("hookPayoffsOf places a carried week by its carrier's curve event; a carried week with no event still gets a line", () => {
    const m = hookPayoffsOf({
      hookReserves: [
        { hook: "weekly", recurringItemId: "ws", planKey: "ws|2026-10-03", occurrenceDate: "2026-10-03", label: "Weekly Spend", amount: "0.00", basis: "stored_amount", allowanceLeft: "0.00", carriedTo: "2026-10-10" },
        { hook: "weekly", recurringItemId: "ws", planKey: "ws|2026-10-10", occurrenceDate: "2026-10-10", label: "Weekly Spend", amount: "270.00", basis: "stored_amount", allowanceLeft: "0.00" },
      ],
      events: [{ date: "2026-10-15", label: "Weekly Spend", amount: "-270.00", itemId: "ws", originalDate: "2026-10-10" }],
      overdueAssumedPaid: [],
    } as never);
    expect(m.get("ws|2026-10-03")).toMatchObject({ carriedTo: "2026-10-15", payoff: null, left: 0 });
    expect(m.get("ws|2026-10-10")).toMatchObject({ payoff: 270, left: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⭐ (C4) THE MONTHLY SPEND ROW'S WORDS TIE TO ITS AMOUNT. Synthetic figures.
// A monthly hook on the 1st, a $620 monthly plan, the item's stored amount $400.
// Every occurrence's curve event = card purchases + carried + left to spend:
// the words print exactly those parts. (Task 4, D) A partial answer on a hook is
// read as not given (the ledger's rule), so November's curve event is its whole
// reserve and the words name no partial; the register's row shows the curve's figure.
const MS = "ms";
const reserveOf = (date: string, r: Record<string, string | null>) => ({
  hook: "monthly" as const, recurringItemId: MS, planKey: `${MS}|${date}`, occurrenceDate: date, label: "Monthly Spend",
  basis: "plan" as const, storedAmount: "400.00", paid: "0.00", carried: "0.00", carriedFrom: [], carriedTo: null, cards: [], ...r,
});
const novGap = {
  fromDate: "2026-10-14",
  hookAmountIgnored: [{ itemId: MS, cadence: "monthly" as const, storedAmount: "400.00" }],
  hookReserves: [
    // October's: moved by the household to Nov 1 (rescheduled); its own month's parts.
    reserveOf("2026-10-01", { amount: "574.50", incurred: "75.00", allowanceLeft: "499.50" }),
    // November's own (a legacy "partial" answer on it is read as not given).
    reserveOf("2026-11-01", { amount: "620.00", incurred: "0.00", allowanceLeft: "620.00" }),
  ],
  events: [
    { date: "2026-11-01", label: "Monthly Spend", amount: "-574.50", itemId: MS, originalDate: "2026-11-01", occurrenceKey: `${MS}|2026-10-01`, occurrenceDate: "2026-10-01" },
    { date: "2026-11-01", label: "Monthly Spend", amount: "-620.00", itemId: MS, originalDate: "2026-11-01", occurrenceKey: `${MS}|2026-11-01`, occurrenceDate: "2026-11-01" },
  ],
  overdueAssumedPaid: [],
};
// The register's two rows on Nov 1, as `buildLineRegister` builds them with `hookCurveOf`: the curve's figures.
const novRows = [
  { itemId: MS, date: "2026-11-01", originalDate: "2026-10-01", status: "future", amount: -574.5 },
  { itemId: MS, date: "2026-11-01", status: "future", amount: -620 },
];

describe("(C4) the Nov 1 Monthly Spend rows: words = amount", () => {
  it("(b) a moved row reads ITS OWN occurrence's reserve and names its period — never the reserve of the day it is shown on", () => {
    const m = hookPayoffsOf(novGap as never);
    const october = hookLineOf(m, novRows[0]!)!;
    expect(october.planKey).toBe(`${MS}|2026-10-01`);
    expect(october.payoff).toBe(574.5);
    // (Task 4, D) The row shows the forecast's $574.50: the words are its parts, nothing more.
    expect(hookPayoffWords(october, { face: 574.5 })).toBe(
      "October's Monthly Spend, due Nov 1: card purchases $75.00 + left to spend $499.50",
    );
    // A caller that shows another figure (the Missed list's record) still hears what the forecast takes — never "(item amount … not used)".
    expect(hookPayoffWords(october, { face: 400 })).toBe(
      "October's Monthly Spend, due Nov 1: card purchases $75.00 + left to spend $499.50 = $574.50 on the forecast",
    );
    // Before C4 the row was looked up by its shown day — November's reserve: "$0.00 + $620.00" over October's −$574.50.
    expect(hookPayoffWords(m.get(`${MS}|2026-11-01`)!)).not.toContain("$574.50");
  });

  it("(a, Task 4) a legacy partial answer is never named: November's words are its whole reserve — the curve's figure", () => {
    const m = hookPayoffsOf(novGap as never, () => "AMEX EPAYMENT ACH PMT");
    const november = hookLineOf(m, novRows[1]!)!;
    expect(november.payoff).toBe(620);
    expect(november).not.toHaveProperty("partial");
    expect(hookPayoffWords(november, { face: 620 })).toBe("Monthly Spend: card purchases $0.00 + left to spend $620.00");
    expect(hookPayoffWords(november, { face: 620 })).not.toMatch(/paid by|still owed|item amount/);
  });

  it("(c) no plan: paid, carried and the card's balance are named; the parts add up to the curve event, never 'reserve $300' over $260", () => {
    const sig = {
      fromDate: "2026-10-14",
      hookReserves: [
        { hook: "weekly", recurringItemId: "ws", planKey: "ws|2026-10-17", occurrenceDate: "2026-10-17", label: "Weekly Spend", basis: "stored_amount",
          storedAmount: "300.00", amount: "300.00", incurred: "50.00", paid: "40.00", carried: "0.00", allowanceLeft: "210.00", carriedTo: null },
        { hook: "weekly", recurringItemId: "ws", planKey: "ws|2026-10-24", occurrenceDate: "2026-10-24", label: "Weekly Spend", basis: "stored_amount",
          storedAmount: "300.00", amount: "300.00", incurred: "0.00", paid: "0.00", carried: "35.00", allowanceLeft: "300.00", carriedTo: null, cappedByBalance: "12.00" },
      ],
      events: [
        { date: "2026-10-17", label: "Weekly Spend", amount: "-260.00", itemId: "ws", occurrenceKey: "ws|2026-10-17" },
        { date: "2026-10-24", label: "Weekly Spend", amount: "-335.00", itemId: "ws", occurrenceKey: "ws|2026-10-24" },
      ],
      overdueAssumedPaid: [],
    };
    const m = hookPayoffsOf(sig as never);
    // (Task 4, D) The row shows the curve's $260 / $335 — the parts and the named payments, no "= … on the forecast".
    expect(hookPayoffWords(m.get("ws|2026-10-17")!, { face: 260 })).toBe(
      "Weekly Spend reserve: card purchases $50.00 + left to spend $210.00 · $40.00 already paid · no weekly plan set",
    );
    expect(hookPayoffWords(m.get("ws|2026-10-24")!, { face: 335 })).toBe(
      "Weekly Spend reserve: card purchases $0.00 (+ carried $35.00) + left to spend $300.00 · $12.00 paid per the card's balance · no weekly plan set",
    );
    // Shown at the stored $300, the words add what the forecast takes.
    expect(hookPayoffWords(m.get("ws|2026-10-17")!, { face: 300 })).toBe(
      "Weekly Spend reserve: card purchases $50.00 + left to spend $210.00 = $260.00 on the forecast · $40.00 already paid · no weekly plan set",
    );
  });

  it("(d, Task 4) the item's stored amount is never in the words; it is said once, behind the row's Details, as a template", () => {
    const sig = {
      hookAmountIgnored: [{ itemId: MS, cadence: "monthly", storedAmount: "400.00" }],
      hookReserves: [reserveOf("2026-10-28", { amount: "30.80", incurred: "0.00", allowanceLeft: "30.80" })],
      events: [{ date: "2026-10-28", label: "Monthly Spend", amount: "-30.80", itemId: MS, occurrenceKey: `${MS}|2026-10-28` }],
      overdueAssumedPaid: [],
    };
    const line = hookPayoffsOf(sig as never).get(`${MS}|2026-10-28`)!;
    expect(hookPayoffWords(line, { face: 30.8 })).toBe("Monthly Spend: card purchases $0.00 + left to spend $30.80");
    expect(hookPayoffWords(line, { face: 400 })).toBe("Monthly Spend: card purchases $0.00 + left to spend $30.80 = $30.80 on the forecast");
    expect(itemAmountWords(line, -400)).toBe("Item amount $400 — a template; the forecast uses the monthly plan");
    expect(itemAmountWords(line, -437.15)).toBe("Item amount $437.15 — a template; the forecast uses the monthly plan");
    // No plan: the item's amount IS the reserve — no template note.
    const noPlan = hookPayoffsOf({ ...sig, hookAmountIgnored: undefined, hookReserves: [reserveOf("2026-10-28", { amount: "400.00", basis: "stored_amount", incurred: "0.00", allowanceLeft: "400.00" })], events: [{ ...sig.events[0]!, amount: "-400.00" }] } as never).get(`${MS}|2026-10-28`)!;
    expect(itemAmountWords(noPlan, -400)).toBeNull();
    expect(itemAmountWords(undefined, -400)).toBeNull();
  });

  it("the guard: server parts that do not add up to the curve event are never printed", () => {
    const line: HookPayoffLine = {
      planKey: `${MS}|2026-11-01`, cadence: "monthly", plan: 400, payoff: 440, paidOnEvidence: null, basis: "plan", label: "Monthly Spend",
      parts: { incurred: "0.00", carried: "0.00", left: "500.00" },
    };
    expect(hookPayoffWords(line, { face: 440 })).toBe("Monthly Spend: $440.00 on the forecast");
    expect(hookPayoffWords(line, { face: 400 })).toBe("Monthly Spend: $440.00 on the forecast");
  });
});

// (Task 4, E's words) A no-plan row the forecast holds at the item's stored amount: "Assumed $X · no <cadence> plan set".
describe("(Task 4) the no-plan row says what the forecast assumes", () => {
  it("weekly $450 and monthly $425.50 (the item's stored amount, formatted as before)", () => {
    const sig = {
      hookReserves: [
        { hook: "weekly", recurringItemId: "ws", planKey: "ws|2026-10-17", occurrenceDate: "2026-10-17", label: "Weekly Spend", basis: "stored_amount", storedAmount: "450.00", amount: "450.00" },
        { hook: "monthly", recurringItemId: "ms", planKey: "ms|2026-11-01", occurrenceDate: "2026-11-01", label: "Monthly Spend", basis: "stored_amount", storedAmount: "425.50", amount: "425.50" },
      ],
      events: [
        { date: "2026-10-17", label: "Weekly Spend", amount: "-450.00", itemId: "ws", occurrenceKey: "ws|2026-10-17" },
        { date: "2026-11-01", label: "Monthly Spend", amount: "-425.50", itemId: "ms", occurrenceKey: "ms|2026-11-01" },
      ],
      overdueAssumedPaid: [],
    };
    const m = hookPayoffsOf(sig as never);
    expect(hookPayoffWords(m.get("ws|2026-10-17")!, { face: 450 })).toBe("Assumed $450 · no weekly plan set");
    expect(hookPayoffWords(m.get("ms|2026-11-01")!, { face: 425.5 })).toBe("Assumed $425.50 · no monthly plan set");
  });
});

// ⭐ (Task 4, D) THE REGISTER'S FIGURE FOR EACH HOOK OCCURRENCE: the curve's, by the occurrence's own key.
describe("(Task 4) hookCurveOf — what the forecast takes, by occurrence key", () => {
  it("sums each occurrence's events (a moved or dragged one under its own key); only hook items; none without hooks", () => {
    const sig = {
      ...novGap,
      events: [
        ...novGap.events,
        // September's, dragged to the next business day: its own key, a later date.
        { date: "2026-10-15", label: "Monthly Spend", amount: "-120.00", itemId: MS, originalDate: "2026-09-01", occurrenceKey: `${MS}|2026-09-01`, occurrenceDate: "2026-09-01", assumption: "overdue_assumed_unpaid" },
        { date: "2026-11-01", label: "Mortgage", amount: "-1650.00", itemId: "mort", occurrenceKey: "mort|2026-11-01" },
      ],
    };
    const c = hookCurveOf(sig as never)!;
    expect([...c.items]).toEqual([MS]);
    expect(Object.fromEntries(c.amountByKey)).toEqual({ [`${MS}|2026-10-01`]: -574.5, [`${MS}|2026-11-01`]: -620, [`${MS}|2026-09-01`]: -120 });
    expect(hookCurveOf(undefined)).toBeNull();
    expect(hookCurveOf({ events: sig.events } as never)).toBeNull();
    // A hook with every occurrence off the curve: known items, no figures.
    expect(hookCurveOf({ ...novGap, events: [] } as never)!.amountByKey.size).toBe(0);
  });
});

// ⭐ (C4) THE PROPERTY: for every hook row, the amount the forecast takes equals
// the sum of the parts the words print, and a row whose own figure differs says
// the forecast's. Generated synthetic signals in the server's shape: curve =
// incurred + carried + left. (Task 4, D) No partial: the ledger never reads one on a hook.
describe("(C4) property — every hook row's words add up to its amount", () => {
  // A small deterministic generator (no Math.random: the cases are the same every run).
  let seed = 20261016;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const d$ = (c: number) => (c / 100).toFixed(2);
  const money = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
  const grab = (w: string, re: RegExp) => {
    const m = w.match(re);
    return m ? money(m[1]!) : null;
  };
  const shortDay = (iso: string) => `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

  it("500 generated occurrences: plan / no plan, carried, paid, capped, moved, dragged, row amount = the curve's or not", () => {
    let checked = 0;
    for (let n = 0; n < 500; n += 1) {
      const weekly = rnd(2) === 0;
      const id = weekly ? "ws" : "ms";
      const occ = weekly ? `2026-10-${String(3 + 7 * rnd(4)).padStart(2, "0")}` : `2026-${["09", "10", "11", "12"][rnd(4)]}-01`;
      const basis = rnd(2) === 0 ? "plan" : "stored_amount";
      const stored = (1 + rnd(80)) * 1000;
      const I = rnd(4) === 0 ? 0 : rnd(60000);
      const C = rnd(3) === 0 ? rnd(20000) : 0;
      // No plan: left is what is left of the stored reserve (the server's rule); with a plan, any.
      const L = basis === "stored_amount" ? Math.max(0, stored - I - (rnd(2) ? rnd(5000) : 0)) : rnd(70000);
      const paid = rnd(3) === 0 ? 1 + rnd(30000) : 0;
      const capped = rnd(5) === 0 ? 1 + rnd(9000) : 0;
      const T = I + C + L;
      if (T <= 0) continue;
      const due = rnd(3) === 0 ? "2026-11-02" : occ;
      const sig = {
        fromDate: "2026-10-14",
        hookAmountIgnored: basis === "plan" ? [{ itemId: id, cadence: weekly ? "weekly" : "monthly", storedAmount: d$(stored) }] : undefined,
        hookReserves: [
          {
            hook: weekly ? "weekly" : "monthly", recurringItemId: id, planKey: `${id}|${occ}`, occurrenceDate: occ, label: weekly ? "Weekly Spend" : "Monthly Spend",
            basis, storedAmount: d$(stored), amount: d$(T + paid), incurred: d$(I), paid: d$(paid), carried: d$(C), allowanceLeft: d$(L), carriedTo: null,
            ...(capped ? { cappedByBalance: d$(capped) } : {}),
          },
        ],
        events: [{ date: due, label: "x", amount: `-${d$(T)}`, itemId: id, occurrenceKey: `${id}|${occ}`, occurrenceDate: occ, originalDate: due }],
        overdueAssumedPaid: [],
      };
      const row = { itemId: id, date: due, ...(due !== occ ? { originalDate: occ } : {}) };
      const m = hookPayoffsOf(sig as never, () => "CHECKING ROW");
      const line = hookLineOf(m, row);
      expect(line, `case ${n}`).toBeDefined();
      // ⭐ The register's own figure for the row is the curve's (`hookCurveOf`).
      expect(hookCurveOf(sig as never)!.amountByKey.get(`${id}|${occ}`), `case ${n}`).toBe(-T / 100);
      const face = rnd(3) === 0 ? stored / 100 : T / 100;
      const w = hookPayoffWords(line!, { face });
      const X = grab(w, /card purchases (\$[\d,.]+)(?! still)/);
      const Cw = grab(w, /\(\+ carried (\$[\d,.]+)\)/) ?? 0;
      const Lw = grab(w, /left to spend (\$[\d,.]+)/);
      const owed = grab(w, /(\$[\d,.]+) still owed/);
      const onForecast = grab(w, /(\$[\d,.]+) on the forecast/);
      const reserve = grab(w, /[Aa]ssumed (\$[\d,.]+)/);
      if (X != null && Lw != null) {
        // The additive parts are the amount.
        expect(X + Cw + Lw, `case ${n}: ${w}`).toBe(T);
      } else if (owed != null) expect(owed, `case ${n}: ${w}`).toBe(T);
      else if (onForecast != null) expect(onForecast, `case ${n}: ${w}`).toBe(T);
      else expect(reserve, `case ${n}: ${w}`).toBe(T);
      // The stored amount is never named; a row whose own figure is not the amount says the amount.
      expect(w, `case ${n}`).not.toMatch(/item amount|not used|paid by CHECKING ROW/);
      if (Math.round(face * 100) !== T) expect(owed === T || onForecast === T || reserve === T, `case ${n}: ${w}`).toBe(true);
      // Moved or dragged: it names the day the forecast takes it.
      if (due !== occ) expect(w, `case ${n}`).toContain(`due ${shortDay(due)}`);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(400);
  });
});
