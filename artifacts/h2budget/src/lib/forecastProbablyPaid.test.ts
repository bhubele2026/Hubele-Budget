import { describe, it, expect } from "vitest";
import {
  buildBucket,
  buildClientSuggestions,
  buildLineRegister,
  canRecordPartial,
  partialRemainder,
  pickConfidentBankMatches,
  pickOneClickBankMatches,
  suggestPlanMatchesForBank,
  type BankLine,
  type CashSignalMatch,
  type Resolution,
  type ResolutionStatus,
  type Transaction,
} from "./forecastMatch";
import type { CashEvent } from "./forecast";

// (PR5b) "Probably paid" on the web: the register reads the server's
// `CashSignal.matches`, the new resolution statuses (`not_match`, `partial`,
// `rescheduled`), and the client scorers step aside where the server paired.

const TODAY = new Date(2026, 4, 14);
const base = {
  closedMonths: new Set<string>(),
  startBalance: 1000,
  fromISO: "2026-05-01",
  toISO: "2026-06-30",
  today: TODAY,
};

const water: CashEvent = { itemId: "water", date: "2026-05-20", label: "Water", amount: -150 };
const rent: CashEvent = { itemId: "rent", date: "2026-05-25", label: "Rent", amount: -500 };

const txn = (id: string, occurredOn: string, amount: string, description = "CITY WATER"): Transaction => ({
  id,
  occurredOn,
  description,
  amount,
  forecastFlag: true,
  source: "manual",
});

const res = (over: Partial<Resolution> & { id: string; status: string }): Resolution => ({
  recurringItemId: null,
  occurrenceDate: null,
  matchedTxnId: null,
  ...over,
});

const match = (over: Partial<CashSignalMatch> = {}): CashSignalMatch => ({
  planKey: "water|2026-05-20",
  planItemId: "water",
  planDate: "2026-05-20",
  txnId: "t1",
  planAmount: "-150.00",
  txnAmount: "-173.00",
  difference: "23.00",
  dayDelta: -8,
  confidence: "medium",
  ambiguous: false,
  offCurve: true,
  ...over,
});

