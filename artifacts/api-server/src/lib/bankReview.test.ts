// (S4) avalanche-core's banking-review rules, pure: where one bank row lands,
// how the sums add up, the shared review-status rules, and the pair arithmetic
// pinned to the matcher's own.
import { describe, expect, it } from "vitest";
import {
  BANK_REVIEW_KINDS,
  MATCH_STRICT_DAYS,
  bankLineStatusOf,
  bankReviewKindOf,
  isNeedsReviewResolution,
  matchPlansToRows,
  pairDayDelta,
  pairDifference,
  placeBankReviewRow,
  resolutionResolvesRow,
  rowAnswersResolve,
  summarizeBankReview,
  withinStrictTolerance,
  type BankReviewPlanRef,
  type BankReviewRowInput,
  type MovementCoverage,
} from "@workspace/avalanche-core";

const plan = (planned: number | null, scheduledDate = "2026-10-05", label = "Electric"): BankReviewPlanRef => ({
  key: `item|${scheduledDate}`,
  label,
  scheduledDate,
  planned,
});
const row = (extra: Partial<BankReviewRowInput> = {}): BankReviewRowInput => ({
  occurredOn: "2026-10-05",
  amount: -120,
  resolutions: [],
  evidence: null,
  suggestion: null,
  compared: true,
  ...extra,
});
const where = (r: BankReviewRowInput) => {
  const p = placeBankReviewRow(r);
  return `${p.bucket} ${p.reason} ${p.evidence ?? "-"}`;
};

describe("placeBankReviewRow — first matching rule wins", () => {
  it("rule 1: a confirmed match is split by amount, then timing", () => {
    const confirmed = (amount: number, occurredOn = "2026-10-05", status = "matched") =>
      row({ amount, occurredOn, resolutions: [{ status, plan: plan(-120) }] });
    expect(where(confirmed(-120))).toBe("asPlanned as_planned confirmed");
    // Within max($1, 1%): $1.20 on a $120 plan.
    expect(where(confirmed(-121.2))).toBe("asPlanned as_planned confirmed");
    expect(where(confirmed(-121.21))).toBe("amountDifference amount confirmed");
    expect(where(confirmed(-118.79))).toBe("amountDifference amount confirmed");
    // Three days either way is on time; four is not.
    expect(where(confirmed(-120, "2026-10-08"))).toBe("asPlanned as_planned confirmed");
    expect(where(confirmed(-120, "2026-10-09"))).toBe("timingDifference timing confirmed");
    expect(where(confirmed(-120, "2026-10-01"))).toBe("timingDifference timing confirmed");
    // Amount outranks timing.
    expect(where(confirmed(-150, "2026-10-20"))).toBe("amountDifference amount confirmed");
    // A partial is a difference whatever it paid.
    expect(where(confirmed(-120, "2026-10-05", "partial"))).toBe("amountDifference partial confirmed");
    const p = placeBankReviewRow(confirmed(-135.4));
    expect(p.plan).toEqual({ ...plan(-120), difference: 15.4, dayDelta: 0 });
  });

  it("rule 1: a confirmed row whose plan the ledger did not load is as planned, on the household's word", () => {
    expect(where(row({ resolutions: [{ status: "matched", plan: null }] }))).toBe("asPlanned as_planned confirmed");
    expect(where(row({ resolutions: [{ status: "partial", plan: null }] }))).toBe("amountDifference partial confirmed");
  });

  it("rules 2 and 3: marked not in the plan; a pair waiting for review", () => {
    expect(where(row({ resolutions: [{ status: "ignored_unforecasted", plan: null }] }))).toBe(
      "confirmedUnplanned ignored_unforecasted -",
    );
    expect(where(row({ resolutions: [{ status: "unplanned", plan: null }] }))).toBe("confirmedUnplanned marked_unplanned -");
    expect(where(row({ resolutions: [{ status: "needs_review", plan: plan(-120) }] }))).toBe("uncertain needs_review -");
    expect(where(row({ resolutions: [{ status: "needs_review_partial", plan: null }] }))).toBe("uncertain needs_review -");
  });

  it("the answers outrank the ledger, and a confirmation outranks a later rule", () => {
    const evidence = plan(-120);
    expect(where(row({ evidence, resolutions: [{ status: "ignored_unforecasted", plan: null }] }))).toBe(
      "confirmedUnplanned ignored_unforecasted -",
    );
    expect(
      where(row({ resolutions: [{ status: "ignored_unforecasted", plan: null }, { status: "matched", plan: plan(-120) }] })),
    ).toBe("asPlanned as_planned confirmed");
  });

  it("⚠️ 'Not this' (and any answer that is not about the row) never decides it", () => {
    expect(where(row({ resolutions: [{ status: "not_match", plan: plan(-120) }] }))).toBe("unmatched no_plan -");
    expect(where(row({ resolutions: [{ status: "rescheduled", plan: null }] }))).toBe("unmatched no_plan -");
  });

  it("rule 4: the ledger's evidence is split like a confirmation, marked automatic", () => {
    expect(where(row({ evidence: plan(-120) }))).toBe("asPlanned as_planned automatic");
    expect(where(row({ amount: -300, evidence: plan(-40) }))).toBe("amountDifference amount automatic");
    expect(where(row({ occurredOn: "2026-10-12", evidence: plan(-120) }))).toBe("timingDifference timing automatic");
  });

  it("rules 5–7: a suggestion, not compared, else unmatched — never 'unplanned' without an answer", () => {
    expect(where(row({ suggestion: plan(-120) }))).toBe("uncertain suggested_match -");
    expect(where(row({ evidence: plan(-120), suggestion: plan(-120) }))).toBe("asPlanned as_planned automatic");
    expect(where(row({ compared: false }))).toBe("uncertain not_compared -");
    expect(where(row({ suggestion: plan(-120), compared: false }))).toBe("uncertain suggested_match -");
    expect(where(row())).toBe("unmatched no_plan -");
  });
});

