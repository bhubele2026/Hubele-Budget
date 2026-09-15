// (PR-H, owner decisions 7 and 12) Today's `householdSpend`
// (`buildSpendingFacts`) against the classifier's view of the same rows
// (`classifierHouseholdSpend`, `classifyMovement`).
//
// ROUND 2:
//   - review M1: mode "today" must BE `householdSpend` — total and count — on
//     any ledger, not a hand-picked fixture. A seeded randomized ledger (every
//     category kind, bank-noise and card-payment descriptions, flags,
//     reimbursables, Amex and bank sign conventions, pending pairs, confirmed
//     and unconfirmed resolutions) is compared window by window;
//   - review M2: a match confirmed while a charge was pending carries to the
//     posted row that replaced it;
//   - mode "forward"'s two documented differences, pinned to the cent.
// See docs/reviews/2026-09-14-household-money-core.md.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  debtsTable,
  forecastResolutionsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO } from "@workspace/avalanche-core";
import { buildSpendingFacts, classifierHouseholdSpend } from "../lib/spendingFacts";
import { findSupersededPendingForRange } from "../lib/supersededPending";
import {
  classifyMovement,
  PFC_CARD_PAYMENT,
  type MovementContext,
  type MovementCoverage,
  type MovementRow,
} from "../lib/spendingFilter";
import { classifierSpendForRange } from "./_helpers/classifierSpend";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const USERS: string[] = [];

async function household(label: string): Promise<{ user: string; householdId: string }> {
  const user = `pr-h-spend-${label}-${RUN}`;
  USERS.push(user);
  return { user, householdId: (await createTestHousehold(user)).householdId };
}

afterAll(async () => {
  if (USERS.length === 0) return;
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.userId, USERS));
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, USERS));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, USERS));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, USERS));
});

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

const HOUR = 3_600_000;
const at = (day: string, offsetMs: number) => new Date(createdAtStartOfHouseholdDay(day).getTime() + offsetMs);