describe("register — `not_match` decides neither side", () => {
  it("leaves the plan and the row open", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t1", "2026-05-12", "-173.00")],
      resolutions: [
        res({ id: "rn", status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t1" }),
      ],
    });
    expect(allPlan[0]).toMatchObject({ status: "future", resolutionId: undefined, matchedTxnId: null });
    expect(allBank[0]).toMatchObject({ status: "pending_bank", resolutionId: undefined });
  });

  it("a rejection recorded after the row's match does not hide the match", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [water, rent],
      txns: [txn("t1", "2026-05-12", "-150.00")],
      resolutions: [
        res({ id: "rm", status: "matched", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t1" }),
        res({ id: "rn", status: "not_match", recurringItemId: "rent", occurrenceDate: "2026-05-25", matchedTxnId: "t1" }),
      ],
    });
    expect(allBank[0]).toMatchObject({ status: "matched", resolutionId: "rm", resolutionStatus: "matched" });
    expect(allPlan.find((p) => p.itemId === "water")?.status).toBe("matched");
    expect(allPlan.find((p) => p.itemId === "rent")).toMatchObject({ status: "future", resolutionId: undefined });
  });

  it("a rejection recorded after the row's ignore does not hide the ignore", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t1", "2026-05-12", "-173.00")],
      resolutions: [
        res({ id: "ri", status: "ignored_unforecasted", matchedTxnId: "t1" }),
        res({ id: "rn", status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t1" }),
      ],
    });
    expect(allBank[0]).toMatchObject({ status: "ignored_unforecasted", resolutionId: "ri" });
    expect(allPlan[0]).toMatchObject({ status: "future", resolutionId: undefined });
  });

  it("a rejection recorded after the plan was marked missed keeps it missed", () => {
    const { allPlan } = buildLineRegister({
      ...base,
      events: [water],
      txns: [],
      resolutions: [
        res({ id: "rmi", status: "missed", recurringItemId: "water", occurrenceDate: "2026-05-20" }),
        res({ id: "rn", status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t9" }),
      ],
    });
    expect(allPlan[0]).toMatchObject({ status: "missed", resolutionId: "rmi" });
  });

  it("produces no bucket row", () => {
    const resolutions = [
      res({ id: "rn", status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t1" }),
    ];
    const { allPlan, allBank } = buildLineRegister({ ...base, events: [water], txns: [], resolutions });
    expect(buildBucket({ allPlan, allBank, resolutions, closedMonths: new Set(), monthFilter: "2026-05" })).toEqual([]);
  });
});

describe("register — `not_match` beside a real match for the same plan", () => {
  it("not_match(P, T1) plus matched(P, T2): the plan is matched to T2 and T1 stays open", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t1", "2026-05-12", "-173.00"), txn("t2", "2026-05-13", "-150.00")],
      resolutions: [
        res({ id: "rm", status: "matched", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t2" }),
        res({ id: "rn", status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t1" }),
      ],
    });
    expect(allPlan[0]).toMatchObject({ status: "matched", resolutionId: "rm", matchedTxnId: "t2" });
    expect(allBank.find((b) => b.txn.id === "t1")).toMatchObject({ status: "pending_bank", resolutionId: undefined });
    expect(allBank.find((b) => b.txn.id === "t2")).toMatchObject({ status: "matched", resolutionId: "rm" });
  });
});

describe("register — `rescheduled`", () => {
  it("is a ResolutionStatus, and a rejection on the original key keeps the move", () => {
    const moved: ResolutionStatus = "rescheduled";
    const { allPlan } = buildLineRegister({
      ...base,
      events: [water],
      txns: [],
      resolutions: [
        res({ id: "rr", status: moved, recurringItemId: "water", occurrenceDate: "2026-05-20", rescheduledTo: "2026-05-27" }),
        res({ id: "rn", status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t1" }),
      ],
    });
    expect(allPlan[0]).toMatchObject({ date: "2026-05-27", originalDate: "2026-05-20", status: "future", resolutionId: "rr" });
  });
});

describe("register — `partial`", () => {
  const partialRes = res({ id: "rp", status: "partial", recurringItemId: "rent", occurrenceDate: "2026-05-25", matchedTxnId: "t1" });

  it("marks the row matched and keeps the unpaid remainder planned", () => {
    const { allPlan, allBank, rows } = buildLineRegister({
      ...base,
      events: [rent],
      txns: [txn("t1", "2026-05-12", "-250.00", "RENT PORTAL")],
      resolutions: [partialRes],
    });
    expect(allBank[0]).toMatchObject({ status: "matched", resolutionId: "rp", resolutionStatus: "partial" });
    expect(allPlan[0]).toMatchObject({
      status: "partial",
      amount: -250,
      plannedAmount: -500,
      paidAmount: -250,
      matchedTxnId: "t1",
      resolutionId: "rp",
    });
    const planRows = rows.filter((r) => r.kind === "plan");
    expect(planRows).toHaveLength(1);
    expect(planRows[0].amount).toBe(-250);
  });

  it("a shortfall of $1 or less leaves nothing planned and leaves the register", () => {
    const { allPlan, rows } = buildLineRegister({
      ...base,
      events: [rent],
      txns: [txn("t1", "2026-05-12", "-499.25", "RENT PORTAL")],
      resolutions: [partialRes],
    });
    expect(allPlan[0]).toMatchObject({ status: "partial", amount: 0 });
    expect(rows.filter((r) => r.kind === "plan")).toHaveLength(0);
  });

  it("reads the paid amount from the resolution when the row is not in the list", () => {
    const { allPlan } = buildLineRegister({
      ...base,
      events: [rent],
      txns: [],
      resolutions: [{ ...partialRes, txnAmount: "-200.00" }],
    });
    expect(allPlan[0]).toMatchObject({ status: "partial", amount: -300, paidAmount: -200 });
  });

  it("keeps the whole plan when the paid amount is unknown (the server's rule)", () => {
    const { allPlan } = buildLineRegister({ ...base, events: [rent], txns: [], resolutions: [partialRes] });
    expect(allPlan[0]).toMatchObject({ status: "partial", amount: -500, paidAmount: null });
  });

  it("lands in the bucket as the settled part", () => {
    const resolutions = [partialRes];
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [rent],
      txns: [txn("t1", "2026-05-12", "-250.00", "RENT PORTAL")],
      resolutions,
    });
    const bucket = buildBucket({ allPlan, allBank, resolutions, closedMonths: new Set(), monthFilter: "2026-05" });
    expect(bucket).toEqual([
      expect.objectContaining({ id: "rp", status: "partial", amount: -250, label: "Rent" }),
    ]);
  });

  it("a partial kept beside its plan's move: the move sets the date, the partial the status", () => {
    // The server keeps `rescheduled` when a `partial` is written for the same
    // occurrence; either order in the list must read the same.
    const moved = res({
      id: "rr",
      status: "rescheduled",
      recurringItemId: "rent",
      occurrenceDate: "2026-05-25",
      rescheduledTo: "2026-05-28",
    });
    for (const resolutions of [[moved, partialRes], [partialRes, moved]]) {
      const { allPlan, allBank } = buildLineRegister({
        ...base,
        events: [rent],
        txns: [txn("t1", "2026-05-12", "-250.00", "RENT PORTAL")],
        resolutions,
      });
      expect(allPlan[0]).toMatchObject({
        date: "2026-05-28",
        originalDate: "2026-05-25",
        status: "partial",
        amount: -250,
        resolutionId: "rp",
      });
      expect(allBank[0]).toMatchObject({ status: "matched", resolutionId: "rp" });
      const bucket = buildBucket({ allPlan, allBank, resolutions, closedMonths: new Set(), monthFilter: "2026-05" });
      expect(bucket.find((b) => b.id === "rp")).toMatchObject({ status: "partial", amount: -250, label: "Rent" });
      expect(bucket.find((b) => b.id === "rr")).toMatchObject({ status: "rescheduled", rescheduledTo: "2026-05-28" });
    }
  });

  it("partialRemainder mirrors the server ledger", () => {
    expect(partialRemainder(-500, -250)).toBe(-250);
    expect(partialRemainder(1200, 1000)).toBe(200);
    expect(partialRemainder(-150, -149.5)).toBe(0);
    expect(partialRemainder(-150, -149)).toBe(0);
    expect(partialRemainder(-150, -173)).toBe(0);
    expect(partialRemainder(-150, null)).toBe(-150);
  });

  it("Partial is offered only when the row paid less, by more than $1", () => {
    expect(canRecordPartial({ amount: -500 }, { txnAmount: -250 })).toBe(true);
    expect(canRecordPartial({ amount: -150 }, { txnAmount: -173 })).toBe(false);
    expect(canRecordPartial({ amount: -150 }, { txnAmount: -149.5 })).toBe(false);
    expect(canRecordPartial({ amount: -150 }, { txnAmount: 50 })).toBe(false);
  });
});

describe("register — server matches (\"Suggested\")", () => {
  it("attaches the pair to the open plan and its pending row", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t1", "2026-05-12", "-173.00")],
      resolutions: [],
      matches: [match()],
    });
    expect(allPlan[0].status).toBe("future");
    expect(allPlan[0].probablyPaid).toEqual({
      txnId: "t1",
      planDate: "2026-05-20",
      txnAmount: -173,
      difference: 23,
      dayDelta: -8,
      confidence: "medium",
      ambiguous: false,
      offCurve: true,
      txnDate: "2026-05-12",
      txnDescription: "CITY WATER",
    });
    expect(allBank[0].status).toBe("pending_bank");
    expect(allBank[0].suggestedPlan).toBe(allPlan[0]);
  });

  it("keys a moved plan on its original occurrence", () => {
    const { allPlan } = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t1", "2026-05-19", "-150.00")],
      resolutions: [
        res({ id: "rr", status: "rescheduled", recurringItemId: "water", occurrenceDate: "2026-05-20", rescheduledTo: "2026-05-22" }),
      ],
      matches: [match({ txnAmount: "-150.00", difference: "0.00", dayDelta: -3 })],
    });
    expect(allPlan[0]).toMatchObject({ date: "2026-05-22", originalDate: "2026-05-20" });
    expect(allPlan[0].probablyPaid?.planDate).toBe("2026-05-20");
  });

  it("is ignored when the client already knows the plan is resolved", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t1", "2026-05-12", "-173.00"), txn("t2", "2026-05-13", "-150.00")],
      resolutions: [
        res({ id: "rm", status: "matched", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t2" }),
      ],
      matches: [match()],
    });
    expect(allPlan[0].status).toBe("matched");
    expect(allPlan[0].probablyPaid).toBeUndefined();
    expect(allBank.find((b) => b.txn.id === "t1")?.suggestedPlan).toBeUndefined();
  });

  it("is ignored when the row is already claimed, or the pair was rejected", () => {
    const claimed = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t1", "2026-05-12", "-173.00")],
      resolutions: [res({ id: "ri", status: "ignored_unforecasted", matchedTxnId: "t1" })],
      matches: [match()],
    });
    expect(claimed.allPlan[0].probablyPaid).toBeUndefined();

    const rejected = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t1", "2026-05-12", "-173.00")],
      resolutions: [
        res({ id: "rn", status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t1" }),
      ],
      matches: [match()],
    });
    expect(rejected.allPlan[0].probablyPaid).toBeUndefined();
    expect(rejected.allBank[0].suggestedPlan).toBeUndefined();
  });

  it("keeps pairs one to one", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [water, rent],
      txns: [txn("t1", "2026-05-12", "-173.00"), txn("t2", "2026-05-13", "-160.00")],
      resolutions: [],
      matches: [
        match(),
        match({ txnId: "t2" }),
        match({ planKey: "rent|2026-05-25", planItemId: "rent", planDate: "2026-05-25" }),
      ],
    });
    expect(allPlan.find((p) => p.itemId === "water")?.probablyPaid?.txnId).toBe("t1");
    expect(allPlan.find((p) => p.itemId === "rent")?.probablyPaid).toBeUndefined();
    expect(allBank.find((b) => b.txn.id === "t2")?.suggestedPlan).toBeUndefined();
  });

  it("dates a row outside the list from the plan and the day delta", () => {
    const { allPlan } = buildLineRegister({ ...base, events: [water], txns: [], resolutions: [], matches: [match()] });
    expect(allPlan[0].probablyPaid).toMatchObject({ txnDate: "2026-05-12", txnDescription: null });
  });

  it("leaves an off-curve plan out of the no-bank running balance, as the curve does", () => {
    const { rows } = buildLineRegister({
      ...base,
      events: [water, rent],
      txns: [],
      resolutions: [],
      matches: [match()],
    });
    expect(rows.map((r) => r.runningBalance)).toEqual([1000, 500]);
  });

  it("a pair the server kept on the curve is still Suggested, and still counts", () => {
    const { allPlan, allBank, rows } = buildLineRegister({
      ...base,
      events: [water, rent],
      txns: [],
      resolutions: [],
      matches: [match({ offCurve: false, confidence: "low" })],
    });
    expect(allPlan[0].probablyPaid).toMatchObject({ offCurve: false, confidence: "low" });
    expect(allBank).toEqual([]);
    expect(rows.map((r) => r.runningBalance)).toEqual([850, 350]);
  });

  it("a missing offCurve flag is treated as on the curve — it never hides a bill", () => {
    const { allPlan, rows } = buildLineRegister({
      ...base,
      events: [water],
      txns: [],
      resolutions: [],
      matches: [{ ...match(), offCurve: undefined }],
    });
    expect(allPlan[0].probablyPaid?.offCurve).toBe(false);
    expect(rows.map((r) => r.runningBalance)).toEqual([850]);
  });
});

