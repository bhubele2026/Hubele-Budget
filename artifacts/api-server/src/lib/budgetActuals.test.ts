// (PR-H) Today's allowance-bucket rule (`aggregateBudgetMonth`) against the
// classifier's view of the same rows (`classifierAllowanceRows`,
// `classifyMovement`).
//
// ⚠️ ROUND 2 (review H1): they are NOT row-for-row equal, and this file no
// longer claims they are. A seeded randomized comparison checks that they agree
// on every generated row EXCEPT an explicit, enumerated list of divergence
// classes — and that every row in a class really does diverge, so the list is
// exact, not a loose allowance. docs/reviews/2026-09-14-household-money-core.md
// lists each class for the owner, with its share of generated rows.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isExcludedCategoryName,
  matchesCardPaymentPattern,
  matchesTransferPattern,
  PFC_CARD_PAYMENT,
  spendAmount,
  type MovementContext,
} from "./spendingFilter";
import {
  aggregateBudgetMonth,
  classifierAllowanceRows,
  spendCents,
  type ClassifierBudgetMonthRow,
} from "./budgetActuals";
import { effectiveFiling, uncategorizedCategoryIds, type FilingContext } from "./pendingFiling";
import type { AllowanceAggregateRow } from "./budgetAllowance";
import type { ReplacedPending } from "./supersededPending";

const CATEGORIES = [
  { id: "cat-groceries", name: "Groceries", debtId: null, kind: "expense" },
  { id: "cat-dining", name: "Dining", debtId: null, kind: "expense" },
  { id: "cat-uncat", name: "Uncategorized", debtId: null, kind: "expense" },
  { id: "cat-debt", name: "Card Payoff", debtId: "debt-1", kind: "expense" },
  { id: "cat-ignore", name: "Ignore", debtId: null, kind: "expense" },
  { id: "cat-transfer", name: "Transfer", debtId: null, kind: "expense" },
  { id: "cat-reimbursement", name: "Reimbursement", debtId: null, kind: "expense" },
  { id: "cat-income", name: "Paycheck", debtId: null, kind: "income" },
] as const;

const filingCtx: FilingContext = { uncategorizedIds: uncategorizedCategoryIds(CATEGORIES) };
const noSupersede = { replacedIds: new Set<string>(), replacedBy: new Map<string, ReplacedPending>() };

function movementCtx(
  matchedTxnIds: ReadonlySet<string> = new Set(),
  tier2PairedTxnIds: ReadonlySet<string> = new Set(),
): MovementContext {
  return {
    categoriesById: new Map(CATEGORIES.map((c) => [c.id, { name: c.name, debtId: c.debtId, kind: c.kind }])),
    debtCategoryIds: new Set(CATEGORIES.filter((c) => c.debtId).map((c) => c.id)),
    checkingAccountExternalId: "chase-ext",
    matchedTxnIds,
    tier2PairedTxnIds,
  };
}

function row(overrides: Partial<ClassifierBudgetMonthRow> = {}): ClassifierBudgetMonthRow {
  return {
    id: "t1",
    description: "CORNER BISTRO",
    source: "plaid:chase",
    amount: "-42.00",
    pending: false,
    isExternalCardPayment: false,
    categoryId: "cat-groceries",
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    weeklyBucket: null,
    reimbursable: false,
    debtId: null,
    isTransfer: false,
    isTransferUserOverridden: false,
    occurredOn: "2026-09-01",
    plaidAccountId: "chase-ext",
    pfcDetailed: null,
    ...overrides,
  };
}

// ── The enumerated divergence classes ──────────────────────────────────────

/**
 * Today's rule screens four things (transfer, external card payment,
 * reimbursable, debt tag) and then buckets any flag. The one spending rule
 * (`classifyOutflow`, which `classifyMovement` runs first) excludes more. Each
 * extra exclusion is one class: a FLAGGED row today's rule buckets and the
 * classifier drops, in either mode.
 */