describe("mode 'today' IS buildSpendingFacts().householdSpend — seeded randomized ledger (review M1)", () => {
  let HH: string;
  const matchedIds = new Set<string>();

  // Synthetic descriptions only. Plain merchants, then ones a one-rule pattern catches.
  const PLAIN = ["CORNER BISTRO", "GREEN GROCER", "HARDWARE DEPOT", "CITY PHARMACY"];
  const PATTERNS = [
    "PLANET FITNESS AUTOPAY",
    "REPAY *PEST CONTROL",
    "CITY WATER WEB ID: 4417",
    "CRCARDPMT REF 42",
    "ONLINE TRANSFER TO SAV 9",
    "ACH PMT RIVERSIDE GYM",
  ];
  const DAYS = Array.from({ length: 37 }, (_, i) => addDaysISO("2026-05-25", i)); // 5/25 – 6/30

  beforeAll(async () => {
    const hh = await household("random");
    HH = hh.householdId;
    const base = { userId: hh.user, householdId: HH };
    const rnd = mulberry32(20260915);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
    const bool = (p: number) => rnd() < p;

    const [debt] = await db.insert(debtsTable).values({ ...base, name: "Test Card" }).returning({ id: debtsTable.id });
    const cats = await db
      .insert(budgetCategoriesTable)
      .values([
        { ...base, name: "Groceries", kind: "expense" },
        { ...base, name: "Dining", kind: "expense" },
        { ...base, name: "Uncategorized", kind: "expense" },
        { ...base, name: "Card Payoff", kind: "expense", debtId: debt!.id },
        { ...base, name: "Ignore", kind: "expense" },
        { ...base, name: "Transfer", kind: "expense" },
        { ...base, name: "Reimbursement", kind: "expense" },
        { ...base, name: "Paycheck", kind: "income" },
      ])
      .returning({ id: budgetCategoriesTable.id });
    const categoryIds = [...cats.map((c) => c.id), randomUUID() /* a deleted category */];

    const CHECKING = `chk-${randomUUID()}`;
    const CARD = `card-${randomUUID()}`;
    const ACCOUNTS = [
      { source: "plaid", plaidAccountId: CHECKING as string | null, outflowSign: -1 },
      { source: "plaid:amex", plaidAccountId: CARD as string | null, outflowSign: -1 },
      { source: "amex", plaidAccountId: null, outflowSign: 1 },
      { source: "manual", plaidAccountId: null, outflowSign: -1 },
    ];
    const filing = (flagged = bool(0.55)) => ({
      categoryId: bool(0.25) ? null : pick(categoryIds),
      weeklyAllowance: flagged && bool(0.6),
      monthlyAllowance: flagged && bool(0.5),
      unplannedAllowance: flagged && bool(0.4),
      weeklyBucket: pick([null, "groceries", "dining"]),
      reimbursable: bool(0.2),
      reimbursed: bool(0.3),
      debtId: bool(0.07) ? debt!.id : null,
      isTransfer: bool(0.07),
      isTransferUserOverridden: bool(0.3),
      isExternalCardPayment: bool(0.05),
      pfcDetailed: bool(0.07) ? PFC_CARD_PAYMENT : null,
    });
    const bare = {
      categoryId: null,
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      weeklyBucket: null,
      reimbursable: false,
      reimbursed: false,
      debtId: null,
      isTransfer: false,
      isTransferUserOverridden: false,
      isExternalCardPayment: false,
      pfcDetailed: null,
    };

    const txns: (typeof transactionsTable.$inferInsert)[] = [];
    const pendingHalves: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const account = pick(ACCOUNTS);
      const day = pick(DAYS);
      const magnitude = Math.round(100 + rnd() * 29900) / 100;
      const shape = rnd();
      const signed = shape < 0.75 ? account.outflowSign * magnitude : shape < 0.95 ? -account.outflowSign * magnitude : 0;
      txns.push({
        ...base,
        id: randomUUID(),
        occurredOn: day,
        createdAt: at(day, 3 * HOUR + i * 1000),
        description: bool(0.6) ? pick(PLAIN) : pick(PATTERNS),
        amount: signed.toFixed(2),
        source: account.source,
        plaidAccountId: account.plaidAccountId,
        pending: account.plaidAccountId !== null && bool(0.06),
        ...filing(),
      });
    }
    // Pending rows and the posted rows that replaced them: same account and
    // description, dated 0-7 days later, reached the ledger later, final amount
    // up to 25% above the hold. The posted row usually arrives bare, as sync
    // inserts it, and inherits the pending row's filing.
    for (let k = 0; k < 45; k += 1) {
      const account = pick(ACCOUNTS.slice(0, 2));
      const pendingDay = pick(DAYS);
      const postedDay = addDaysISO(pendingDay, Math.floor(rnd() * 8));
      const description = bool(0.7) ? `FARM STAND ${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + ((k * 7) % 26))}` : pick(PATTERNS);
      const hold = Math.round(500 + rnd() * 19500) / 100;
      const sign = bool(0.9) ? account.outflowSign : -account.outflowSign;
      const pendingId = randomUUID();
      pendingHalves.push(pendingId);
      txns.push({
        ...base,
        id: pendingId,
        occurredOn: pendingDay,
        createdAt: at(pendingDay, HOUR + k),
        description,
        amount: (sign * hold).toFixed(2),
        source: account.source,
        plaidAccountId: account.plaidAccountId,
        pending: true,
        ...filing(),
      });
      txns.push({
        ...base,
        id: randomUUID(),
        occurredOn: postedDay,
        createdAt: at(postedDay, 2 * HOUR + k),
        description,
        amount: (sign * Math.round(hold * (1 + rnd() * 0.25) * 100) / 100).toFixed(2),
        source: account.source,
        plaidAccountId: account.plaidAccountId,
        pending: false,
        ...(bool(0.7) ? bare : filing()),
      });
    }
    await db.insert(transactionsTable).values(txns);

    const resolutions: (typeof forecastResolutionsTable.$inferInsert)[] = [];
    const resolve = (txnId: string, day: string, status: string) =>
      resolutions.push({ ...base, recurringItemId: `rec-${resolutions.length}`, occurrenceDate: day, status, matchedTxnId: txnId });
    for (const t of txns) {
      const p = rnd();
      if (t.pending && pendingHalves.includes(t.id!) ? p < 0.4 : p < 0.15) {
        resolve(t.id!, t.occurredOn!, pick(["matched", "partial"]));
        matchedIds.add(t.id!);
      } else if (p > 0.96) {
        resolve(t.id!, t.occurredOn!, pick(["skipped", "needs_review"]));
      }
    }
    await db.insert(forecastResolutionsTable).values(resolutions);
  });

  const WINDOWS: [string, string][] = [
    ["2026-06-01", "2026-06-30"],
    ["2026-05-31", "2026-06-06"],
    ["2026-06-07", "2026-06-13"],
    ["2026-06-14", "2026-06-20"],
    ["2026-06-21", "2026-06-27"],
    ["2026-06-28", "2026-07-04"],
    ["2026-05-25", "2026-06-10"],
    ["2026-06-15", "2026-06-15"],
    ["2026-06-03", "2026-06-24"],
  ];
  for (const [start, end] of WINDOWS) {
    it(`[${start}, ${end}]: the same total and the same count`, async () => {
      const facts = await buildSpendingFacts(HH, start, end);
      const { spend } = await classifierSpendForRange(HH, start, end, { mode: "today" });
      expect(spend).toEqual(facts.householdSpend);
    });
  }

  it("with the pairs read once for a span covering two windows (the spine's shape), both windows still agree", async () => {
    const supersede = await findSupersededPendingForRange(HH, "2026-05-31", "2026-06-30");
    for (const [start, end] of [
      ["2026-06-01", "2026-06-30"],
      ["2026-06-14", "2026-06-20"],
    ]) {
      const facts = await buildSpendingFacts(HH, start, end, { supersede });
      const { spend } = await classifierSpendForRange(HH, start, end, { mode: "today", supersede });
      expect(spend).toEqual(facts.householdSpend);
    }
  });

  it("the ledger reaches every case the parity depends on (not vacuous)", async () => {
    const { money, rows, spend } = await classifierSpendForRange(HH, "2026-06-01", "2026-06-30");
    const coverage = new Map<MovementCoverage, number>();
    for (const r of rows) {
      const c = classifyMovement(r, money).coverage;
      coverage.set(c, (coverage.get(c) ?? 0) + 1);
    }
    for (const c of [
      "transfer",
      "debt_payment",
      "card_payment",
      "bill_matched",
      "unplanned",
      "allowance_monthly",
      "allowance_weekly",
      "reimbursable",
      "needs_classification",
      "excluded",
    ] as const) {
      expect(coverage.get(c) ?? 0, c).toBeGreaterThanOrEqual(2);
    }
    const flagged = (r: MovementRow) => r.unplannedAllowance || r.monthlyAllowance || r.weeklyAllowance;
    expect(money.supersede.replacedIds.size).toBeGreaterThanOrEqual(10);
    expect(rows.filter((r) => r.reimbursable && flagged(r)).length).toBeGreaterThanOrEqual(5);
    expect(rows.filter((r) => r.reimbursable && money.matchedTxnIds.has(r.id)).length).toBeGreaterThanOrEqual(3);
    // Matches confirmed on a pending row, carried to the posted row.
    const carried = [...money.supersede.replacedBy].filter(
      ([postedId, pending]) => matchedIds.has(pending.id) && !matchedIds.has(postedId),
    );
    expect(carried.length).toBeGreaterThanOrEqual(3);
    for (const [postedId] of carried) expect(money.matchedTxnIds.has(postedId)).toBe(true);
    expect(spend.total).toBeGreaterThan(0);
    expect(classifierHouseholdSpend(rows, money, { mode: "forward" }).total).not.toBe(spend.total);
  });
});

