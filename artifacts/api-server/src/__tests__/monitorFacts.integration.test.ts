// (AI-3) loadMonitorFacts on a real (synthetic) household: confirmed bill
// payments, this month's spend against its line, the 72 h rows, and the
// detectors on top. The household has no bank, so the position is the
// no-bank one — nulls, never a false zero — and no money finding fires.

import { describe, it, expect, beforeAll } from "vitest";
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