const ONE_RULE_CLASSES = [
  "non_outflow", // a refund, a credit, or $0: today buckets it with spend "0.00", cnt "1"
  "debt_category", // classifyOutflow rule 4
  "excluded_category", // rule 5: Ignore / Transfer / Reimbursement / …
  "income_category", // rule 6
  "plaid_card_payment", // rule 8: Plaid PFC LOAN_PAYMENTS_CREDIT_CARD_PAYMENT
  "card_payment_description", // rule 9: an issuer payment phrase (CRCARDPMT, …)
  "bank_noise_description", // rule 9b: AUTOPAY, EPAY, WEB ID:, ONLINE TRANSFER, ACH PMT, …
] as const;
/**
 * Forward mode only (PR10), on top of the classes above. (PR8r, the owner's
 * answer 1) PR-H also listed `reimbursable_flagged` here: its classifier put the
 * flags before reimbursable and bucketed a flagged reimbursable row that today's
 * rule screens out. Reimbursable now comes first, so the class is gone — such a
 * unit must now be EQUAL in forward mode (stricter), and the generator still
 * reaches it (`reimbursable_flagged_equal`, asserted below).
 */
const FORWARD_ONLY_CLASSES = [
  "bill_matched_flagged", // decision 12: a confirmed match buckets nowhere
] as const;
type DivergenceClass = (typeof ONE_RULE_CLASSES)[number] | (typeof FORWARD_ONLY_CLASSES)[number];

type Filed = ClassifierBudgetMonthRow;

const flagBucket = (t: Filed): "unplanned" | "monthly" | "weekly" | null =>
  t.unplannedAllowance ? "unplanned" : t.monthlyAllowance ? "monthly" : t.weeklyAllowance ? "weekly" : null;

const passesTodaysScreens = (t: Filed): boolean =>
  !t.isTransfer && !t.isExternalCardPayment && !t.reimbursable && !t.debtId;

/** The one-rule exclusion a row falls under beyond today's screens, by input alone; null when none. */
function oneRuleClass(t: Filed, ctx: MovementContext): (typeof ONE_RULE_CLASSES)[number] | null {
  if (spendAmount(t) <= 0) return "non_outflow";
  const cat = t.categoryId ? ctx.categoriesById.get(t.categoryId) : undefined;
  if (cat) {
    if (cat.debtId || ctx.debtCategoryIds.has(t.categoryId!)) return "debt_category";
    if (isExcludedCategoryName(cat.name)) return "excluded_category";
    if (cat.kind === "income") return "income_category";
  }
  if ((t.pfcDetailed ?? "").toUpperCase() === PFC_CARD_PAYMENT) return "plaid_card_payment";
  if (matchesCardPaymentPattern(t.description)) return "card_payment_description";
  if (matchesTransferPattern(t.description)) return "bank_noise_description";
  return null;
}

/** Mode "today": the class this effectively-filed row diverges under, or null when both functions must agree. */
function todayClass(t: Filed, ctx: MovementContext): DivergenceClass | null {
  if (!flagBucket(t) || !passesTodaysScreens(t)) return null;
  return oneRuleClass(t, ctx);
}

/** Mode "forward": today's classes, plus the forward-only one. */
function forwardClass(t: Filed, ctx: MovementContext): DivergenceClass | null {
  if (!flagBucket(t)) return null;
  if (passesTodaysScreens(t)) {
    return oneRuleClass(t, ctx) ?? (ctx.matchedTxnIds.has(t.id) ? "bill_matched_flagged" : null);
  }
  return null;
}

/** (PR8r) A unit PR-H's `reimbursable_flagged` class named — now required to be equal in forward mode. */
function wasReimbursableFlagged(t: Filed, ctx: MovementContext): boolean {
  if (!flagBucket(t)) return false;
  const onlyReimbursable = t.reimbursable && !t.isTransfer && !t.isExternalCardPayment && !t.debtId;
  return onlyReimbursable && oneRuleClass(t, ctx) === null && !ctx.matchedTxnIds.has(t.id);
}

// ── Seeded generator ───────────────────────────────────────────────────────

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

/** Synthetic descriptions only. The first three are plain merchants; the rest trip a one-rule pattern. */
const PLAIN_DESCRIPTIONS = ["CORNER BISTRO", "GREEN GROCER", "HARDWARE DEPOT"];
const PATTERN_DESCRIPTIONS = [
  "PLANET FITNESS AUTOPAY",
  "REPAY *PEST CONTROL",
  "EPAYMENTS PLUMBING LLC",
  "CITY WATER WEB ID: 4417",
  "CRCARDPMT REF 42",
  "CAPITAL ONE MOBILE PYMT",
  "ONLINE TRANSFER TO SAV 9",
  "ACH PMT RIVERSIDE GYM",
];

