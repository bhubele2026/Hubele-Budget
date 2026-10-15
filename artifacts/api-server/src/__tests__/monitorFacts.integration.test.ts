// (AI-3) loadMonitorFacts on a real (synthetic) household: confirmed bill
// payments, this month's spend against its line, the 72 h rows, and the
// detectors on top. The household has no bank, so the position is the
// no-bank one — nulls, never a false zero — and no money finding fires.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  budgetLinesTable,
  forecastResolutionsTable,
  recurringItemsTable,
  transactionsTable,
  agentFindingsTable,
  agentActionsTable,
  agentRunsTable,
} from "@workspace/db";
import { addDaysISO, monthBounds } from "@workspace/avalanche-core";
import { householdTodayISO } from "../lib/householdClock";
import { loadMonitorFacts } from "../monitor/facts";
import { runDetectors } from "../monitor/detectors";
import { runMonitor } from "../monitor/run";
import { createTestHousehold } from "./_helpers/testHousehold";

const OWNER = `mon-facts-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `mon-facts-o-${process.pid}-${randomUUID().slice(0, 8)}`;
let H: string;
let OH: string;
const TODAY = householdTodayISO();
const MERCHANT = "ZZQ STORE";

let billId: string;
let catId: string;
const txnIds: Record<string, string> = {};

async function addTxn(h: string, user: string, key: string, date: string, amount: string, description: string, extra: Record<string, unknown> = {}) {
  const [t] = await db
    .insert(transactionsTable)
    .values({ userId: user, householdId: h, occurredOn: date, description, amount, source: "manual", ...extra })
    .returning({ id: transactionsTable.id });
  txnIds[key] = t!.id;
  return t!.id;
}

beforeAll(async () => {
  H = (await createTestHousehold(OWNER)).householdId;
  OH = (await createTestHousehold(OTHER)).householdId;

  // A bill paid 4 times: 50, 50, 50 then 80 (confirmed matches).
  const [bill] = await db
    .insert(recurringItemsTable)
    .values({ userId: OWNER, householdId: H, name: "Synthetic Water", kind: "bill", amount: "50", frequency: "monthly", dayOfMonth: 8 })
    .returning({ id: recurringItemsTable.id });
  billId = bill!.id;
  const paid: Array<[string, number, string]> = [
    ["p1", 150, "50.00"],
    ["p2", 120, "50.00"],
    ["p3", 90, "50.00"],
    ["p4", 60, "80.00"],
  ];
  for (const [key, back, amt] of paid) {
    const id = await addTxn(H, OWNER, key, addDaysISO(TODAY, -back), `-${amt}`, "SYNTHETIC WATER UTILITY");
    await db.insert(forecastResolutionsTable).values({
      userId: OWNER, householdId: H, recurringItemId: billId, occurrenceDate: addDaysISO(TODAY, -back), status: "matched", matchedTxnId: id,
    });
  }
  // A "partial" resolution must not count as a payment amount.
  const part = await addTxn(H, OWNER, "part", addDaysISO(TODAY, -30), "-5.00", "SYNTHETIC WATER UTILITY");
  await db.insert(forecastResolutionsTable).values({ userId: OWNER, householdId: H, recurringItemId: billId, occurrenceDate: addDaysISO(TODAY, -30), status: "partial", matchedTxnId: part });

  // A category with a line, and spend on it this month.
  const [cat] = await db.insert(budgetCategoriesTable).values({ userId: OWNER, householdId: H, name: "Synthetic Dining", kind: "expense" }).returning({ id: budgetCategoriesTable.id });
  catId = cat!.id;
  await db.insert(budgetLinesTable).values({ userId: OWNER, householdId: H, monthStart: monthBounds(TODAY).start, categoryId: catId, plannedAmount: "300" });

  // Two identical charges within a day, a transfer pair that must be ignored.
  await addTxn(H, OWNER, "d1", addDaysISO(TODAY, -1), "-42.00", `${MERCHANT} #1001`);
  await addTxn(H, OWNER, "d2", TODAY, "-42.00", `${MERCHANT} #1002`);
  await addTxn(H, OWNER, "x1", addDaysISO(TODAY, -1), "-300.00", "XFER TO SAVINGS", { isTransfer: true });
  await addTxn(H, OWNER, "x2", TODAY, "-300.00", "XFER TO SAVINGS", { isTransfer: true });
  // Pending rows are not "posted".
  await addTxn(H, OWNER, "pend", TODAY, "-42.00", `${MERCHANT} #1003`, { pending: true });
  // Another household's identical rows never leak in.
  await addTxn(OH, OTHER, "o1", TODAY, "-42.00", `${MERCHANT} #1004`);
});