describe("(PR5b review H1) a pair answered 'Not this' is never a client suggestion", () => {
  // Water $150 due 05-17; the row "CITY WATER 0514" $150 on 05-14. The user
  // answered Not this; the server offers nothing. Without the fix the client
  // made it a high-confidence Water match, and one bulk click wrote `matched`
  // (the server then deleted the rejection).
  const water17: CashEvent = { itemId: "water", date: "2026-05-17", label: "Water", amount: -150 };
  const rejection = res({
    id: "rn",
    status: "not_match",
    recurringItemId: "water",
    occurrenceDate: "2026-05-17",
    matchedTxnId: "t1",
  });

  it("the register exposes the pair, and no chip, one-click or confident pick offers it", () => {
    const reg = buildLineRegister({
      ...base,
      events: [water17],
      txns: [txn("t1", "2026-05-14", "-150.00", "CITY WATER 0514")],
      resolutions: [rejection],
    });
    expect([...reg.rejectedPairs]).toEqual(["water|2026-05-17#t1"]);
    const sugs = buildClientSuggestions(reg.allBank, reg.allPlan, reg.rejectedPairs);
    expect(sugs.get("t1")).toEqual([]);
    expect(pickOneClickBankMatches(sugs).size).toBe(0);
    expect(pickConfidentBankMatches(sugs)).toEqual([]);
    // Control: without the rejection it is the obvious high-confidence pick.
    expect(buildClientSuggestions(reg.allBank, reg.allPlan).get("t1")?.[0]).toMatchObject({
      confidence: "high",
      plan: expect.objectContaining({ itemId: "water" }),
    });
  });

  it("a moved plan's rejection is keyed on its original occurrence", () => {
    const reg = buildLineRegister({
      ...base,
      events: [water17],
      txns: [txn("t1", "2026-05-14", "-150.00", "CITY WATER 0514")],
      resolutions: [
        res({ id: "rr", status: "rescheduled", recurringItemId: "water", occurrenceDate: "2026-05-17", rescheduledTo: "2026-05-15" }),
        rejection,
      ],
    });
    expect(reg.allPlan[0]).toMatchObject({ date: "2026-05-15", originalDate: "2026-05-17" });
    expect(buildClientSuggestions(reg.allBank, reg.allPlan, reg.rejectedPairs).get("t1")).toEqual([]);
  });

  it("another row can still be suggested for the same plan", () => {
    const reg = buildLineRegister({
      ...base,
      events: [water17],
      txns: [txn("t1", "2026-05-14", "-150.00", "CITY WATER 0514"), txn("t2", "2026-05-16", "-150.00", "WATER DEPT")],
      resolutions: [rejection],
    });
    const sugs = buildClientSuggestions(reg.allBank, reg.allPlan, reg.rejectedPairs);
    expect(sugs.get("t1")).toEqual([]);
    expect(sugs.get("t2")?.[0]?.plan.itemId).toBe("water");
  });
});

