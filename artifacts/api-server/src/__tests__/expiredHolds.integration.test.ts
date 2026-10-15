// ⭐ (F6 round 3, the owner's decision 2026-10-15) "A charge that is still pending
// more than 7 days after its date: stop counting it everywhere — worked out,
// nothing deleted. If it posts later, the posted charge counts."
//
// One synthetic household (every name, amount and number here is made up), read
// through every surface that leaves out a replaced pending row: the transaction
// list, the bank register and the banking review, spending (week and month), the
// Budget month (category actual and allowance), the period breakdown, the review
// badge, the bank balance (the cash ledger) and the spine. Each read is also run
// with the rule's kill switch (`EXPIRED_HOLDS_RULE=off`): the base, exactly.
//
// Clock: Thu 2026-10-15 12:00 Central, so a row dated 10/07 or before is more
// than 7 days old. Checking ••5526 (the snapshot account): 2,000.00 read Fri 10/02
// 09:00 Central. Card ••7101 (weekly, no debt row: the weekly payoff reads it).
//
//   checking 10/01 CITY CAR RENTAL HOLD     −80.00  pending  held by the snapshot
//   checking 10/08 Car Rental Transaction   +80.00  pending  its reversal (7 days: young)
//   checking 10/03 SOME TAVERN 0042         −64.18  pending  filed Dining, weekly; never posted as itself
//   checking 10/05 SOME TAVERN 0042         −90.00  posted   Dining, weekly — above the pairing cap
//                                                            (64.18 × 1.30 + 1.00 = 84.43): not its twin
//   checking 10/04 HARBOR HOTEL HOLD       −200.00  pending
//   checking 10/09 Hotel Transaction       +200.00  pending  its reversal (6 days: young)
//   checking 10/06 GREEN GROCER             −45.00  posted   Groceries
//   checking 10/09 ACME CORP PAYROLL     +1,500.00  posted
//   checking 10/13 CORNER CAFE              −12.00  pending  2 days old: counts
//   card     10/02 PARKING GARAGE            −30.00  pending  expired
//   card     10/10 BOOKSHOP                  −25.00  posted
//
// Expired holds: the car hold and its reversal, the tavern hold, the hotel hold
// and its reversal, the parking hold. Counted: everything else, once.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `f6r3-expired-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HH;
    req.householdOwnerId = OWNER;
    next();
  },
}));

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => {
      throw new Error("no Plaid calls in this test");
    },
  };
});

import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import bankBalanceExplainRouter from "../routes/bankBalanceExplain";
import budgetRouter from "../routes/budget";
import forecastRouter from "../routes/forecast";
import spineRouter from "../routes/spine";
import transactionsRouter from "../routes/transactions";
import transactionsLedgerRouter from "../routes/transactionsLedger";
import { resolveExtraForUser } from "../routes/avalanche";
import { buildBudgetFacts } from "../lib/budgetFacts";
import { loadCategoryPlans } from "../lib/afford";
import { computeWeeklyPayoff } from "../lib/amexAnchor";
import { buildBankingReview } from "../lib/bankingReview";
import { buildBehaviorFacts } from "../lib/behaviorFacts";
import { buildReviewProposals } from "../lib/reviewProposals";
import { computeCashSignal } from "../lib/cashSignal";
import { buildPeriodBreakdown } from "../lib/periodBreakdown";
import { computeReviewCount } from "../lib/reviewCount";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { findSupersededPending, findSupersededPendingForRange } from "../lib/supersededPending";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-15T12:00:00-05:00");
const CHECKING = `acct-f6r3-chk-${randomUUID()}`;
const CARD = `acct-f6r3-card-${randomUUID()}`;
const id: Record<string, string> = {};

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(budgetRouter);
app.use(spineRouter);
app.use(transactionsRouter);
app.use(transactionsLedgerRouter);
app.use(bankBalanceExplainRouter);
app.use(forecastRouter);

let server: Server;
let baseUrl: string;