interface Unit {
  rows: ClassifierBudgetMonthRow[];
  supersede: { replacedIds: Set<string>; replacedBy: Map<string, ReplacedPending> };
  /** The row that counts: the lone row, or the posted half of a pair. */
  counted: ClassifierBudgetMonthRow;
  movement: MovementContext;
}

function makeGenerator(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const bool = (p: number) => rnd() < p;
  let n = 0;

  const genRow = (): ClassifierBudgetMonthRow => {
    n += 1;
    const source = pick(["plaid:chase", "plaid:amex", "amex", "manual"]);
    const magnitude = Math.round(100 + rnd() * 39900) / 100;
    const shape = rnd();
    const outflowSign = source === "amex" ? 1 : -1;
    const amount = shape < 0.72 ? outflowSign * magnitude : shape < 0.95 ? -outflowSign * magnitude : 0;
    return row({
      id: `r${n}`,
      source,
      plaidAccountId: source === "plaid:chase" ? "chase-ext" : source === "plaid:amex" ? "amex-ext" : null,
      amount: amount.toFixed(2),
      categoryId: pick([null, "cat-deleted", ...CATEGORIES.map((c) => c.id)]),
      description: bool(0.55) ? pick(PLAIN_DESCRIPTIONS) : pick(PATTERN_DESCRIPTIONS),
      unplannedAllowance: bool(0.4),
      monthlyAllowance: bool(0.4),
      weeklyAllowance: bool(0.4),
      weeklyBucket: pick([null, "groceries", "dining"]),
      reimbursable: bool(0.2),
      isTransfer: bool(0.08),
      isTransferUserOverridden: bool(0.3),
      debtId: bool(0.08) ? "debt-2" : null,
      isExternalCardPayment: bool(0.06),
      pfcDetailed: bool(0.08) ? PFC_CARD_PAYMENT : null,
      pending: bool(0.08),
    });
  };

  return (): Unit => {
    const matched = bool(0.25);
    const tier2 = bool(0.2);
    if (bool(0.75)) {
      const r = genRow();
      return {
        rows: [r],
        supersede: { replacedIds: new Set(), replacedBy: new Map() },
        counted: r,
        movement: movementCtx(matched ? new Set([r.id]) : new Set(), tier2 ? new Set([r.id]) : new Set()),
      };
    }
    // A pending row the posted row replaced: sync inserts the posted row bare,
    // so it usually carries no filing of its own and inherits the pending
    // row's (`effectiveFiling`).
    const pending = { ...genRow(), pending: true };
    const own = bool(0.3);
    const posted = row({
      ...genRow(),
      description: pending.description,
      source: pending.source,
      plaidAccountId: pending.plaidAccountId,
      amount: (Number(pending.amount) * 1.1).toFixed(2),
      pending: false,
      unplannedAllowance: own && bool(0.4),
      monthlyAllowance: own && bool(0.4),
      weeklyAllowance: own && bool(0.4),
      weeklyBucket: own ? pick([null, "groceries"]) : null,
      categoryId: bool(0.6) ? null : pick([null, ...CATEGORIES.map((c) => c.id)]),
      reimbursable: bool(0.1),
      debtId: bool(0.05) ? "debt-3" : null,
      isTransfer: bool(0.05),
    });
    const { categoryId, weeklyAllowance, monthlyAllowance, unplannedAllowance, weeklyBucket, reimbursable, debtId, isTransfer, isTransferUserOverridden } = pending;
    const replaced: ReplacedPending = {
      id: pending.id,
      occurredOn: pending.occurredOn,
      description: pending.description,
      filing: { categoryId, weeklyAllowance, monthlyAllowance, unplannedAllowance, weeklyBucket, reimbursable, debtId, isTransfer, isTransferUserOverridden },
    };
    return {
      rows: bool(0.5) ? [pending, posted] : [posted, pending],
      supersede: { replacedIds: new Set([pending.id]), replacedBy: new Map([[posted.id, replaced]]) },
      counted: posted,
      movement: movementCtx(matched ? new Set([posted.id]) : new Set(), tier2 ? new Set([posted.id]) : new Set()),
    };
  };
}