describe("summarizeBankReview — every row once", () => {
  it("Σ buckets + as planned is every row, to the cent; kinds and reasons sub-total their bucket", () => {
    const rows = [
      { amountCents: -8000, pending: false, kind: "spending" as const, placement: placeBankReviewRow(row({ amount: -80, evidence: plan(-80) })) },
      { amountCents: -13540, pending: false, kind: "spending" as const, placement: placeBankReviewRow(row({ amount: -135.4, resolutions: [{ status: "matched", plan: plan(-120) }] })) },
      { amountCents: -15000, pending: false, kind: "spending" as const, placement: placeBankReviewRow(row({ amount: -150, resolutions: [{ status: "partial", plan: plan(-200) }] })) },
      { amountCents: -25000, pending: false, kind: "card_payment" as const, placement: placeBankReviewRow(row({ amount: -250 })) },
      { amountCents: -650, pending: true, kind: "spending" as const, placement: placeBankReviewRow(row({ amount: -6.5 })) },
      { amountCents: 10000, pending: false, kind: "other" as const, placement: placeBankReviewRow(row({ amount: 100 })) },
      { amountCents: -7500, pending: false, kind: "spending" as const, placement: placeBankReviewRow(row({ amount: -75, suggestion: plan(-75) })) },
      { amountCents: -2000, pending: false, kind: "spending" as const, placement: placeBankReviewRow(row({ amount: -20, compared: false })) },
    ];
    const s = summarizeBankReview(rows);
    expect(s.count).toBe(8);
    expect(s.netCents).toBe(rows.reduce((a, r) => a + r.amountCents, 0));
    const bucketNet = Object.values(s.buckets).reduce((a, b) => a + b.netCents, 0) + s.asPlanned.netCents;
    expect(bucketNet).toBe(s.netCents);
    expect(s.asPlanned).toEqual({ count: 1, moneyInCents: 0, moneyOutCents: 8000, netCents: -8000, pendingNetCents: 0 });
    expect(s.buckets.amountDifference).toMatchObject({ count: 2, netCents: -28540 });
    // +15.40 on the Electric, −50.00 on the partial.
    expect(s.differenceTotalCents).toBe(1540 - 5000);
    expect(s.buckets.unmatched).toEqual({ count: 3, moneyInCents: 10000, moneyOutCents: 25650, netCents: -15650, pendingNetCents: -650 });
    expect(s.unmatchedByKind.card_payment).toMatchObject({ count: 1, netCents: -25000 });
    expect(s.unmatchedByKind.spending).toMatchObject({ count: 1, netCents: -650, pendingNetCents: -650 });
    expect(s.unmatchedByKind.other).toMatchObject({ count: 1, netCents: 10000 });
    const kindNet = Object.values(s.unmatchedByKind).reduce((a, k) => a + k.netCents, 0);
    expect(kindNet).toBe(s.buckets.unmatched.netCents);
    expect(s.uncertainByReason.suggested_match).toMatchObject({ count: 1, netCents: -7500 });
    expect(s.uncertainByReason.not_compared).toMatchObject({ count: 1, netCents: -2000 });
  });
});