describe("review M1 — a reimbursable row never counts in mode 'today', match or flag", () => {
  it("matched with no flag, flagged, and matched and flagged: $0 today, $0 from the classifier", async () => {
    const hh = await household("m1");
    const base = { userId: hh.user, householdId: hh.householdId, source: "manual", reimbursable: true };
    const [matched, flaggedRow, both] = await db
      .insert(transactionsTable)
      .values([
        { ...base, occurredOn: "2026-06-10", description: "CLINIC VISIT", amount: "-50.00" },
        { ...base, occurredOn: "2026-06-11", description: "URGENT CARE COPAY", amount: "-35.00", weeklyAllowance: true },
        { ...base, occurredOn: "2026-06-12", description: "LAB WORK", amount: "-24.00", monthlyAllowance: true },
      ])
      .returning({ id: transactionsTable.id });
    await db.insert(forecastResolutionsTable).values(
      [matched!, both!].map((t, i) => ({
        userId: hh.user,
        householdId: hh.householdId,
        recurringItemId: `rec-m1-${i}`,
        occurrenceDate: "2026-06-10",
        status: "matched",
        matchedTxnId: t.id,
      })),
    );

    const facts = await buildSpendingFacts(hh.householdId, "2026-06-01", "2026-06-30");
    expect(facts.householdSpend).toEqual({ total: 0, transactionCount: 0 });
    const { spend, money } = await classifierSpendForRange(hh.householdId, "2026-06-01", "2026-06-30", { mode: "today" });
    expect(money.matchedTxnIds.has(matched!.id)).toBe(true);
    expect(money.matchedTxnIds.has(flaggedRow!.id)).toBe(false);
    expect(spend).toEqual({ total: 0, transactionCount: 0 });
  });
});