async function get<T = any>(p: string): Promise<T> {
  const r = await fetch(`${baseUrl}${p}`);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

/** Every read below, with the rule on (the default) or off (the kill switch). */
async function withRule<T>(on: boolean, read: () => Promise<T>): Promise<T> {
  if (on) return read();
  vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
  try {
    return await read();
  } finally {
    vi.unstubAllEnvs();
  }
}

const EXPIRED = ["carHold", "carReversal", "tavernHold", "hotelHold", "hotelReversal", "parkingHold"];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  HH = (await createTestHousehold(OWNER)).householdId;
  const base = { userId: OWNER, householdId: HH };
  const [bank, amex] = await db
    .insert(plaidItemsTable)
    .values([
      { ...base, itemId: `item-${randomUUID()}`, accessToken: "t", institutionName: "Lakeside Bank", institutionSlug: "lakeside" },
      { ...base, itemId: `item-${randomUUID()}`, accessToken: "t", institutionName: "American Express", institutionSlug: "amex" },
    ])
    .returning();
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values([
      { ...base, itemId: bank!.id, accountId: CHECKING, name: "Everyday Checking", mask: "5526", type: "depository", subtype: "checking" },
      { ...base, itemId: amex!.id, accountId: CARD, name: "Travel Card", mask: "7101", type: "credit", subtype: "credit card" },
    ])
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2000.00",
    bankSnapshotAt: new Date("2026-10-02T09:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chk!.id,
    bankSnapshotMask: "5526",
  });
  const [dining, groceries] = await db
    .insert(budgetCategoriesTable)
    .values([
      { ...base, name: "Dining F6R3", kind: "expense" },
      { ...base, name: "Groceries F6R3", kind: "expense" },
    ])
    .returning();
  id.dining = dining!.id;
  id.groceries = groceries!.id;
  // (F6 round 4) October's plan for both, so Reports › Budget judges their lines.
  await db.insert(budgetLinesTable).values([
    { ...base, monthStart: "2026-10-01", categoryId: id.dining, plannedAmount: "200.00" },
    { ...base, monthStart: "2026-10-01", categoryId: id.groceries, plannedAmount: "300.00" },
  ]);
  const row = (
    key: string,
    on: string,
    description: string,
    amount: string,
    o: { pending?: boolean; card?: boolean; categoryId?: string; weekly?: boolean; pfcPrimary?: string } = {},
  ) => ({
    ...base,
    key,
    occurredOn: on,
    description,
    amount,
    pending: o.pending ?? false,
    plaidAccountId: o.card ? CARD : CHECKING,
    source: o.card ? "plaid:amex" : "plaid:lakeside",
    plaidTransactionId: `f6r3-${key}-${randomUUID().slice(0, 8)}`,
    categoryId: o.categoryId ?? null,
    weeklyAllowance: o.weekly ?? false,
    pfcPrimary: o.pfcPrimary ?? null,
    pfcDetailed: o.pfcPrimary === "TRANSFER_OUT" ? "TRANSFER_OUT_ACCOUNT_TRANSFER" : null,
    createdAt: createdAtStartOfHouseholdDay(on),
  });
  const rows = [
    row("carHold", "2026-10-01", "CITY CAR RENTAL HOLD", "-80.00", { pending: true }),
    row("carReversal", "2026-10-08", "Car Rental Transaction", "80.00", { pending: true }),
    // Plaid's category reads "transfer out": evidence only (never filing), so a
    // review proposal would ask about it — while it is counted.
    row("tavernHold", "2026-10-03", "SOME TAVERN 0042", "-64.18", { pending: true, categoryId: id.dining, weekly: true, pfcPrimary: "TRANSFER_OUT" }),
    row("tavernPosted", "2026-10-05", "SOME TAVERN 0042", "-90.00", { categoryId: id.dining, weekly: true }),
    row("hotelHold", "2026-10-04", "HARBOR HOTEL HOLD", "-200.00", { pending: true }),
    row("hotelReversal", "2026-10-09", "Hotel Transaction", "200.00", { pending: true }),
    row("grocer", "2026-10-06", "GREEN GROCER", "-45.00", { categoryId: id.groceries }),
    row("payroll", "2026-10-09", "ACME CORP PAYROLL", "1500.00"),
    row("cafe", "2026-10-13", "CORNER CAFE", "-12.00", { pending: true }),
    row("parkingHold", "2026-10-02", "PARKING GARAGE", "-30.00", { pending: true, card: true }),
    row("bookshop", "2026-10-10", "BOOKSHOP", "-25.00", { card: true }),
  ];
  const out = await db
    .insert(transactionsTable)
    .values(rows.map(({ key: _k, ...r }) => r))
    .returning({ id: transactionsTable.id });
  rows.forEach((r, i) => (id[r.key] = out[i]!.id));
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, OWNER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, OWNER));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, OWNER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, OWNER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, OWNER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, OWNER));
});

