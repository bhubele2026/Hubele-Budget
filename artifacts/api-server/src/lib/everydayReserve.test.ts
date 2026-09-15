// (PR8r) Pure tests for the everyday reserve (`@workspace/avalanche-core`:
// `everydayPeriod.ts`, `everydayReserve.ts`) — the payoff periods, the
// everyday-spend rule, the Amex payment test and the payoff builder — and the
// "never reads high" property test against an independent simulation. No DB;
// colocated like `householdMoney.test.ts`, so it gates every push.
//
// Synthetic amounts and merchants only.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  buildPayoffs,
  dayOfWeekISO,
  everydayPeriodOf,
  everydayPeriodsPaidBetween,
  everydayRowFacts,
  isAmexPayoffPayment,
  nextBusinessDayISO,
  payoffMatchToleranceCents,
  periodSpend,
  PFC_CARD_PAYMENT,
  type BuildPayoffsInput,
  type EverydayBucket,
  type EverydayCadence,
  type EverydayPeriod,
  type EverydaySpendRow,
  type MovementContext,
  type MovementRow,
  type PayoffPayment,
  type PayoffPeriodInput,
  type PayoffResolution,
} from "@workspace/avalanche-core";

describe("everydayPeriod — the payoff calendar", () => {
  it("a week runs Sunday–Saturday and is paid on its Saturday", () => {
    expect(everydayPeriodOf("weekly", "2026-09-11")).toEqual({
      cadence: "weekly",
      start: "2026-09-06",
      end: "2026-09-12",
      payoffDate: "2026-09-12",
    });
    expect(everydayPeriodOf("weekly", "2026-09-06").start).toBe("2026-09-06");
    expect(everydayPeriodOf("weekly", "2026-09-12").end).toBe("2026-09-12");
    expect(everydayPeriodOf("weekly", "2026-09-13").start).toBe("2026-09-13");
  });

  it("a month is paid on the 1st of the next month, December into January", () => {
    expect(everydayPeriodOf("monthly", "2026-09-11")).toEqual({
      cadence: "monthly",
      start: "2026-09-01",
      end: "2026-09-30",
      payoffDate: "2026-10-01",
    });
    expect(everydayPeriodOf("monthly", "2026-12-31").payoffDate).toBe("2027-01-01");
    expect(everydayPeriodOf("monthly", "2026-02-10").end).toBe("2026-02-28");
  });

  it("the periods paid between two dates, both ends inclusive, in order", () => {
    expect(everydayPeriodsPaidBetween("weekly", "2026-09-12", "2026-09-26").map((p) => p.payoffDate)).toEqual([
      "2026-09-12",
      "2026-09-19",
      "2026-09-26",
    ]);
    expect(everydayPeriodsPaidBetween("weekly", "2026-09-13", "2026-09-18")).toEqual([]);
    expect(everydayPeriodsPaidBetween("monthly", "2026-09-01", "2026-11-01").map((p) => p.start)).toEqual([
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(everydayPeriodsPaidBetween("monthly", "2026-09-02", "2026-09-30")).toEqual([]);
    expect(everydayPeriodsPaidBetween("weekly", "2026-09-20", "2026-09-10")).toEqual([]);
  });

  it("the next business day skips the weekend", () => {
    expect(nextBusinessDayISO("2026-09-11")).toBe("2026-09-14"); // Fri → Mon
    expect(nextBusinessDayISO("2026-09-12")).toBe("2026-09-14"); // Sat → Mon
    expect(nextBusinessDayISO("2026-09-13")).toBe("2026-09-14"); // Sun → Mon
    expect(nextBusinessDayISO("2026-09-14")).toBe("2026-09-15"); // Mon → Tue
  });
});

const CHECKING = "chk-ext";

function ctx(overrides: Partial<MovementContext> = {}): MovementContext {
  return {
    categoriesById: new Map([["groc", { name: "Groceries", debtId: null, kind: "expense" }]]),
    debtCategoryIds: new Set(),
    checkingAccountExternalId: CHECKING,
    matchedTxnIds: new Set(),
    ...overrides,
  };
}

function row(overrides: Partial<MovementRow> = {}): MovementRow {
  return {
    id: "t1",
    occurredOn: "2026-09-08",
    amount: "-42.00",
    source: "plaid:chase",
    isTransfer: false,
    categoryId: "groc",
    description: "GREEN GROCER",
    debtId: null,
    isExternalCardPayment: false,
    reimbursable: false,
    pfcDetailed: null,
    plaidAccountId: CHECKING,
    unplannedAllowance: false,
    monthlyAllowance: false,
    weeklyAllowance: false,
    ...overrides,
  };
}

describe("everydayRowFacts — which plan a row uses up", () => {
  it("its flag: unplanned over monthly over weekly", () => {
    expect(everydayRowFacts(row({ weeklyAllowance: true }), ctx())).toMatchObject({ bucket: "weekly", spendCents: 4200 });
    expect(everydayRowFacts(row({ monthlyAllowance: true, weeklyAllowance: true }), ctx()).bucket).toBe("monthly");
    expect(everydayRowFacts(row({ unplannedAllowance: true, monthlyAllowance: true }), ctx()).bucket).toBe("unplanned");
  });

  it("a flagged row keeps today's allowance screens: transfer, card-payment flag, reimbursable, debt tag", () => {
    for (const screen of [
      { isTransfer: true },
      { isExternalCardPayment: true },
      { reimbursable: true },
      { debtId: "debt-1" },
    ]) {
      expect(everydayRowFacts(row({ weeklyAllowance: true, ...screen }), ctx()).bucket, JSON.stringify(screen)).toBeNull();
    }
  });

  it("⚠️ owner question open: a flagged row is never newly dropped by a bank-noise description", () => {
    for (const description of ["PLANET FITNESS AUTOPAY", "REPAY *PEST CONTROL", "CITY WATER WEB ID: 4417", "ACH PMT RIVERSIDE GYM"]) {
      const facts = everydayRowFacts(row({ description, weeklyAllowance: true }), ctx());
      expect(facts.bucket, description).toBe("weekly");
      // The one spending rule would have dropped it.
      expect(facts.movement.coverage, description).toBe("transfer");
    }
  });

  it("decision 12: a confirmed match uses up no plan, and says which flag it beat", () => {
    const matched = ctx({ matchedTxnIds: new Set(["t1"]) });
    expect(everydayRowFacts(row({ weeklyAllowance: true }), matched)).toMatchObject({
      bucket: null,
      billMatched: { conflict: "flag_ignored_matched" },
    });
    expect(everydayRowFacts(row({ monthlyAllowance: true }), matched).billMatched).toEqual({ conflict: "flag_ignored_matched" });
    expect(everydayRowFacts(row({ unplannedAllowance: true, weeklyAllowance: true }), matched).billMatched).toEqual({
      conflict: "unplanned_on_matched",
    });
    expect(everydayRowFacts(row(), matched)).toMatchObject({ bucket: null, billMatched: { conflict: null } });
  });

  it("an unflagged row: needs classification uses up the weekly plan provisionally; nothing else does", () => {
    expect(everydayRowFacts(row(), ctx())).toMatchObject({ bucket: "weekly", viaNeedsClassification: true, billMatched: null });
    expect(everydayRowFacts(row(), ctx({ tier2PairedTxnIds: new Set(["t1"]) }))).toMatchObject({ bucket: null, billMatched: null });
    expect(everydayRowFacts(row({ reimbursable: true }), ctx()).bucket).toBeNull();
    expect(everydayRowFacts(row({ description: "ONLINE TRANSFER TO SAV 9" }), ctx()).bucket).toBeNull();
    expect(everydayRowFacts(row({ amount: "12.00" }), ctx())).toMatchObject({ bucket: null, spendCents: 0 });
  });

  it("a tier-2 pair never overrides a flag", () => {
    expect(everydayRowFacts(row({ weeklyAllowance: true }), ctx({ tier2PairedTxnIds: new Set(["t1"]) })).bucket).toBe("weekly");
  });

  it("a workbook Amex charge is a positive amount; a card row spends like any other", () => {
    expect(everydayRowFacts(row({ source: "amex", plaidAccountId: null, amount: "30.25", weeklyAllowance: true }), ctx())).toMatchObject({
      bucket: "weekly",
      spendCents: 3025,
    });
  });
});

describe("periodSpend", () => {
  const WEEK = everydayPeriodOf("weekly", "2026-09-11");
  const MONTH = everydayPeriodOf("monthly", "2026-09-11");
  const spend = (occurredOn: string, bucket: EverydayBucket | null, spendCents: number, covered = true, viaNeedsClassification = false): EverydaySpendRow => ({
    occurredOn,
    bucket,
    spendCents,
    covered,
    viaNeedsClassification,
  });
  const rows = [
    spend("2026-09-08", "weekly", 12_000),
    spend("2026-09-11", "weekly", 4_000),
    spend("2026-09-10", "weekly", 2_500, false),
    spend("2026-09-09", "weekly", 1_000, true, true),
    spend("2026-09-10", "unplanned", 6_000),
    spend("2026-09-05", "weekly", 9_900), // last week
    spend("2026-09-02", "monthly", 7_000),
    spend("2026-09-12", "monthly", 3_000, false),
  ];

  it("a week: its own plan's rows, the covered part, and unplanned and needs classification beside them", () => {
    expect(periodSpend(WEEK, rows)).toEqual({
      spentCents: 19_500,
      coveredSpentCents: 17_000,
      unplannedCents: 6_000,
      needsClassificationCents: 1_000,
    });
  });

  it("a month: the monthly plan's rows dated in it", () => {
    expect(periodSpend(MONTH, rows)).toEqual({
      spentCents: 10_000,
      coveredSpentCents: 7_000,
      unplannedCents: 6_000,
      needsClassificationCents: 1_000,
    });
  });
});

describe("isAmexPayoffPayment — a payment to American Express", () => {
  const pay = (description: string | null, amount: number | string = -120, extra: Partial<Parameters<typeof isAmexPayoffPayment>[0]> = {}) =>
    isAmexPayoffPayment({ amount, description, isExternalCardPayment: false, pfcDetailed: null, debtId: null, ...extra });

  it("issuer phrases and ACH payment boilerplate naming Amex", () => {
    expect(pay("AMERICAN EXPRESS ACH PMT W4419")).toBe(true);
    expect(pay("AMEX EPAYMENT ACH PMT")).toBe(true);
    expect(pay("AMEX DES:ACH PMT ID:991")).toBe(true);
    expect(pay("AMEX", "-120.00", { isExternalCardPayment: true })).toBe(true);
    expect(pay("AMERICAN EXPRESS", -120, { pfcDetailed: PFC_CARD_PAYMENT })).toBe(true);
  });

  it("never a purchase, a deposit, a debt-tagged row, or a payment to someone else", () => {
    expect(pay("AMERICAN EXPRESS TRAVEL")).toBe(false);
    expect(pay("AMERICAN EXPRESS ACH PMT", 120)).toBe(false);
    expect(pay("AMERICAN EXPRESS ACH PMT", -120, { debtId: "debt-sky" })).toBe(false);
    expect(pay("CAPITAL ONE MOBILE PYMT")).toBe(false);
    expect(pay("CAMEX SUPPLY ACH PMT")).toBe(false);
    expect(pay(null)).toBe(false);
  });
});

describe("buildPayoffs — the worked numbers and the edges", () => {
  const WEEK = everydayPeriodOf("weekly", "2026-09-11"); // 9/6–9/12
  const LAST_WEEK = everydayPeriodOf("weekly", "2026-09-05"); // 8/30–9/5
  const NEXT_WEEK = everydayPeriodOf("weekly", "2026-09-13"); // 9/13–9/19
  const input = (overrides: Partial<BuildPayoffsInput>): BuildPayoffsInput => ({
    todayISO: "2026-09-11",
    dragCutoffISO: "2026-09-11",
    dragFloorISO: "2026-08-28",
    periods: [],
    payments: [],
    ...overrides,
  });
  const week = (overrides: Partial<PayoffPeriodInput> = {}): PayoffPeriodInput => ({
    period: WEEK,
    planCents: 45_000,
    owedCents: 12_000,
    coveredSpentCents: 12_000,
    ...overrides,
  });
  const nextWeek: PayoffPeriodInput = { period: NEXT_WEEK, planCents: 45_000, owedCents: 0, coveredSpentCents: 0 };

  it("(i) $120 owed and spent: remaining 330, payoff 450 on its Saturday", () => {
    expect(buildPayoffs(input({ periods: [week()] }))[0]).toMatchObject({
      open: true,
      reserveCents: 33_000,
      payment: null,
      outsideForecast: false,
      curve: { amountCents: 45_000, date: "2026-09-12", originalDate: "2026-09-12", assumption: null },
    });
  });

  it("(ii) + $40 on checking: remaining 290, payoff 410", () => {
    expect(buildPayoffs(input({ periods: [week({ coveredSpentCents: 16_000 })] }))[0]!.curve).toMatchObject({ amountCents: 41_000 });
  });

  it("(iii) + $60 unplanned on the card: owed 180, remaining still 290, payoff 470", () => {
    expect(buildPayoffs(input({ periods: [week({ owedCents: 18_000, coveredSpentCents: 16_000 })] }))[0]!.curve).toMatchObject({
      amountCents: 47_000,
    });
  });

  it("overspent: the payoff is the owed charges, never less", () => {
    expect(buildPayoffs(input({ periods: [week({ owedCents: 52_000, coveredSpentCents: 52_000 })] }))[0]).toMatchObject({
      reserveCents: 0,
      curve: { amountCents: 52_000 },
    });
  });

  it("closed and unpaid (Mon 9/14): the owed charges only, on Tue 9/15, amex_payoff_not_posted", () => {
    const [o] = buildPayoffs(input({ todayISO: "2026-09-14", dragCutoffISO: "2026-09-14", dragFloorISO: "2026-08-31", periods: [week()] }));
    expect(o).toMatchObject({
      open: false,
      reserveCents: 0,
      curve: { amountCents: 12_000, date: "2026-09-15", originalDate: "2026-09-12", assumption: "amex_payoff_not_posted" },
    });
  });

  it("the −$120 Amex payment on Tue 9/15 takes the closed week off the curve", () => {
    const [o] = buildPayoffs(
      input({
        todayISO: "2026-09-15",
        dragCutoffISO: "2026-09-15",
        dragFloorISO: "2026-09-01",
        periods: [week()],
        payments: [{ txnId: "pay", occurredOn: "2026-09-15", amountCents: 12_000 }],
      }),
    );
    expect(o).toMatchObject({ payment: { txnId: "pay" }, curve: null, outsideForecast: false });
  });

  it("a payment within max($1, 1%) of the owed figure matches; a cent beyond does not", () => {
    expect(payoffMatchToleranceCents(30_000)).toBe(300);
    expect(payoffMatchToleranceCents(4_000)).toBe(100);
    const withPayment = (amountCents: number) =>
      buildPayoffs(
        input({
          todayISO: "2026-09-15",
          dragCutoffISO: "2026-09-15",
          dragFloorISO: "2026-09-01",
          periods: [week({ owedCents: 30_000 })],
          payments: [{ txnId: "p", occurredOn: "2026-09-15", amountCents }],
        }),
      )[0]!;
    expect(withPayment(30_300).payment).not.toBeNull();
    expect(withPayment(29_700).payment).not.toBeNull();
    expect(withPayment(30_301)).toMatchObject({ payment: null, curve: { amountCents: 30_000 } });
    expect(withPayment(29_699).payment).toBeNull();
  });

  it("a payment dated before the period, or more than 14 days after its payoff date, settles nothing", () => {
    const withPaymentOn = (occurredOn: string) =>
      buildPayoffs(
        input({
          todayISO: "2026-09-27",
          dragCutoffISO: "2026-09-27",
          dragFloorISO: "2026-09-13",
          periods: [week()],
          payments: [{ txnId: "p", occurredOn, amountCents: 12_000 }],
        }),
      )[0]!;
    expect(withPaymentOn("2026-09-05").payment).toBeNull();
    expect(withPaymentOn("2026-09-06").payment).not.toBeNull();
    expect(withPaymentOn("2026-09-26").payment).not.toBeNull();
    expect(withPaymentOn("2026-09-27").payment).toBeNull();
  });

  it("one payment settles one period — the oldest", () => {
    const outcomes = buildPayoffs(
      input({
        todayISO: "2026-09-15",
        dragCutoffISO: "2026-09-15",
        dragFloorISO: "2026-09-01",
        periods: [week(), { period: LAST_WEEK, planCents: 45_000, owedCents: 12_000, coveredSpentCents: 0 }],
        payments: [{ txnId: "one", occurredOn: "2026-09-08", amountCents: 12_000 }],
      }),
    );
    expect(outcomes.map((o) => [o.period.payoffDate, o.payment?.txnId ?? null, o.curve?.amountCents ?? null])).toEqual([
      ["2026-09-05", "one", null],
      ["2026-09-12", null, 12_000],
    ]);
  });

  it("a payment while the week is still open settles the owed charges only: the rest of the plan stays", () => {
    const [o] = buildPayoffs(input({ periods: [week()], payments: [{ txnId: "early", occurredOn: "2026-09-10", amountCents: 12_000 }] }));
    expect(o).toMatchObject({ payment: { txnId: "early" }, curve: { amountCents: 33_000, date: "2026-09-12" } });
  });

  it("a Saturday: still open and due today — once, on the next business day (due_today_not_posted)", () => {
    const outcomes = buildPayoffs(
      input({ todayISO: "2026-09-12", dragCutoffISO: "2026-09-12", dragFloorISO: "2026-08-29", periods: [week(), nextWeek] }),
    );
    expect(outcomes.map((o) => [o.period.payoffDate, o.curve?.date, o.curve?.amountCents, o.curve?.assumption])).toEqual([
      ["2026-09-12", "2026-09-14", 45_000, "due_today_not_posted"],
      ["2026-09-19", "2026-09-19", 45_000, null],
    ]);
  });

  it("a Sunday: closed — once, the owed charges only, the next business day; next week separately", () => {
    const outcomes = buildPayoffs(
      input({ todayISO: "2026-09-13", dragCutoffISO: "2026-09-13", dragFloorISO: "2026-08-30", periods: [nextWeek, week()] }),
    );
    expect(outcomes.map((o) => [o.period.payoffDate, o.curve?.date, o.curve?.amountCents, o.curve?.assumption])).toEqual([
      ["2026-09-12", "2026-09-14", 12_000, "amex_payoff_not_posted"],
      ["2026-09-19", "2026-09-19", 45_000, null],
    ]);
  });

  it("a snapshot dated after today: a payoff due on or before the snapshot day is due", () => {
    const [o] = buildPayoffs(input({ dragCutoffISO: "2026-09-12", periods: [week()] }));
    expect(o!.curve).toMatchObject({ date: "2026-09-14", assumption: "due_today_not_posted", amountCents: 45_000 });
  });

  it("explicit answers: matched/skipped/missed/dismissed take it off; partial leaves the rest; rescheduled moves it", () => {
    const answered = (resolution: PayoffResolution) =>
      buildPayoffs(
        input({
          periods: [week()],
          resolutions: new Map([["weekly|2026-09-12", resolution]]),
          payments: [{ txnId: "p", occurredOn: "2026-09-10", amountCents: 12_000 }],
        }),
      )[0]!;
    for (const status of ["matched", "skipped", "missed", "dismissed"]) {
      expect(answered({ status }), status).toMatchObject({ resolution: status, curve: null, payment: null });
    }
    // Any answer decides instead of the automatic payment match.
    expect(answered({ status: "partial", paidCents: 20_000 })).toMatchObject({ payment: null, curve: { amountCents: 25_000 } });
    expect(answered({ status: "partial", paidCents: 44_950 }).curve).toBeNull(); // $0.50 left
    expect(answered({ status: "rescheduled", rescheduledTo: "2026-09-16" })).toMatchObject({
      payment: null,
      curve: { amountCents: 45_000, date: "2026-09-16", originalDate: "2026-09-16", assumption: null },
    });
  });

  it("closed and unpaid past the overdue floor: off the curve, never dropped silently (outsideForecast)", () => {
    const [o] = buildPayoffs(input({ todayISO: "2026-09-28", dragCutoffISO: "2026-09-28", dragFloorISO: "2026-09-14", periods: [week()] }));
    expect(o).toMatchObject({ open: false, curve: null, outsideForecast: true });
  });

  it("a week not yet begun: the plan alone; a zero plan with nothing owed: nothing", () => {
    expect(buildPayoffs(input({ periods: [nextWeek] }))[0]!.curve).toMatchObject({ amountCents: 45_000, date: "2026-09-19" });
    expect(buildPayoffs(input({ periods: [{ ...nextWeek, planCents: 0 }] }))[0]!.curve).toBeNull();
  });
});

// ── Property test: the hooks never read high ─────────────────────────────────
//
// Generated households (seeded mulberry32): a today on every weekday across two
// month ends, a snapshot dated today or after it, both hooks or the weekly one
// only, charges on the weekly and monthly cards (some the owed figure leaves out),
// checking and other-card spend, payments that do and do not match, and explicit
// answers. For every household and every day of the next 45:
//
//   what the forecast takes out  ≥  what truly leaves checking − what the spec lets it leave out
//
// "What truly leaves" is an independent simulation, per period: the card's whole
// balance for the period (every charge, counted or not), less a payment that
// settled it, plus — while the period is open — the rest of the plan, spent (worst
// case) on the hook's card, less the everyday spend the forecast can see leave;
// paid on the payoff date, or the next business day once it is due. What the spec
// lets the forecast leave out: charges the existing owed figure does not count
// (`computeWeeklyPayoff`; PR-G1 unifies it), what a payment within max($1, 1%) left
// on the card, a partial answer's remainder of $1 or less, and a period past the
// 14-day overdue floor. When none applies, the two are EQUAL, day by day.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const keyOf = (p: EverydayPeriod): string => `${p.cadence}|${p.payoffDate}`;
const CLOSING = new Set(["matched", "skipped", "missed", "dismissed"]);

type Account = "checking" | "weeklyCard" | "monthlyCard" | "otherCard";
interface GenRow {
  occurredOn: string;
  account: Account;
  bucket: EverydayBucket | null;
  spendCents: number;
  countedInOwed: boolean;
}

describe("buildPayoffs — property: the hooks never read high", () => {
  const HOUSEHOLDS = 2500;
  const MIN_HITS = 25;

  it(`${HOUSEHOLDS} generated households: never above the simulated truth beyond what the spec allows; equal when nothing applies`, () => {
    const rnd = mulberry32(20260915);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
    const hits = new Map<string, number>();
    const hit = (k: string) => hits.set(k, (hits.get(k) ?? 0) + 1);

    for (let h = 0; h < HOUSEHOLDS; h += 1) {
      const today = addDaysISO("2026-08-23", Math.floor(rnd() * 63));
      const cutoff = rnd() < 0.8 ? today : addDaysISO(today, 1 + Math.floor(rnd() * 2));
      if (cutoff > today) hit("snapshot-after-today");
      const floor = addDaysISO(today, -14);
      const horizonEnd = addDaysISO(today, 45);
      const monthlyLinked = rnd() < 0.7;
      if (!monthlyLinked) hit("monthly-hook-unlinked");
      hit(`today-dow:${dayOfWeekISO(today)}`);
      const cadences: EverydayCadence[] = monthlyLinked ? ["weekly", "monthly"] : ["weekly"];
      const periods = cadences.flatMap((c) => everydayPeriodsPaidBetween(c, addDaysISO(floor, -12), horizonEnd));
      const firstStart = periods.reduce((m, p) => (p.start < m ? p.start : m), today);

      const rows: GenRow[] = [];
      const span = daysBetween(firstStart, today);
      for (let i = Math.floor(rnd() * 30); i > 0; i -= 1) {
        const account = pick<Account>(["checking", "weeklyCard", "weeklyCard", "monthlyCard", "otherCard"]);
        rows.push({
          occurredOn: addDaysISO(firstStart, Math.floor(rnd() * (span + 1))),
          account,
          bucket: pick<EverydayBucket | null>(["weekly", "weekly", "monthly", "unplanned", null]),
          spendCents: 100 + Math.floor(rnd() * 25_000),
          countedInOwed: account === "weeklyCard" || account === "monthlyCard" ? rnd() < 0.85 : false,
        });
      }
      const cardOf = (c: EverydayCadence): Account => (c === "weekly" ? "weeklyCard" : "monthlyCard");
      const hookPays = (a: Account) => a === "weeklyCard" || (a === "monthlyCard" && monthlyLinked);
      const inPeriod = (r: GenRow, p: EverydayPeriod) => r.occurredOn >= p.start && r.occurredOn <= p.end;
      const sum = (rs: GenRow[]) => rs.reduce((s, r) => s + r.spendCents, 0);
      const owedCounted = (p: EverydayPeriod) => sum(rows.filter((r) => r.account === cardOf(p.cadence) && r.countedInOwed && inPeriod(r, p)));
      const onCardTrue = (p: EverydayPeriod) => sum(rows.filter((r) => r.account === cardOf(p.cadence) && inPeriod(r, p)));

      const plans = new Map<string, number>();
      for (const p of periods) plans.set(keyOf(p), rnd() < 0.1 ? 0 : Math.floor(rnd() * 60_000));

      // The implementation's inputs — what the server adapter hands in.
      const spendRows: EverydaySpendRow[] = rows.map((r) => ({
        occurredOn: r.occurredOn,
        bucket: r.bucket,
        viaNeedsClassification: false,
        spendCents: r.spendCents,
        covered: r.account === "checking" || (hookPays(r.account) && r.countedInOwed),
      }));
      const inputs: PayoffPeriodInput[] = periods.map((period) => ({
        period,
        planCents: plans.get(keyOf(period))!,
        owedCents: period.start > today ? 0 : owedCounted(period),
        coveredSpentCents: periodSpend(period, spendRows).coveredSpentCents,
      }));

      const payments: PayoffPayment[] = [];
      for (const p of periods) {
        const owed = owedCounted(p);
        if (owed <= 0 || rnd() >= 0.5) continue;
        const tolerance = payoffMatchToleranceCents(owed);
        const within = rnd() < 0.7;
        if (!within) hit("payment:outside-tolerance");
        const delta = within
          ? Math.round((rnd() * 2 - 1) * tolerance)
          : (tolerance + 1 + Math.floor(rnd() * 2000)) * (rnd() < 0.5 ? -1 : 1);
        const lo = addDaysISO(p.start, -3);
        const hiCandidate = addDaysISO(p.payoffDate, 16);
        const hi = hiCandidate < today ? hiCandidate : today;
        if (hi < lo) continue;
        payments.push({
          txnId: `pay-${h}-${payments.length}`,
          occurredOn: addDaysISO(lo, Math.floor(rnd() * (daysBetween(lo, hi) + 1))),
          amountCents: Math.max(1, owed + delta),
        });
      }
      if (rnd() < 0.3) {
        payments.push({ txnId: `noise-${h}`, occurredOn: addDaysISO(today, -Math.floor(rnd() * 30)), amountCents: 100 + Math.floor(rnd() * 40_000) });
      }

      const resolutions = new Map<string, PayoffResolution>();
      for (const p of periods) {
        if (rnd() >= 0.08) continue;
        const status = pick(["matched", "skipped", "missed", "dismissed", "partial", "rescheduled"]);
        resolutions.set(
          keyOf(p),
          status === "partial"
            ? { status, paidCents: Math.floor(rnd() * (owedCounted(p) + plans.get(keyOf(p))! + 1)) }
            : status === "rescheduled"
              ? { status, rescheduledTo: addDaysISO(today, -5 + Math.floor(rnd() * 16)) }
              : { status },
        );
      }

      const outcomes = buildPayoffs({ todayISO: today, dragCutoffISO: cutoff, dragFloorISO: floor, periods: inputs, payments, resolutions });

      // ── Invariants ──
      const label = `household ${h} (today ${today})`;
      expect(new Set(outcomes.map((o) => keyOf(o.period))).size, `${label}: one outcome per period`).toBe(periods.length);
      expect(outcomes).toHaveLength(periods.length);
      const settledBy = outcomes.flatMap((o) => (o.payment ? [o.payment.txnId] : []));
      expect(new Set(settledBy).size, `${label}: one payment settles one period`).toBe(settledBy.length);
      for (const o of outcomes) {
        if (!o.curve) continue;
        expect(o.curve.date > today, `${label} ${keyOf(o.period)}: never on or before today`).toBe(true);
        expect(o.curve.amountCents).toBeGreaterThan(0);
        if (o.curve.assumption) expect([0, 6], `${label}: moved onto a weekend`).not.toContain(dayOfWeekISO(o.curve.date));
      }

      // ── The independent simulation ──
      const truthSettled = new Set<string>();
      const byPayoff = [...periods].sort((a, b) =>
        a.payoffDate < b.payoffDate ? -1 : a.payoffDate > b.payoffDate ? 1 : a.cadence === "weekly" ? -1 : 1,
      );
      const byDate = [...payments].sort((a, b) =>
        a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.txnId < b.txnId ? -1 : 1,
      );
      const truth: Array<{ date: string; cents: number; allowance: number }> = [];
      for (const p of byPayoff) {
        const res = resolutions.get(keyOf(p));
        if (res && CLOSING.has(res.status)) {
          hit("resolution:closing");
          continue;
        }
        const open = p.end >= today;
        hit(open ? "period:open" : "period:closed");
        const plan = plans.get(keyOf(p))!;
        // Everyday spend the forecast can see leave: checking, or a card a hook pays.
        const visible = sum(rows.filter((r) => r.bucket === p.cadence && inPeriod(r, p) && (r.account === "checking" || hookPays(r.account))));
        const stillToSpend = open ? Math.max(0, plan - visible) : 0;
        const counted = p.start > today ? 0 : owedCounted(p);
        const onCard = onCardTrue(p);
        if (onCard > counted) hit("owed:uncounted-charges");
        let settled: PayoffPayment | undefined;
        if (!res && counted > 0) {
          const lastDay = addDaysISO(p.payoffDate, 14);
          settled = byDate.find(
            (x) =>
              !truthSettled.has(x.txnId) &&
              x.occurredOn >= p.start &&
              x.occurredOn <= lastDay &&
              Math.abs(x.amountCents - counted) <= Math.max(100, Math.round(counted * 0.01)),
          );
          if (settled) {
            truthSettled.add(settled.txnId);
            hit(open ? "payment:settled-open" : "payment:settled-closed");
          }
        }
        const leftOnCard = Math.max(0, settled ? onCard - settled.amountCents : onCard);
        let cents = leftOnCard + stillToSpend;
        let allowance = leftOnCard - (settled ? 0 : counted);
        if (res?.status === "partial" && res.paidCents != null) {
          hit("resolution:partial");
          cents = Math.max(0, cents - res.paidCents);
          allowance += 100;
        }
        const due = res?.status === "rescheduled" && res.rescheduledTo ? res.rescheduledTo : p.payoffDate;
        if (res?.status === "rescheduled") hit("resolution:rescheduled");
        const date = due > cutoff ? due : nextBusinessDayISO(today);
        if (due <= cutoff) hit(open ? "due:open" : due >= floor ? "due:closed-not-posted" : "due:past-the-floor");
        if (due <= cutoff && !open && due < floor) allowance = cents;
        truth.push({ date, cents, allowance: Math.max(0, allowance) });
      }

      const clean =
        truth.every((t) => t.allowance === 0) && rows.every((r) => !hookPays(r.account) || r.countedInOwed);
      if (clean) hit("household:clean");
      let forecast = 0;
      let actual = 0;
      let allowed = 0;
      for (let d = 0; d <= 45; d += 1) {
        const day = addDaysISO(today, d);
        forecast = outcomes.reduce((s, o) => s + (o.curve && o.curve.date <= day ? o.curve.amountCents : 0), 0);
        actual = truth.reduce((s, t) => s + (t.date <= day ? t.cents : 0), 0);
        allowed = truth.reduce((s, t) => s + (t.date <= day ? t.allowance : 0), 0);
        expect(forecast, `${label} ${day}: the forecast reads high`).toBeGreaterThanOrEqual(actual - allowed);
        if (clean) expect(forecast, `${label} ${day}: nothing applies, so the two agree`).toBe(actual);
      }
    }

    const required = [
      "period:open",
      "period:closed",
      "payment:settled-open",
      "payment:settled-closed",
      "payment:outside-tolerance",
      "due:open",
      "due:closed-not-posted",
      "due:past-the-floor",
      "resolution:closing",
      "resolution:partial",
      "resolution:rescheduled",
      "owed:uncounted-charges",
      "household:clean",
      "snapshot-after-today",
      "monthly-hook-unlinked",
      "today-dow:0",
      "today-dow:6",
    ];
    // For the review note: PR8R_PRINT_HITS=<file> writes the tally there.
    if (process.env.PR8R_PRINT_HITS) {
      writeFileSync(process.env.PR8R_PRINT_HITS, JSON.stringify(Object.fromEntries([...hits].sort()), null, 2));
    }
    for (const key of required) expect(hits.get(key) ?? 0, key).toBeGreaterThanOrEqual(MIN_HITS);
  });
});