describe("classifierAllowanceRows vs aggregateBudgetMonth — seeded randomized comparison (review H1)", () => {
  const UNITS = 20_000;
  const MIN_HITS = 20;

  it(`${UNITS} generated units agree except for the enumerated classes, exactly — in both modes`, () => {
    const next = makeGenerator(20260915);
    const todayHits = new Map<string, number>();
    const forwardHits = new Map<string, number>();
    const detail = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

    for (let i = 0; i < UNITS; i += 1) {
      const u = next();
      const today = aggregateBudgetMonth(u.rows, u.supersede, filingCtx).allowanceRows;
      const classifierToday = classifierAllowanceRows(u.rows, u.supersede, filingCtx, u.movement, { mode: "today" });
      const classifierForward = classifierAllowanceRows(u.rows, u.supersede, filingCtx, u.movement, { mode: "forward" });
      const t = effectiveFiling(u.counted, u.supersede.replacedBy.get(u.counted.id), filingCtx);

      const tc = todayClass(t, u.movement);
      bump(todayHits, tc ?? "equal");
      if (tc === null) {
        expect(classifierToday, `unit ${i} (today mode)`).toEqual(today);
      } else {
        expect(today, `unit ${i}: today buckets a ${tc} row`).toHaveLength(1);
        expect(classifierToday, `unit ${i}: the classifier drops a ${tc} row`).toEqual([]);
        if (tc === "bank_noise_description" || tc === "card_payment_description") bump(detail, `${tc}: ${t.description}`);
        if (tc === "excluded_category") bump(detail, `${tc}: ${u.movement.categoriesById.get(t.categoryId!)!.name}`);
        if (tc === "non_outflow") bump(detail, `${tc}: ${Number(t.amount) === 0 ? "$0" : "credit/refund"}`);
      }

      const fc = forwardClass(t, u.movement);
      bump(forwardHits, fc ?? "equal");
      if (wasReimbursableFlagged(t, u.movement)) bump(forwardHits, "reimbursable_flagged_equal");
      if (fc === null) {
        expect(classifierForward, `unit ${i} (forward mode)`).toEqual(today);
      } else {
        expect(today, `unit ${i}`).toHaveLength(1);
        expect(classifierForward, `unit ${i}`).toEqual([]);
      }
    }

    // For the review note: PRH_PRINT_CLASSES=<file> writes each class's share there.
    if (process.env.PRH_PRINT_CLASSES) {
      const share = (m: Map<string, number>) =>
        Object.fromEntries([...m].sort().map(([k, v]) => [k, `${v} (${((100 * v) / UNITS).toFixed(2)}%)`]));
      writeFileSync(
        process.env.PRH_PRINT_CLASSES,
        JSON.stringify({ units: UNITS, today: share(todayHits), forward: share(forwardHits), detail: share(detail) }, null, 2),
      );
    }
    // Every enumerated class is live in the generated data — the list is not padding.
    for (const k of ONE_RULE_CLASSES) {
      expect(todayHits.get(k) ?? 0, k).toBeGreaterThanOrEqual(MIN_HITS);
      expect(forwardHits.get(k) ?? 0, k).toBeGreaterThanOrEqual(MIN_HITS);
    }
    for (const k of FORWARD_ONLY_CLASSES) {
      expect(todayHits.get(k) ?? 0, k).toBe(0);
      expect(forwardHits.get(k) ?? 0, k).toBeGreaterThanOrEqual(MIN_HITS);
    }
    // (PR8r) PR-H's reimbursable_flagged units are still generated — and now agree.
    expect(forwardHits.get("reimbursable_flagged_equal") ?? 0).toBeGreaterThanOrEqual(MIN_HITS);
    // And agreement is the common case, not an accident of a tiny sample.
    expect(todayHits.get("equal") ?? 0).toBeGreaterThan(UNITS / 2);
  });

  // The reviewer's round-1 repro rows (synthetic), one per class: today buckets
  // each; the classifier, in either mode, buckets none.
  const REPROS: [string, Partial<ClassifierBudgetMonthRow>, (typeof ONE_RULE_CLASSES)[number]][] = [
    ["PLANET FITNESS AUTOPAY −15 monthly", { description: "PLANET FITNESS AUTOPAY", amount: "-15.00", monthlyAllowance: true }, "bank_noise_description"],
    ["REPAY *PEST CONTROL −12 unplanned", { description: "REPAY *PEST CONTROL", amount: "-12.00", unplannedAllowance: true }, "bank_noise_description"],
    ["CRCARDPMT REF 42 −300 weekly", { description: "CRCARDPMT REF 42", amount: "-300.00", weeklyAllowance: true }, "card_payment_description"],
    ["Plaid credit-card-payment category −25 weekly", { pfcDetailed: PFC_CARD_PAYMENT, amount: "-25.00", weeklyAllowance: true }, "plaid_card_payment"],
    ["Ignore category −40 weekly", { categoryId: "cat-ignore", amount: "-40.00", weeklyAllowance: true }, "excluded_category"],
    ["debt-linked category −80 monthly", { categoryId: "cat-debt", amount: "-80.00", monthlyAllowance: true }, "debt_category"],
    ["income category −9 weekly", { categoryId: "cat-income", amount: "-9.00", weeklyAllowance: true }, "income_category"],
    ["flagged refund +20 weekly", { amount: "20.00", weeklyAllowance: true }, "non_outflow"],
  ];
  for (const [label, overrides, cls] of REPROS) {
    it(`${label}: today buckets it, the classifier does not — class ${cls}`, () => {
      const r = row(overrides);
      const today = aggregateBudgetMonth([r], noSupersede, filingCtx).allowanceRows;
      expect(today).toHaveLength(1);
      if (cls === "non_outflow") expect(today[0]).toMatchObject({ spend: "0.00", cnt: "1" });
      expect(classifierAllowanceRows([r], noSupersede, filingCtx, movementCtx())).toEqual([]);
      expect(classifierAllowanceRows([r], noSupersede, filingCtx, movementCtx(), { mode: "forward" })).toEqual([]);
      expect(todayClass(r, movementCtx())).toBe(cls);
    });
  }
});