const expiredIds = () => EXPIRED.map((k) => id[k]!).sort();

describe("⭐ F6 round 3 · an expired hold counts nowhere — every reader", () => {
  it("one answer: the whole-ledger read and the range read name the same six rows; the kill switch names none", async () => {
    expect([...(await findSupersededPending(HH)).expiredIds].sort()).toEqual(expiredIds());
    expect([...(await findSupersededPendingForRange(HH, "2026-10-01", "2026-10-15")).expiredIds].sort()).toEqual(expiredIds());
    // A range holding only the young reversals still names them (their holds are before it).
    expect([...(await findSupersededPendingForRange(HH, "2026-10-08", "2026-10-09")).expiredIds].sort()).toEqual(
      [id.carReversal!, id.hotelReversal!].sort(),
    );
    expect((await withRule(false, () => findSupersededPending(HH))).expiredIds.size).toBe(0);
    expect((await withRule(false, () => findSupersededPendingForRange(HH, "2026-10-01", "2026-10-15"))).expiredIds.size).toBe(0);
  });

  it("GET /transactions: every row is listed; the expired holds say so (expiredHold), the rest do not — (F6 round 5, finding 3) the car hold the snapshot held and its reversal are counted rows (expiredPair), as in the register", async () => {
    type Flags = { id: string; expiredHold: boolean; expiredPair: boolean };
    const rows = await get<Flags[]>("/transactions?from=2026-10-01&to=2026-10-15&limit=100");
    expect(rows).toHaveLength(11);
    expect(rows.filter((r) => r.expiredHold).map((r) => r.id).sort()).toEqual(
      ["tavernHold", "hotelHold", "hotelReversal", "parkingHold"].map((k) => id[k]!).sort(),
    );
    expect(rows.filter((r) => r.expiredPair).map((r) => r.id).sort()).toEqual([id.carHold!, id.carReversal!].sort());
    const off = await withRule(false, () => get<Flags[]>("/transactions?from=2026-10-01&to=2026-10-15&limit=100"));
    expect(off.every((r) => r.expiredHold === false && r.expiredPair === false)).toBe(true);
  });

  it("⭐ the bank balance (the cash ledger): the unpaired tavern hold adds 0 and the hotel pair adds 0; the car reversal still counts (the snapshot held its hold) — 3,433.00 (base 3,368.82)", async () => {
    // 2,000.00 + 80.00 (car hold released) − 90.00 − 45.00 + 1,500.00 − 12.00.
    expect((await computeCashSignal(HH, OWNER, { horizonDays: 30 })).bankToday).toBe("3433.00");
    // Base: − 64.18 (tavern hold) − 200.00 + 200.00 (hotel pair) on top.
    expect((await withRule(false, () => computeCashSignal(HH, OWNER, { horizonDays: 30 }))).bankToday).toBe("3368.82");
  });

  it("⭐ the register and the banking review: the three holds the snapshot did not hold move the register by 0 (reason expired); the car hold it held and its reversal both count (net 0, finding 11); the review asks about none of the five", async () => {
    type LedgerRowOut = { id: string; occurredOn: string; balanceReason: string; balanceAmount: string; expiredHold: boolean; countsInBalance: boolean; runningBalance: string | null };
    const ledger = await get<{ rows: LedgerRowOut[]; totals: { moneyIn: string; moneyOut: string; net: string }; balanceToday: string }>(
      "/transactions/ledger?from=2026-10-01&to=2026-10-15&limit=100",
    );
    const notHeld = ["tavernHold", "hotelHold", "hotelReversal"].map((k) => id[k]!).sort();
    expect(ledger.rows.filter((r) => r.expiredHold).map((r) => r.id).sort()).toEqual(notHeld);
    for (const r of ledger.rows.filter((x) => x.expiredHold)) expect(r).toMatchObject({ balanceReason: "expired", balanceAmount: "0.00", countsInBalance: false });
    // ⭐ (F6 round 4, finding 11) The car hold (10/01, inside the 10/02 read) and its
    // reversal: the bank balance counts the reversal, so the register counts both,
    // at full amount, and labels neither (round 3: both 0, "expired").
    const car = ledger.rows.find((r) => r.id === id.carHold)!;
    const carBack = ledger.rows.find((r) => r.id === id.carReversal)!;
    expect(car).toMatchObject({ balanceReason: "counted", balanceAmount: "-80.00", countsInBalance: true, expiredHold: false });
    expect(carBack).toMatchObject({ balanceReason: "counted", balanceAmount: "80.00", countsInBalance: true, expiredHold: false });
    // The running balance on the snapshot's day meets the 2,000.00 read that morning
    // (round 3: 2,080.00); today ties.
    expect(car.runningBalance).toBe("2000.00");
    expect(ledger.totals).toMatchObject({ moneyIn: "1580.00", moneyOut: "227.00", net: "1353.00" });
    expect(ledger.balanceToday).toBe("3433.00");
    // The register's rows since the read are the ones "Why this number?" lists: 5 rows, 1,433.00.
    const since = ledger.rows.filter((r) => r.occurredOn > "2026-10-02" && r.countsInBalance);
    expect(since).toHaveLength(5);
    expect(since.reduce((sum, r) => sum + Math.round(Number(r.balanceAmount) * 100), 0)).toBe(143300);
    const explain = await get<{ displayed: { bankToday: string }; ledger: { sinceAnchor: { rowCount: number; net: string } } }>("/forecast/bank-balance-explain");
    expect(explain.displayed.bankToday).toBe("3433.00");
    expect(explain.ledger.sinceAnchor).toEqual({ rowCount: 5, net: "1433.00" });

    const review = await buildBankingReview(HH, OWNER, { from: "2026-10-01", to: "2026-10-15", rowsPerBucket: 25, limit: 25 });
    expect(review.cashFlow).toMatchObject({ moneyIn: "1580.00", moneyOut: "227.00", net: "1353.00", otherExcluded: 3 });
    // The counted pair is explained (net 0), not placed: the review still ties to the cent.
    expect(review.reconciliation).toMatchObject({ rowsUnexplained: 0, unexplained: "0.00" });
    const listed = JSON.stringify(review.notInPlan);
    for (const k of EXPIRED) expect(listed.includes(id[k]!), k).toBe(false);
    // Unanswered rows: tavern posted, grocer, payroll, cafe — never a hold.
    expect(review.reviewInbox.unresolvedInRange).toBe(4);
    expect(review.reviewInbox.badgeCount).toBe(4);

    const base = await withRule(false, () => buildBankingReview(HH, OWNER, { from: "2026-10-01", to: "2026-10-15", rowsPerBucket: 25, limit: 25 }));
    expect(base.cashFlow).toMatchObject({ moneyIn: "1780.00", moneyOut: "491.18", net: "1288.82", otherExcluded: 0 });
    expect(base.reviewInbox).toMatchObject({ unresolvedInRange: 9, badgeCount: 9 });
    expect(base.reconciliation).toMatchObject({ rowsUnexplained: 0, unexplained: "0.00" });
    const baseLedger = await withRule(false, () => get<{ rows: LedgerRowOut[] }>("/transactions/ledger?from=2026-10-01&to=2026-10-15&limit=100"));
    expect(baseLedger.rows.find((r) => r.id === id.carHold)!.runningBalance).toBe("2000.00");
  });

  it("⭐ the review badge never asks about an expired hold: 4 (base 9)", async () => {
    expect(await computeReviewCount(HH, OWNER)).toBe(4);
    expect(await withRule(false, () => computeReviewCount(HH, OWNER))).toBe(9);
  });

  it("⭐ spending: the week the tavern and hotel holds sit in, and the month — the posted tavern charge counts once; the holds are listed apart (expiredHolds)", async () => {
    // Week Sun 9/27 – Sat 10/3: the car, parking and tavern holds — all expired.
    const w0 = await buildSpendingFacts(HH, "2026-09-27", "2026-10-03");
    expect(w0.householdSpend).toEqual({ total: 0, transactionCount: 0 });
    expect(w0.excluded.expiredHolds).toBe(174.18);
    // Week Sun 10/4 – Sat 10/10: hotel hold (expired), tavern posted 90, grocer 45, bookshop 25.
    const w1 = await buildSpendingFacts(HH, "2026-10-04", "2026-10-10");
    expect(w1.householdSpend).toEqual({ total: 160, transactionCount: 3 });
    expect(w1.excluded.expiredHolds).toBe(200);
    const month = await buildSpendingFacts(HH, "2026-10-01", "2026-10-15");
    expect(month.householdSpend).toEqual({ total: 172, transactionCount: 4 });
    expect(month.byCategory.find((c) => c.categoryId === id.dining)?.total).toBe(90);
    // Base: every hold counted beside the rest.
    expect((await withRule(false, () => buildSpendingFacts(HH, "2026-09-27", "2026-10-03"))).householdSpend).toEqual({ total: 174.18, transactionCount: 3 });
    expect((await withRule(false, () => buildSpendingFacts(HH, "2026-10-04", "2026-10-10"))).householdSpend).toEqual({ total: 360, transactionCount: 4 });
    const baseMonth = await withRule(false, () => buildSpendingFacts(HH, "2026-10-01", "2026-10-15"));
    expect(baseMonth.householdSpend).toEqual({ total: 546.18, transactionCount: 8 });
    expect(baseMonth.byCategory.find((c) => c.categoryId === id.dining)?.total).toBe(154.18);
    expect(baseMonth.excluded.expiredHolds).toBe(0);
  });

  it("⭐ the Budget month: Dining's actual is the posted 90.00 once, and the weekly allowance too (base 154.18); its reconciliation with spending still closes", async () => {
    type Month = {
      lines: Array<{ categoryId: string; actualAmount: string; pendingAmount: string }>;
      allowance: { lines: Array<{ bucket: string; actual: string }> };
      replacedPendingIds: string[];
      spendingReconciliation: { householdSpendToDate: string; unexplained: string } | null;
    };
    const m = await get<Month>("/budget/months/2026-10-01");
    expect(m.lines.find((l) => l.categoryId === id.dining)).toMatchObject({ actualAmount: "90.00", pendingAmount: "0.00" });
    expect(m.allowance.lines.find((l) => l.bucket === "weekly")?.actual).toBe("90.00");
    expect(m.replacedPendingIds).toEqual([]);
    expect(m.spendingReconciliation).toMatchObject({ householdSpendToDate: "172.00", unexplained: "0.00" });
    const base = await withRule(false, () => get<Month>("/budget/months/2026-10-01"));
    expect(base.lines.find((l) => l.categoryId === id.dining)).toMatchObject({ actualAmount: "154.18", pendingAmount: "64.18" });
    expect(base.allowance.lines.find((l) => l.bucket === "weekly")?.actual).toBe("154.18");
    expect(base.spendingReconciliation).toMatchObject({ householdSpendToDate: "546.18", unexplained: "0.00" });
  });

  it("the card's weekly payoff (week of 9/27): the expired parking hold is no charge — 0.00 (base 30.00); the week of 10/4: the bookshop 25.00 both ways", async () => {
    const charges = async (week: string) =>
      (await computeWeeklyPayoff(HH, week, OWNER, { allCoverages: true })).cards.find((c) => c.accountId === CARD)!.weekCharges;
    expect(await charges("2026-09-27")).toBe(0);
    expect(await charges("2026-10-04")).toBe(25);
    expect(await withRule(false, () => charges("2026-09-27"))).toBe(30);
    expect(await withRule(false, () => charges("2026-10-04"))).toBe(25);
  });

  it("afford (the category plans it weighs): Dining spent this month 90 (base 154.18) — the Budget month's own read", async () => {
    const dining = (plans: Awaited<ReturnType<typeof loadCategoryPlans>>) => Number(plans.find((p) => p.categoryId === id.dining)?.spentMtd);
    expect(dining(await loadCategoryPlans(HH, "2026-10-15"))).toBe(90);
    expect(dining(await withRule(false, () => loadCategoryPlans(HH, "2026-10-15")))).toBe(154.18);
  });

  it("behavior facts and the review proposals never read an expired hold (base: the tavern is visited twice, 154.18, and a proposal asks about the tavern hold)", async () => {
    // Behavior facts read categorized spending and name merchants, not rows.
    const facts = await buildBehaviorFacts(HH, "2026-10-01", "2026-10-15");
    expect(facts.funFacts.mostVisitedMerchant).toMatchObject({ name: "Some Tavern 0042", count: 1, total: 90 });
    const baseFacts = await withRule(false, () => buildBehaviorFacts(HH, "2026-10-01", "2026-10-15"));
    expect(baseFacts.funFacts.mostVisitedMerchant).toMatchObject({ name: "Some Tavern 0042", count: 2, total: 154.18 });
    const proposals = JSON.stringify(await buildReviewProposals(HH, OWNER));
    for (const k of EXPIRED) expect(proposals.includes(id[k]!), k).toBe(false);
    expect(JSON.stringify(await withRule(false, () => buildReviewProposals(HH, OWNER))).includes(id.tavernHold!)).toBe(true);
  });

  it("the period breakdown (the money position's read), week Sun 10/4 – Sat 10/10: no expired hold among its rows; actual 160.00 = spending's week (base 360.00, the hotel hold among them)", async () => {
    const q = { period: "week" as const, start: "2026-10-04", rowsPerGroup: 50 };
    const b = await buildPeriodBreakdown(HH, OWNER, q);
    expect([b.actual, b.beside.householdSpend]).toEqual(["160.00", "160.00"]);
    const text = JSON.stringify(b);
    for (const k of EXPIRED) expect(text.includes(id[k]!), k).toBe(false);
    expect(text.includes(id.tavernPosted!)).toBe(true);
    const base = await withRule(false, () => buildPeriodBreakdown(HH, OWNER, q));
    expect([base.actual, base.beside.householdSpend]).toEqual(["360.00", "360.00"]);
    expect(JSON.stringify(base).includes(id.hotelHold!)).toBe(true);
  });

  it("the spine: this month's spending and the bank balance are the readers' own (172.00, 3,433.00)", async () => {
    const s = await get<{ spentMonth: number; spentWeek: number; bank: { balance: string } }>("/spine");
    expect(s.spentMonth).toBe(172);
    expect(s.spentWeek).toBe(12);
    expect(s.bank.balance).toBe("3433.00");
    const base = await withRule(false, () => get<{ spentMonth: number; bank: { balance: string } }>("/spine"));
    expect(base.spentMonth).toBe(546.18);
    expect(base.bank.balance).toBe("3368.82");
  });

  // ⭐ (F6 round 4) The readers round 3 missed (review findings 1 and 4).
  it("⭐ finding 1 — Reports › Budget: Dining's actual is the Budget page's 90.00 (base 154.18 on both); the flex total, pace and burndown read the same rows", async () => {
    type Month = { lines: Array<{ categoryId: string; actualAmount: string }> };
    const facts = await buildBudgetFacts(HH, "2026-10-01", 2);
    const page = await get<Month>("/budget/months/2026-10-01");
    const line = (cat: string) => facts.flex.lines.find((l) => l.categoryId === cat)!;
    // Parity: Reports › Budget's category actual = GET /budget/months' actualAmount.
    for (const cat of [id.dining!, id.groceries!]) {
      expect(line(cat).actual.toFixed(2), cat).toBe(page.lines.find((l) => l.categoryId === cat)!.actualAmount);
    }
    expect([line(id.dining!).actual, line(id.groceries!).actual]).toEqual([90, 45]);
    expect(facts.flex.actualTotal).toBe(135);
    // The burndown: the tavern hold (10/03) adds nothing; the posted 90 lands 10/05.
    const day = (d: string) => facts.flex.burndown.find((b) => b.date === d)!.actualCumulative;
    expect([day("2026-10-03"), day("2026-10-05"), day("2026-10-15")]).toEqual([0, 90, 135]);
    expect(facts.streak.rows.find((r) => r.categoryId === id.dining)!.cells.at(-1)).toMatchObject({ pct: 45 });

    // The kill switch: the base — both pages count the hold.
    const base = await withRule(false, () => buildBudgetFacts(HH, "2026-10-01", 2));
    const basePage = await withRule(false, () => get<Month>("/budget/months/2026-10-01"));
    const baseLine = base.flex.lines.find((l) => l.categoryId === id.dining)!;
    expect(baseLine.actual).toBe(154.18);
    expect(baseLine.actual.toFixed(2)).toBe(basePage.lines.find((l) => l.categoryId === id.dining)!.actualAmount);
    expect(base.flex.actualTotal).toBe(199.18);
    expect(base.flex.burndown.find((b) => b.date === "2026-10-03")!.actualCumulative).toBe(64.18);
  });

  it("finding 1 — the Avalanche extra from a budget line (actual mode): Dining's actual 90.00 (base 154.18); from the budget's net: expenses 135.00 (base 199.18)", async () => {
    await db
      .insert(avalancheSettingsTable)
      .values({ userId: OWNER, householdId: HH, extraSource: "budget_line", extraBudgetCategoryId: id.dining, budgetMode: "actual" })
      .onConflictDoUpdate({ target: avalancheSettingsTable.userId, set: { extraSource: "budget_line", extraBudgetCategoryId: id.dining, budgetMode: "actual" } });
    const line = (await resolveExtraForUser(HH, OWNER)) as { breakdown: { actual: string } };
    expect(Number(line.breakdown.actual)).toBe(90);
    const baseLine = (await withRule(false, () => resolveExtraForUser(HH, OWNER))) as { breakdown: { actual: string } };
    expect(Number(baseLine.breakdown.actual)).toBe(154.18);

    await db.update(avalancheSettingsTable).set({ extraSource: "budget_net" }).where(eq(avalancheSettingsTable.userId, OWNER));
    const net = (await resolveExtraForUser(HH, OWNER)) as { breakdown: { expenses: string } };
    const baseNet = (await withRule(false, () => resolveExtraForUser(HH, OWNER))) as typeof net;
    expect(net.breakdown.expenses).toBe("135.00");
    expect(baseNet.breakdown.expenses).toBe("199.18");
  });

  it("finding 4 — the GET /forecast bundle (Forecast › Reconcile): every checking row is sent; the expired ones say so (the same answer as GET /transactions) — (F6 round 5) the held car pair is expiredPair, not expiredHold", async () => {
    type Flags = { id: string; expiredHold: boolean; expiredPair: boolean };
    const bundle = await get<{ transactions: Flags[] }>("/forecast");
    const checkingExpired = ["tavernHold", "hotelHold", "hotelReversal"].map((k) => id[k]!).sort();
    expect(bundle.transactions.filter((t) => t.expiredHold).map((t) => t.id).sort()).toEqual(checkingExpired);
    expect(bundle.transactions.filter((t) => t.expiredPair).map((t) => t.id).sort()).toEqual([id.carHold!, id.carReversal!].sort());
    expect(bundle.transactions.some((t) => t.id === id.tavernPosted && !t.expiredHold)).toBe(true);
    const base = await withRule(false, () => get<{ transactions: Flags[] }>("/forecast"));
    expect(base.transactions.every((t) => t.expiredHold === false && t.expiredPair === false)).toBe(true);
  });

  it("nothing was deleted or rewritten: all eleven rows are still there, the holds still pending", async () => {
    const rows = await db.select({ id: transactionsTable.id, pending: transactionsTable.pending }).from(transactionsTable).where(eq(transactionsTable.userId, OWNER));
    expect(rows).toHaveLength(11);
    for (const k of EXPIRED) expect(rows.find((r) => r.id === id[k])?.pending, k).toBe(true);
  });
});