describe("review M2 — a match confirmed on the pending row carries to the posted row", () => {
  it("pending $40 matched, posts at $48: counted once today; bill_matched, so $0 in mode 'forward'", async () => {
    const hh = await household("m2");
    const account = `chk-${randomUUID()}`;
    const base = { userId: hh.user, householdId: hh.householdId, source: "plaid", plaidAccountId: account, description: "CITY POWER CO" };
    const [pending] = await db
      .insert(transactionsTable)
      .values({ ...base, occurredOn: "2026-06-08", createdAt: at("2026-06-08", HOUR), amount: "-40.00", pending: true })
      .returning({ id: transactionsTable.id });
    const [posted] = await db
      .insert(transactionsTable)
      .values({ ...base, occurredOn: "2026-06-10", createdAt: at("2026-06-10", HOUR), amount: "-48.00", pending: false })
      .returning({ id: transactionsTable.id });
    await db.insert(forecastResolutionsTable).values({
      userId: hh.user,
      householdId: hh.householdId,
      recurringItemId: "rec-m2",
      occurrenceDate: "2026-06-08",
      status: "matched",
      matchedTxnId: pending!.id,
    });

    const facts = await buildSpendingFacts(hh.householdId, "2026-06-01", "2026-06-30");
    expect(facts.householdSpend).toEqual({ total: 48, transactionCount: 1 });

    const { money, rows, spend } = await classifierSpendForRange(hh.householdId, "2026-06-01", "2026-06-30");
    expect(money.supersede.replacedIds.has(pending!.id)).toBe(true);
    expect(money.matchedTxnIds.has(posted!.id)).toBe(true);
    const postedRow = rows.find((r) => r.id === posted!.id)!;
    expect(classifyMovement(postedRow, money).coverage).toBe("bill_matched");
    expect(spend).toEqual(facts.householdSpend);
    expect(classifierHouseholdSpend(rows, money, { mode: "forward" })).toEqual({ total: 0, transactionCount: 0 });

    // A window that starts after the pending day still sees the carried match.
    const later = await classifierSpendForRange(hh.householdId, "2026-06-09", "2026-06-15", { mode: "forward" });
    expect(later.money.matchedTxnIds.has(posted!.id)).toBe(true);
    expect(later.spend).toEqual({ total: 0, transactionCount: 0 });
  });
});