describe("(PR5b review M1 / NIT) partly-paid plans", () => {
  const rent13: CashEvent = { itemId: "rent", date: "2026-05-13", label: "Rent", amount: -500 };
  const partial13 = res({ id: "rp", status: "partial", recurringItemId: "rent", occurrenceDate: "2026-05-13", matchedTxnId: "t1" });

  it("a past-due partial stays on Review's register while a remainder is planned; the forward view drops it", () => {
    const opts = {
      ...base,
      events: [rent13],
      txns: [txn("t1", "2026-05-12", "-250.00", "RENT PORTAL")],
      resolutions: [partial13],
      visibleFromISO: "2026-05-14",
    };
    const review = buildLineRegister({ ...opts, lingerPastDuePlans: true });
    expect(review.rows.filter((r) => r.kind === "plan")).toEqual([
      expect.objectContaining({ itemId: "rent", status: "partial", amount: -250 }),
    ]);
    const forward = buildLineRegister({ ...opts, lingerPastDuePlans: false });
    expect(forward.rows.filter((r) => r.kind === "plan")).toEqual([]);
  });

  it("a settled partial (remainder of 0) does not linger", () => {
    const review = buildLineRegister({
      ...base,
      events: [rent13],
      txns: [txn("t1", "2026-05-12", "-499.25", "RENT PORTAL")],
      resolutions: [partial13],
      visibleFromISO: "2026-05-14",
      lingerPastDuePlans: true,
    });
    expect(review.rows.filter((r) => r.kind === "plan")).toEqual([]);
  });

  it("the bucket shows what a partial actually paid, even when the shortfall was $1 or less", () => {
    const resolutions = [partial13];
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [rent13],
      txns: [txn("t1", "2026-05-12", "-499.25", "RENT PORTAL")],
      resolutions,
    });
    const bucket = buildBucket({ allPlan, allBank, resolutions, closedMonths: new Set(), monthFilter: "2026-05" });
    expect(bucket).toEqual([expect.objectContaining({ id: "rp", status: "partial", amount: -499.25 })]);
  });
});