describe("bankReviewKindOf — every coverage has one kind", () => {
  it("purchases are spending; payments, transfers, income and refunds say so; the rest is other", () => {
    const cases: Record<MovementCoverage, string> = {
      transfer: "transfer",
      debt_payment: "debt_payment",
      card_payment: "card_payment",
      bill_matched: "spending",
      unplanned: "spending",
      allowance_monthly: "spending",
      allowance_weekly: "spending",
      reimbursable: "spending",
      needs_classification: "spending",
      income: "income",
      excluded: "other",
      refund: "refund",
    };
    for (const [coverage, kind] of Object.entries(cases)) {
      expect(bankReviewKindOf(coverage as MovementCoverage), coverage).toBe(kind);
      expect(BANK_REVIEW_KINDS).toContain(kind);
    }
  });
});

describe("the review-status rules (moved verbatim)", () => {
  it("resolutionResolvesRow: everything but 'Not this' and a pair waiting for review", () => {
    for (const s of ["matched", "partial", "ignored_unforecasted", "unplanned", "missed", "skipped", "dismissed", "rescheduled"]) {
      expect(resolutionResolvesRow(s), s).toBe(true);
    }
    for (const s of ["not_match", "needs_review", "needs_review_partial"]) expect(resolutionResolvesRow(s), s).toBe(false);
    expect(isNeedsReviewResolution("needs_review_partial")).toBe(true);
    expect(isNeedsReviewResolution("matched")).toBe(false);
  });

  it("(S6) rowAnswersResolve: the row's own answers decide; with none, the replaced pending row's carry", () => {
    expect(rowAnswersResolve([])).toBe(false);
    expect(rowAnswersResolve(["matched"])).toBe(true);
    // No answer of its own: the pending row's answer carries.
    expect(rowAnswersResolve([], ["ignored_unforecasted"])).toBe(true);
    expect(rowAnswersResolve([], ["needs_review"])).toBe(false);
    // Its own answer wins, whatever the pending row said.
    expect(rowAnswersResolve(["needs_review"], ["matched"])).toBe(false);
    expect(rowAnswersResolve(["matched"], ["needs_review"])).toBe(true);
    // "Not this" is not an answer about the row: it neither decides nor blocks the carry.
    expect(rowAnswersResolve(["not_match"])).toBe(false);
    expect(rowAnswersResolve(["not_match"], ["matched"])).toBe(true);
    expect(rowAnswersResolve([], ["not_match"])).toBe(false);
    // Without a replaced pending row it is exactly "any answer resolves" (the badge before S6).
    for (const s of ["matched", "partial", "ignored_unforecasted", "missed", "not_match", "needs_review", "needs_review_partial"]) {
      expect(rowAnswersResolve([s]), s).toBe(resolutionResolvesRow(s));
    }
  });

  it("bankLineStatusOf: matched / partial → matched; ignored / unplanned → ignored; else pending", () => {
    expect(bankLineStatusOf("matched")).toBe("matched");
    expect(bankLineStatusOf("partial")).toBe("matched");
    expect(bankLineStatusOf("ignored_unforecasted")).toBe("ignored_unforecasted");
    expect(bankLineStatusOf("unplanned")).toBe("ignored_unforecasted");
    for (const s of [undefined, null, "missed", "needs_review", "not_match"]) expect(bankLineStatusOf(s)).toBe("pending_bank");
  });
});

describe("the pair arithmetic is the matcher's own", () => {
  it("pairDifference and pairDayDelta equal a pair's difference and dayDelta; withinStrictTolerance is max($1, 1%)", () => {
    const cases: Array<[number, number, string, string]> = [
      [-150, -173.25, "2026-10-05", "2026-10-09"],
      [-1500, -1500, "2026-10-01", "2026-09-28"],
      [2000, 1999.5, "2026-10-09", "2026-10-09"],
      [-40.1, -40.1, "2026-03-07", "2026-03-10"],
    ];
    for (const [planAmount, rowAmount, planDate, rowDate] of cases) {
      const [m] = matchPlansToRows(
        [{ key: `p|${planDate}`, itemId: "p", occurrenceDate: planDate, date: planDate, amount: planAmount, label: "Acme Utility" }],
        [{ txnId: "t", occurredOn: rowDate, amount: rowAmount, description: "ACME UTILITY", onChecking: true, plaidChecking: true }],
        [{ itemId: "p", label: "Acme Utility", categoryId: null, income: planAmount > 0 }],
      );
      expect(m, `${planAmount} ${rowAmount}`).toBeDefined();
      expect(pairDifference(planAmount, rowAmount)).toBe(m!.difference);
      expect(pairDayDelta(planDate, rowDate)).toBe(m!.dayDelta);
    }
    expect(withinStrictTolerance(-120, -121.2)).toBe(true);
    expect(withinStrictTolerance(-120, -121.21)).toBe(false);
    expect(withinStrictTolerance(-50, -51)).toBe(true);
    expect(withinStrictTolerance(-50, -51.01)).toBe(false);
    expect(MATCH_STRICT_DAYS).toBe(3);
  });
});