describe("classifierAllowanceRows — reimbursable + a flag (answer 1: no longer a difference)", () => {
  // Today's rule gates on `!reimbursable` before looking at a flag. PR-H's
  // classifier put the flags first, so forward mode bucketed this row ($25.00
  // weekly). (PR8r, the owner's answer 1) Reimbursable now comes before the
  // flags: every mode buckets it nowhere. The replaced assertion is stricter.
  it("today, the classifier's today mode and forward mode all bucket it nowhere", () => {
    const rows = [row({ id: "reimb-flag-1", weeklyAllowance: true, reimbursable: true, amount: "-25.00" })];
    expect(aggregateBudgetMonth(rows, noSupersede, filingCtx).allowanceRows).toEqual([]);
    expect(classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx())).toEqual([]);
    expect(classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx(), { mode: "forward" })).toEqual([]);
  });

  it("a matched reimbursable flagged row: nowhere today, nowhere in either mode", () => {
    const rows = [row({ id: "m-r", monthlyAllowance: true, reimbursable: true, amount: "-31.00" })];
    const matched = movementCtx(new Set(["m-r"]));
    expect(aggregateBudgetMonth(rows, noSupersede, filingCtx).allowanceRows).toEqual([]);
    expect(classifierAllowanceRows(rows, noSupersede, filingCtx, matched)).toEqual([]);
    expect(classifierAllowanceRows(rows, noSupersede, filingCtx, matched, { mode: "forward" })).toEqual([]);
  });
});

describe("classifierAllowanceRows — an unknown mode throws (PR-H review N2)", () => {
  it("only 'today' and 'forward' are modes", () => {
    const rows = [row({ id: "n2", weeklyAllowance: true, amount: "-5.00" })];
    for (const mode of ["future", "", "TODAY"]) {
      expect(
        () => classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx(), { mode } as never),
        JSON.stringify(mode),
      ).toThrow(/unknown mode/);
    }
  });
});