describe("no duplicate suggestions", () => {
  // The server paired Water with t1 ($173, 8 days early). t2 is an exact
  // $150 two days before Water — on its own the client would call Water a
  // high-confidence one-click match for t2. It must not.
  const reg = () =>
    buildLineRegister({
      ...base,
      events: [water, { itemId: "netflix", date: "2026-05-15", label: "Netflix", amount: -50 }],
      txns: [
        txn("t1", "2026-05-12", "-173.00"),
        txn("t2", "2026-05-18", "-150.00", "DUPLICATE"),
        txn("t3", "2026-05-13", "-50.00", "ACME CHARGE"),
      ],
      resolutions: [],
      matches: [match()],
    });

  it("a plan the server paired is never a client suggestion, and a paired row gets none", () => {
    const { allPlan, allBank } = reg();
    const pending = allBank.filter((b) => b.status === "pending_bank");
    const sugs = buildClientSuggestions(pending, allPlan);
    expect(sugs.get("t1")).toEqual([]);
    expect((sugs.get("t2") ?? []).map((s) => s.plan.itemId)).not.toContain("water");
    expect((sugs.get("t3") ?? []).map((s) => s.plan.itemId)).toContain("netflix");

    const serverKeys = allPlan.filter((p) => p.probablyPaid).map((p) => `${p.itemId}|${p.date}`);
    const clientKeys = [...sugs.values()].flat().map((s) => `${s.plan.itemId}|${s.plan.date}`);
    expect(serverKeys).toEqual(["water|2026-05-20"]);
    expect(clientKeys.filter((k) => serverKeys.includes(k))).toEqual([]);

    const oneClick = pickOneClickBankMatches(sugs);
    expect([...oneClick.keys()]).toEqual(["t3"]);
    expect(pickConfidentBankMatches(sugs).map((m) => m.txnId)).toEqual(["t3"]);
  });

  it("the scorer itself skips a server-paired plan", () => {
    const { allPlan, allBank } = reg();
    const t2 = allBank.find((b) => b.txn.id === "t2") as BankLine;
    expect(suggestPlanMatchesForBank(t2, allPlan).map((s) => s.plan.itemId)).not.toContain("water");
  });

  it("without server matches the client still suggests Water for t2 (control)", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [water],
      txns: [txn("t2", "2026-05-18", "-150.00", "DUPLICATE")],
      resolutions: [],
    });
    const sugs = buildClientSuggestions(allBank, allPlan);
    expect(sugs.get("t2")?.[0]).toMatchObject({ confidence: "high", plan: expect.objectContaining({ itemId: "water" }) });
  });
});