describe("loadMonitorFacts", () => {
  it("assembles bills, categories, recent rows and the no-bank position", async () => {
    const facts = await loadMonitorFacts(H, OWNER, TODAY);

    expect(facts.todayISO).toBe(TODAY);
    expect(facts.position.availableUntilPayday).toBeNull();
    expect(facts.freshness.stale).toBe(false);
    expect(facts.month.start).toBe(monthBounds(TODAY).start);
    expect(facts.month.daysLeft).toBe(facts.month.daysInMonth - Number(TODAY.slice(8)));

    const bill = facts.bills.find((b) => b.itemId === billId)!;
    expect(bill.payments.map((p) => [p.amount, p.source])).toEqual([
      [80, "matched"],
      [50, "matched"],
      [50, "matched"],
      [50, "matched"],
    ]);
    expect(bill.payments[0]!.txnId).toBe(txnIds.p4);

    const cat = facts.categories.find((c) => c.categoryId === catId)!;
    expect(cat).toMatchObject({ planned: 300, spentMtd: 0, isBillCategory: false });

    const ids = facts.recentRows.map((r) => r.id).sort();
    expect(ids).toEqual([txnIds.d1, txnIds.d2].sort());
    expect(facts.recentRows[0]!.signature).toBe(facts.recentRows[1]!.signature);
    expect(facts.recentRows.every((r) => r.signature !== "")).toBe(true);
  });

  it("the detectors find the bill increase (confirmed) and the duplicate pair, nothing else", async () => {
    const found = runDetectors(await loadMonitorFacts(H, OWNER, TODAY));
    expect(found.map((f) => f.kind).sort()).toEqual(["bill_increase", "duplicate_charge"]);
    const inc = found.find((f) => f.kind === "bill_increase")!;
    expect(inc).toMatchObject({ confidence: "confirmed", payload: { itemId: billId, txnId: txnIds.p4, latest: 80, median: 50, increase: 30 } });
    const dup = found.find((f) => f.kind === "duplicate_charge")!;
    expect((dup.payload.txnIds as string[]).sort()).toEqual([txnIds.d1, txnIds.d2].sort());
  });

  it("a real run over the household writes its findings with no merchant string, once", async () => {
    const r1 = await runMonitor(H, { trigger: "user", todayISO: TODAY });
    expect(r1).toMatchObject({ detected: 2, created: 2, summary: "2 findings, 2 new" });
    const r2 = await runMonitor(H, { trigger: "user", todayISO: TODAY });
    expect(r2.created).toBe(0);
    const findings = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, H));
    const actions = await db.select().from(agentActionsTable).where(eq(agentActionsTable.householdId, H));
    const runs = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, H));
    expect(findings).toHaveLength(2);
    expect(actions).toHaveLength(2);
    expect(runs).toHaveLength(2);
    const blob = JSON.stringify([findings, actions, runs]).toLowerCase();
    for (const s of ["zzq store", "synthetic water", "xfer"]) expect(blob).not.toContain(s);
    // The other household saw nothing of it.
    expect(await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, OH))).toHaveLength(0);
  });

  it("this month's spend on a budgeted category reaches the facts", async () => {
    await addTxn(H, OWNER, "dine", TODAY, "-120.00", "SYNTHETIC DINER", { categoryId: catId });
    const facts = await loadMonitorFacts(H, OWNER, TODAY);
    const cat = facts.categories.find((c) => c.categoryId === catId)!;
    expect(cat.spentMtd).toBe(120);
  });
});

// ⭐ (F6 round 5, review finding 4) A "matched" answer whose row is an expired hold
// — still pending more than 7 days after its date, never replaced — is no bill
// payment here either (Bills and the forecast already read it so): the monitor
// never sees a 130 that did not leave. When the payment posted under another
// name, the answer counts on that posted row (finding 5). Kill switch: as before.
describe("loadMonitorFacts — an answer on an expired hold (F6 round 5)", () => {
  const PO = `mon-facts-f6r5-${process.pid}-${randomUUID().slice(0, 8)}`;
  const ACCT = `acct-mon-f6r5-${randomUUID().slice(0, 8)}`;
  let PH = "";
  let powerId = "";
  const ids: Record<string, string> = {};
  const plaidTxn = async (key: string, back: number, amount: string, description: string, pending = false) => {
    const [t] = await db
      .insert(transactionsTable)
      .values({ userId: PO, householdId: PH, occurredOn: addDaysISO(TODAY, -back), description, amount, source: "plaid:lakeside", plaidAccountId: ACCT, pending })
      .returning({ id: transactionsTable.id });
    ids[key] = t!.id;
    return t!.id;
  };
  const answer = (txnId: string, back: number) =>
    db.insert(forecastResolutionsTable).values({ userId: PO, householdId: PH, recurringItemId: powerId, occurrenceDate: addDaysISO(TODAY, -back), status: "matched", matchedTxnId: txnId });
  const payments = async () =>
    (await loadMonitorFacts(PH, PO, TODAY)).bills.find((b) => b.itemId === powerId)!.payments.map((p) => [p.amount, p.txnId]);
  const increase = async () => runDetectors(await loadMonitorFacts(PH, PO, TODAY)).filter((f) => f.kind === "bill_increase" && f.payload.itemId === powerId);

  beforeAll(async () => {
    PH = (await createTestHousehold(PO)).householdId;
    const [bill] = await db
      .insert(recurringItemsTable)
      .values({ userId: PO, householdId: PH, name: "Synthetic Power", kind: "bill", amount: "100", frequency: "monthly", dayOfMonth: 2 })
      .returning({ id: recurringItemsTable.id });
    powerId = bill!.id;
    for (const back of [105, 75, 45]) await answer(await plaidTxn(`p${back}`, back, "-100.00", "SYNTHETIC POWER AUTOPAY"), back);
    // The latest answer names a −130 row still pending 13 days on: an expired hold.
    await answer(await plaidTxn("hold", 13, "-130.00", "SYNTHETIC POWER AUTOPAY", true), 13);
  });

  it("⭐ the expired hold pays nothing and raises no bill_increase (kill switch: 130 paid, the finding fires)", async () => {
    expect(await payments()).toEqual([[100, ids.p45], [100, ids.p75], [100, ids.p105]]);
    expect(await increase()).toEqual([]);
    vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
    try {
      expect((await payments())[0]).toEqual([130, ids.hold]);
      expect(await increase()).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the payment posted under another name (−130, a day later): the answer counts on the posted row, as in Bills", async () => {
    await plaidTxn("posted", 12, "-130.00", "SYNPWR WEB PMT 4471");
    expect((await payments())[0]).toEqual([130, ids.posted]);
    expect(await increase()).toHaveLength(1);
  });
});