describe("classifierAllowanceRows — the decision-12 difference: a matched, flagged row", () => {
  it("today counts a matched weekly-flagged row in the weekly bucket; the forward rule excludes it", () => {
    const matched = row({
      id: "matched-1",
      weeklyAllowance: true,
      weeklyBucket: "dining",
      amount: "-88.40",
    });
    const rows = [matched];
    const matchedTxnIds = new Set(["matched-1"]);

    // TODAY: the real production function, unaware of bill matching at all.
    const today = aggregateBudgetMonth(rows, noSupersede, filingCtx).allowanceRows;
    expect(today).toEqual([
      { bucket: "weekly", subBucket: "dining", pending: false, spend: "88.40", cnt: "1" },
    ]);

    // Mode "today" (the default — review L4, mutation B1) reproduces it.
    expect(classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx(matchedTxnIds))).toEqual(today);

    // FORWARD (PR8r/PR10, decision 12): a confirmed match wins over the flag,
    // so the row buckets nowhere — it is already counted in the bills plan.
    const classifierForward = classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx(matchedTxnIds), {
      mode: "forward",
    });
    expect(classifierForward).toEqual([]);

    // The delta this change will introduce, pinned to the cent.
    const cents = (rs: AllowanceAggregateRow[]) => rs.reduce((s, r) => s + Math.round(parseFloat(r.spend) * 100), 0);
    expect(cents(today) - cents(classifierForward)).toBe(8840);
  });

  it("an unmatched row with the same flag is the same in both modes", () => {
    const rows = [row({ id: "plain-1", weeklyAllowance: true, amount: "-50.00" })];
    const forward = classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx(), { mode: "forward" });
    expect(forward).toEqual(classifierAllowanceRows(rows, noSupersede, filingCtx, movementCtx(), { mode: "today" }));
    expect(forward).toEqual([{ bucket: "weekly", subBucket: null, pending: false, spend: "50.00", cnt: "1" }]);
  });

  it("a tier-2 pair never moves a flagged row out of its bucket", () => {
    const rows = [row({ id: "t2", monthlyAllowance: true, amount: "-19.00" })];
    const ctx = movementCtx(new Set(), new Set(["t2"]));
    const expected = [{ bucket: "monthly", subBucket: null, pending: false, spend: "19.00", cnt: "1" }];
    expect(classifierAllowanceRows(rows, noSupersede, filingCtx, ctx, { mode: "forward" })).toEqual(expected);
    expect(aggregateBudgetMonth(rows, noSupersede, filingCtx).allowanceRows).toEqual(expected);
  });
});

describe("classifierAllowanceRows — pending pairs, same as today", () => {
  it("a pending row a posted row replaced is counted nowhere", () => {
    const rows: ClassifierBudgetMonthRow[] = [
      row({ id: "pending-1", pending: true, weeklyAllowance: true, amount: "-40.00" }),
    ];
    const supersede = { replacedIds: new Set(["pending-1"]), replacedBy: new Map<string, ReplacedPending>() };
    expect(aggregateBudgetMonth(rows, supersede, filingCtx).allowanceRows).toEqual([]);
    expect(classifierAllowanceRows(rows, supersede, filingCtx, movementCtx())).toEqual([]);
  });

  // Review L4, mutation B5: the classifier must classify the posted row under
  // the filing it inherits, or a filed $40 charge leaves its envelope when it
  // posts at $48 (owner decision 14).
  it("a bare posted row buckets under the weekly flag and slice it inherits from its pending row", () => {
    const pending = row({ id: "p", pending: true, weeklyAllowance: true, weeklyBucket: "dining", amount: "-40.00" });
    const posted = row({ id: "q", categoryId: null, amount: "-48.00" });
    const supersede = {
      replacedIds: new Set(["p"]),
      replacedBy: new Map<string, ReplacedPending>([
        [
          "q",
          {
            id: "p",
            occurredOn: pending.occurredOn,
            description: pending.description,
            filing: {
              categoryId: pending.categoryId,
              weeklyAllowance: true,
              monthlyAllowance: false,
              unplannedAllowance: false,
              weeklyBucket: "dining",
              reimbursable: false,
              debtId: null,
              isTransfer: false,
              isTransferUserOverridden: true,
            },
          },
        ],
      ]),
    };
    const expected = [{ bucket: "weekly", subBucket: "dining", pending: false, spend: "48.00", cnt: "1" }];
    expect(aggregateBudgetMonth([pending, posted], supersede, filingCtx).allowanceRows).toEqual(expected);
    expect(classifierAllowanceRows([pending, posted], supersede, filingCtx, movementCtx())).toEqual(expected);
    expect(
      classifierAllowanceRows([pending, posted], supersede, filingCtx, movementCtx(), { mode: "forward" }),
    ).toEqual(expected);
  });
});