describe("mode 'forward' — decision 12: a confirmed bill match stops counting", () => {
  it("today counts it; forward removes exactly its amount", async () => {
    const hh = await household("d1");
    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: hh.user, householdId: hh.householdId, name: "Insurance", kind: "expense" })
      .returning({ id: budgetCategoriesTable.id });
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: hh.user,
        householdId: hh.householdId,
        occurredOn: "2026-07-10",
        description: "AUTO INSURANCE CO",
        amount: "-142.17",
        categoryId: cat!.id,
      })
      .returning({ id: transactionsTable.id });
    await db.insert(forecastResolutionsTable).values({
      userId: hh.user,
      householdId: hh.householdId,
      recurringItemId: "rec-d1",
      occurrenceDate: "2026-07-10",
      status: "matched",
      matchedTxnId: txn!.id,
    });

    const facts = await buildSpendingFacts(hh.householdId, "2026-07-01", "2026-07-31");
    const { rows, money, spend } = await classifierSpendForRange(hh.householdId, "2026-07-01", "2026-07-31");
    expect(spend).toEqual(facts.householdSpend);
    const forward = classifierHouseholdSpend(rows, money, { mode: "forward" });
    expect(Math.round((facts.householdSpend.total - forward.total) * 100)).toBe(14217);
  });
});

describe("mode 'forward' — reimbursable + an allowance flag counts under its flag", () => {
  it("today excludes it; forward counts the flagged one only — a plain reimbursable row stays out", async () => {
    const hh = await household("d2");
    await db.insert(transactionsTable).values([
      {
        userId: hh.user,
        householdId: hh.householdId,
        occurredOn: "2026-08-05",
        description: "URGENT CARE COPAY",
        amount: "-35.00",
        reimbursable: true,
        weeklyAllowance: true,
      },
      {
        userId: hh.user,
        householdId: hh.householdId,
        occurredOn: "2026-08-06",
        description: "PHARMACY PICKUP",
        amount: "-22.00",
        reimbursable: true,
      },
    ]);

    const facts = await buildSpendingFacts(hh.householdId, "2026-08-01", "2026-08-31");
    expect(facts.householdSpend.total).toBe(0);
    const { rows, money, spend } = await classifierSpendForRange(hh.householdId, "2026-08-01", "2026-08-31");
    expect(spend).toEqual(facts.householdSpend);
    expect(classifierHouseholdSpend(rows, money, { mode: "forward" })).toEqual({ total: 35, transactionCount: 1 });
  });
});

describe("classifierHouseholdSpend — what each coverage adds, and 'today' is the default (review L4)", () => {
  // One row per coverage, each a distinct power of two, so dropping any one
  // coverage from the sum (mutations S1-S4, S6) or flipping the default (S5)
  // changes the total to a value no other mistake produces.
  const ctx: MovementContext = {
    categoriesById: new Map([["c", { name: "Groceries", debtId: null, kind: "expense" }]]),
    debtCategoryIds: new Set(),
    checkingAccountExternalId: null,
    matchedTxnIds: new Set(["matched"]),
  };
  const r = (id: string, dollars: number, extra: Partial<MovementRow> = {}): MovementRow => ({
    id,
    occurredOn: "2026-06-01",
    amount: (-dollars).toFixed(2),
    source: "manual",
    isTransfer: false,
    categoryId: "c",
    description: "CORNER BISTRO",
    debtId: null,
    isExternalCardPayment: false,
    reimbursable: false,
    pfcDetailed: null,
    plaidAccountId: null,
    unplannedAllowance: false,
    monthlyAllowance: false,
    weeklyAllowance: false,
    ...extra,
  });
  const rows = [
    r("unplanned", 1, { unplannedAllowance: true }),
    r("monthly", 2, { monthlyAllowance: true }),
    r("weekly", 4, { weeklyAllowance: true }),
    r("none", 8),
    r("matched", 16),
    r("reimbursable", 32, { reimbursable: true }),
    r("transfer", 64, { isTransfer: true }),
  ];

  it("mode 'today': unplanned, monthly, weekly, needs_classification and bill_matched count", () => {
    expect(classifierHouseholdSpend(rows, ctx, { mode: "today" })).toEqual({ total: 31, transactionCount: 5 });
  });

  it("mode 'forward': the same, less the bill match; a plain reimbursable row still never counts", () => {
    expect(classifierHouseholdSpend(rows, ctx, { mode: "forward" })).toEqual({ total: 15, transactionCount: 4 });
  });

  it("no mode given is 'today'", () => {
    expect(classifierHouseholdSpend(rows, ctx)).toEqual({ total: 31, transactionCount: 5 });
  });
});
