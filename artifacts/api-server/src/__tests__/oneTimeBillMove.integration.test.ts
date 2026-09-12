// ⭐ OWNER DECISION 9 — MOVING A ONE-TIME BILL KEEPS ITS ANSWERS.
//
// "Moving the same obligation should preserve its notes, review history, and
// resolution state. Never rewrite the date of an actual bank payment. Revalidate
// a match if the edited date makes it questionable."
//
// Before this change `PATCH /recurring-items/:id` rewrote a one-time bill's date
// and left its answers on the old date (`resolutionRemap` never maps one-time
// bills), so a paid $300 bill moved from 9/20 to 9/25 came back unpaid.
//
// Today is pinned to Sat 2026-09-19 (noon Chicago). The bank snapshot reads
// $2,000 at 10:00 CT and already holds the −$300 "ROOF CO" row dated 9/19.
// The matcher's candidate window is 10 days before to 14 days after the plan;
// its loose amount tolerance is max($25, 25%). The Forecast Review register
// reaches back to the first of last month (8/01) and ahead 90 days (12/18).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `onetime-move-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import {
  db,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { computeCashSignal, type CashSignal } from "../lib/cashSignal";
import { computeReviewCount } from "../lib/reviewCount";
import { archiveExpiredOneTime, buildBillsSummary } from "../lib/billsSummary";
import recurringRouter from "../routes/recurring";
import forecastRouter from "../routes/forecast";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(recurringRouter);
app.use(forecastRouter);

let server: Server;
let baseUrl: string;

const SAT_SEP_19 = new Date("2026-09-19T17:00:00Z"); // 12:00 in Chicago
const CHASE = "chase-onetime-move";

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, TEST_HOUSEHOLD_ID));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

beforeEach(async () => {
  vi.setSystemTime(SAT_SEP_19);
  await cleanup();
  await snapshot();
});

afterEach(() => {
  vi.useRealTimers();
});

async function snapshot(): Promise<void> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: item!.id, accountId: CHASE, name: "Chase Checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "500",
    bankSnapshotBalance: "2000",
    bankSnapshotAt: new Date("2026-09-19T15:00:00Z"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
  });
}

const BILL = { name: "Roof repair", kind: "expense", amount: "300" };

async function oneTime(anchorDate: string): Promise<string> {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, ...BILL, frequency: "onetime", anchorDate, active: "true" })
    .returning();
  return r!.id;
}

async function row(
  occurredOn: string,
  amount: string,
  description = "ROOF CO",
  account: { plaidAccountId: string; source: string } = { plaidAccountId: CHASE, source: "plaid:chase" },
): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description,
      amount,
      ...account,
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

async function resolve(status: string, itemId: string, occurrenceDate: string, extra: { txnId?: string; rescheduledTo?: string } = {}) {
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    recurringItemId: itemId,
    occurrenceDate,
    status,
    matchedTxnId: extra.txnId ?? null,
    rescheduledTo: extra.rescheduledTo ?? null,
  });
}

/** What the Bills editor sends: the whole form. */
async function patch(id: string, over: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${baseUrl}/recurring-items/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...BILL, frequency: "onetime", active: "true", dayOfMonth: null, categoryId: null, ...over }),
  });
  return res.status;
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Stored answers for an item: `status@occurrenceDate#txn` (→ rescheduledTo). */
async function stored(itemId: string): Promise<string[]> {
  const rows = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, TEST_HOUSEHOLD_ID));
  return rows
    .filter((r) => r.recurringItemId === itemId)
    .map((r) => `${r.status}@${r.occurrenceDate}#${r.matchedTxnId ?? "-"}${r.rescheduledTo ? `→${r.rescheduledTo}` : ""}`)
    .sort();
}

async function bankRow(id: string) {
  const [t] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
  return { occurredOn: t!.occurredOn, amount: t!.amount, description: t!.description };
}

const signal = () => computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 90 });
const planOf = (sig: CashSignal, itemId: string) =>
  (sig.events ?? []).filter((e) => e.itemId === itemId).map((e) => [e.date, e.amount, e.assumption]);
const listedOf = (sig: CashSignal, itemId: string) => [
  ...(sig.overdueOutsideForecast ?? []).filter((p) => p.itemId === itemId).map((p) => ["overdue", p.dueDate, p.amount]),
  ...(sig.overdueAssumedPaid ?? []).filter((p) => p.itemId === itemId).map((p) => ["assumed_paid", p.dueDate, p.planAmount]),
];
const balanceOn = (sig: CashSignal, date: string) => sig.daily?.find((d) => d.date === date)?.balance;
const reviewCount = () => computeReviewCount(TEST_HOUSEHOLD_ID, TEST_USER);
const billRow = async (itemId: string, month: string) =>
  (await buildBillsSummary(TEST_HOUSEHOLD_ID, TEST_USER, month)).bills.find((b) => b.item.id === itemId);
const activeOf = async (id: string) =>
  (await db.select().from(recurringItemsTable).where(eq(recurringItemsTable.id, id)))[0]!.active;

/** A $300 one-time bill on 9/20, matched to the −$300 row dated 9/19. */
async function paidRoof(): Promise<{ id: string; txn: string }> {
  const id = await oneTime("2026-09-20");
  const txn = await row("2026-09-19", "-300.00");
  await resolve("matched", id, "2026-09-20", { txnId: txn });
  return { id, txn };
}

describe("moving a one-time bill keeps its answers (owner decision 9)", () => {
  it("9/20 → 9/25, inside the window: still matched — off the curve, not overdue, not in Review, paid on Bills", async () => {
    const { id, txn } = await paidRoof();
    expect(await patch(id, { anchorDate: "2026-09-25" })).toBe(200);

    expect(await stored(id)).toEqual([`matched@2026-09-25#${txn}`]);
    expect(await bankRow(txn)).toEqual({ occurredOn: "2026-09-19", amount: "-300.00", description: "ROOF CO" });
    const sig = await signal();
    expect(planOf(sig, id)).toEqual([]);
    expect(listedOf(sig, id)).toEqual([]);
    expect(balanceOn(sig, "2026-09-25")).toBe("2000.00");
    expect(await reviewCount()).toBe(0);
    expect((await billRow(id, "2026-09-01"))?.actualAmount).toBe("300.00");
  });

  it("9/20 → 10/20, outside the window: needs review — back on the curve at 10/20, in Review, not paid; the bank row keeps 9/19", async () => {
    const { id, txn } = await paidRoof();
    expect(await patch(id, { anchorDate: "2026-10-20" })).toBe(200);

    expect(await stored(id)).toEqual([`needs_review@2026-10-20#${txn}`]);
    expect(await bankRow(txn)).toEqual({ occurredOn: "2026-09-19", amount: "-300.00", description: "ROOF CO" });
    const sig = await signal();
    expect(planOf(sig, id)).toEqual([["2026-10-20", "-300.00", null]]);
    expect(balanceOn(sig, "2026-10-19")).toBe("2000.00");
    expect(balanceOn(sig, "2026-10-20")).toBe("1700.00");
    expect(sig.matches ?? []).toEqual([]);
    expect(await reviewCount()).toBe(1);
    expect((await billRow(id, "2026-09-01"))?.actualAmount).toBe("0.00");
    expect((await billRow(id, "2026-10-01"))?.actualAmount).toBe("0.00");

    // The Forecast bundle carries the pair for "Match needs review".
    const bundle = await fetch(`${baseUrl}/forecast`).then((r) => r.json() as Promise<{ resolutions: Array<Record<string, unknown>> }>);
    expect(bundle.resolutions.filter((r) => r.recurringItemId === id)).toEqual([
      expect.objectContaining({ status: "needs_review", occurrenceDate: "2026-10-20", matchedTxnId: txn, txnDate: "2026-09-19" }),
    ]);
  });

  it("control: Confirm on a needs-review pair writes matched and replaces it", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-10-20" });
    const res = await post("/forecast/resolutions", { recurringItemId: id, occurrenceDate: "2026-10-20", status: "matched", matchedTxnId: txn });
    expect(res.status).toBe(200);
    expect(await stored(id)).toEqual([`matched@2026-10-20#${txn}`]);
    expect(planOf(await signal(), id)).toEqual([]);
    expect(await reviewCount()).toBe(0);
  });

  it("Not this on a needs-review pair writes not_match and replaces it: the bill stays planned, the row stays in Review", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-10-20" });
    const res = await post("/forecast/resolutions", { recurringItemId: id, occurrenceDate: "2026-10-20", status: "not_match", matchedTxnId: txn });
    expect(res.status).toBe(200);
    expect(await stored(id)).toEqual([`not_match@2026-10-20#${txn}`]);
    expect(planOf(await signal(), id)).toEqual([["2026-10-20", "-300.00", null]]);
    expect(await reviewCount()).toBe(1);
  });

  it("a Forecast Move of a needs-review bill keeps the pair open beside the move", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-10-20" });
    const res = await post("/forecast/resolutions", {
      recurringItemId: id,
      occurrenceDate: "2026-10-20",
      status: "rescheduled",
      rescheduledTo: "2026-10-22",
    });
    expect(res.status).toBe(200);
    expect(await stored(id)).toEqual([`needs_review@2026-10-20#${txn}`, "rescheduled@2026-10-20#-→2026-10-22"].sort());
    expect(planOf(await signal(), id)).toEqual([["2026-10-22", "-300.00", null]]);
    expect(await reviewCount()).toBe(1);
  });

  it("moving a needs-review bill back inside the window does not mark it paid again", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-10-20" });
    await patch(id, { anchorDate: "2026-09-20" });
    expect(await stored(id)).toEqual([`needs_review@2026-09-20#${txn}`]);
    expect(planOf(await signal(), id)).toEqual([["2026-09-20", "-300.00", null]]);
  });

  it("a skipped one-time bill moved stays skipped", async () => {
    const id = await oneTime("2026-09-20");
    await resolve("skipped", id, "2026-09-20");
    expect(await patch(id, { anchorDate: "2026-10-20" })).toBe(200);
    expect(await stored(id)).toEqual(["skipped@2026-10-20#-"]);
    expect(planOf(await signal(), id)).toEqual([]);
  });

  it("a Forecast Move on the old date is replaced by the edit; a rejection follows the bill", async () => {
    const id = await oneTime("2026-09-20");
    const other = await row("2026-09-05", "-300.00", "OTHER");
    await resolve("rescheduled", id, "2026-09-20", { rescheduledTo: "2026-09-23" });
    await resolve("not_match", id, "2026-09-20", { txnId: other });
    expect(await patch(id, { anchorDate: "2026-09-26" })).toBe(200);
    expect(await stored(id)).toEqual([`not_match@2026-09-26#${other}`]);
    expect(planOf(await signal(), id)).toEqual([["2026-09-26", "-300.00", null]]);
  });

  it("a match written on the moved-to date (pre-PR6) follows the bill too", async () => {
    const id = await oneTime("2026-09-20");
    const txn = await row("2026-09-19", "-300.00");
    await resolve("rescheduled", id, "2026-09-20", { rescheduledTo: "2026-09-23" });
    await resolve("matched", id, "2026-09-23", { txnId: txn });
    await patch(id, { anchorDate: "2026-09-25" });
    expect(await stored(id)).toEqual([`matched@2026-09-25#${txn}`]);
    expect(planOf(await signal(), id)).toEqual([]);
  });

  it("control: no change, or a change away from one-time, leaves a match where it is", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-09-20" });
    expect(await stored(id)).toEqual([`matched@2026-09-20#${txn}`]);
    await patch(id, { frequency: "monthly", dayOfMonth: 25, anchorDate: "2026-09-25" });
    expect(await stored(id)).toEqual([`matched@2026-09-20#${txn}`]);
  });

  it("control: a recurring bill's edit is unchanged — the stored answer keeps its date and resolutionRemap maps it", async () => {
    const [monthly] = await db
      .insert(recurringItemsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Water", kind: "expense", amount: "80", frequency: "monthly", dayOfMonth: 14, anchorDate: "2026-01-14", active: "true" })
      .returning();
    const txn = await row("2026-09-14", "-80.00", "CITY WATER");
    await resolve("matched", monthly!.id, "2026-09-14", { txnId: txn });
    expect(await patch(monthly!.id, { name: "Water", amount: "80", frequency: "monthly", dayOfMonth: 20, anchorDate: "2026-01-14" })).toBe(200);
    expect(await stored(monthly!.id)).toEqual([`matched@2026-09-14#${txn}`]);
    expect(planOf(await signal(), monthly!.id).map((p) => p[0])).not.toContain("2026-09-20");
  });

  it("control: 'Create another bill' is a new item with no answers; the original keeps its match", async () => {
    const { id, txn } = await paidRoof();
    const created = await post("/recurring-items", { ...BILL, frequency: "onetime", active: "true", anchorDate: "2026-10-20" });
    expect(created.status).toBe(201);
    const newId = String(created.json.id);
    expect(newId).not.toBe(id);
    expect(await stored(newId)).toEqual([]);
    expect(await stored(id)).toEqual([`matched@2026-09-20#${txn}`]);
    const sig = await signal();
    expect(planOf(sig, newId)).toEqual([["2026-10-20", "-300.00", null]]);
    expect(planOf(sig, id)).toEqual([]);
  });
});

describe("review H1 — amount and kind are revalidated with the date", () => {
  it("9/28 and $3,000 in one save: needs review, the $3,000 bill on the curve (9/28 balance −1,000.00), in Review", async () => {
    const { id, txn } = await paidRoof();
    expect(await patch(id, { anchorDate: "2026-09-28", amount: "3000" })).toBe(200);
    expect(await stored(id)).toEqual([`needs_review@2026-09-28#${txn}`]);
    const sig = await signal();
    expect(planOf(sig, id)).toEqual([["2026-09-28", "-3000.00", null]]);
    expect(balanceOn(sig, "2026-09-28")).toBe("-1000.00");
    expect(await reviewCount()).toBe(1);
  });

  it("$3,000 on the same date: needs review too", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-09-20", amount: "3000" });
    expect(await stored(id)).toEqual([`needs_review@2026-09-20#${txn}`]);
    expect(planOf(await signal(), id)).toEqual([["2026-09-20", "-3000.00", null]]);
  });

  it("expense → income with a new date: a debit never pays an income plan", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-09-25", kind: "income" });
    expect(await stored(id)).toEqual([`needs_review@2026-09-25#${txn}`]);
    // `events` lists outflows only; the +$300 income is on the curve on 9/25.
    const sig = await signal();
    expect(balanceOn(sig, "2026-09-24")).toBe("2000.00");
    expect(balanceOn(sig, "2026-09-25")).toBe("2300.00");
  });

  it("control: $320 on 9/25 stays within max($25, 25%) and stays matched", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-09-25", amount: "320" });
    expect(await stored(id)).toEqual([`matched@2026-09-25#${txn}`]);
  });
});

describe("review M1 — one decision per key when the new date already holds a stranded answer", () => {
  it("neither passes: the live match needs review, the stranded one is dropped, the bill is on the curve", async () => {
    const id = await oneTime("2026-09-20");
    const stale = await row("2026-09-02", "-300.00", "ROOF CO DEPOSIT");
    const live = await row("2026-09-19", "-300.00");
    await resolve("matched", id, "2026-10-01", { txnId: stale });
    await resolve("matched", id, "2026-09-20", { txnId: live });
    await patch(id, { anchorDate: "2026-10-01" });
    expect(await stored(id)).toEqual([`needs_review@2026-10-01#${live}`]);
    expect(planOf(await signal(), id)).toEqual([["2026-10-01", "-300.00", null]]);
  });

  it("the stranded one passes and the live one does not: only the passing match is kept", async () => {
    const id = await oneTime("2026-09-20");
    const near = await row("2026-09-18", "-300.00");
    const far = await row("2026-09-05", "-300.00", "ROOF CO EARLY");
    await resolve("matched", id, "2026-09-25", { txnId: near });
    await resolve("matched", id, "2026-09-20", { txnId: far });
    await patch(id, { anchorDate: "2026-09-25" });
    expect(await stored(id)).toEqual([`matched@2026-09-25#${near}`]);
    expect(planOf(await signal(), id)).toEqual([]);
  });
});

describe("review M2 — every needs-review answer can be answered", () => {
  it("(a) moved to 7/01, before the Review register: the match is cleared, not left unanswerable; the 60-day rule archives the bill", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-07-01" });
    expect(await stored(id)).toEqual([]);
    expect(await bankRow(txn)).toEqual({ occurredOn: "2026-09-19", amount: "-300.00", description: "ROOF CO" });
    await archiveExpiredOneTime(TEST_HOUSEHOLD_ID);
    expect(await activeOf(id)).toBe("false");
  });

  it("(b) paid from a card row Review cannot show: the match is cleared and the bill is unpaid on its new date", async () => {
    const id = await oneTime("2026-09-20");
    const card = await row("2026-09-19", "-300.00", "ROOF CO", { plaidAccountId: "amex-onetime-move", source: "plaid:amex" });
    await resolve("matched", id, "2026-09-20", { txnId: card });
    await patch(id, { anchorDate: "2026-10-20" });
    expect(await stored(id)).toEqual([]);
    expect(planOf(await signal(), id)).toEqual([["2026-10-20", "-300.00", null]]);
  });

  it("(c) leaving one-time clears a needs-review answer: the row is no longer claimed", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-10-20" });
    expect(await stored(id)).toEqual([`needs_review@2026-10-20#${txn}`]);
    await patch(id, { frequency: "monthly", dayOfMonth: 20, anchorDate: "2026-10-20" });
    expect(await stored(id)).toEqual([]);
    expect(await reviewCount()).toBe(1);
  });

  it("(d) a needs-review answer on another date does not hold the bill active", async () => {
    const id = await oneTime("2026-07-01");
    const txn = await row("2026-09-19", "-300.00");
    await resolve("needs_review", id, "2026-09-01", { txnId: txn });
    await archiveExpiredOneTime(TEST_HOUSEHOLD_ID);
    expect(await activeOf(id)).toBe("false");
  });

  it("moved to 9/01 (18 days before its row, inside the register): needs review, listed overdue, still active", async () => {
    const { id, txn } = await paidRoof();
    await patch(id, { anchorDate: "2026-09-01" });
    expect(await stored(id)).toEqual([`needs_review@2026-09-01#${txn}`]);
    await archiveExpiredOneTime(TEST_HOUSEHOLD_ID);
    expect(await activeOf(id)).toBe("true");
    expect(listedOf(await signal(), id)).toEqual([["overdue", "2026-09-01", "-300.00"]]);
  });

  it("control: a matched one-time bill dated before today is archived as before", async () => {
    const id = await oneTime("2026-09-10");
    const txn = await row("2026-09-10", "-300.00");
    await resolve("matched", id, "2026-09-10", { txnId: txn });
    await archiveExpiredOneTime(TEST_HOUSEHOLD_ID);
    expect(await activeOf(id)).toBe("false");
  });
});

describe("review M3 — a partial that needs review stays a partial", () => {
  it("inside the window it stays partial (the $100 remainder moves with it)", async () => {
    const id = await oneTime("2026-09-20");
    const txn = await row("2026-09-19", "-200.00");
    await resolve("partial", id, "2026-09-20", { txnId: txn });
    await patch(id, { anchorDate: "2026-09-22" });
    expect(await stored(id)).toEqual([`partial@2026-09-22#${txn}`]);
    expect(planOf(await signal(), id)).toEqual([["2026-09-22", "-100.00", null]]);
  });

  it("outside it: needs_review_partial, in Review, whole bill on the curve; answering Partial leaves $100 (10/20 balance 1,900.00)", async () => {
    const id = await oneTime("2026-09-20");
    const txn = await row("2026-09-19", "-200.00");
    await resolve("partial", id, "2026-09-20", { txnId: txn });
    await patch(id, { anchorDate: "2026-10-20" });
    expect(await stored(id)).toEqual([`needs_review_partial@2026-10-20#${txn}`]);
    expect(planOf(await signal(), id)).toEqual([["2026-10-20", "-300.00", null]]);
    expect(await reviewCount()).toBe(1);

    const res = await post("/forecast/resolutions", { recurringItemId: id, occurrenceDate: "2026-10-20", status: "partial", matchedTxnId: txn });
    expect(res.status).toBe(200);
    expect(await stored(id)).toEqual([`partial@2026-10-20#${txn}`]);
    const sig = await signal();
    expect(planOf(sig, id)).toEqual([["2026-10-20", "-100.00", null]]);
    expect(balanceOn(sig, "2026-10-20")).toBe("1900.00");
  });

  it("Not this replaces a needs_review_partial", async () => {
    const id = await oneTime("2026-09-20");
    const txn = await row("2026-09-19", "-200.00");
    await resolve("partial", id, "2026-09-20", { txnId: txn });
    await patch(id, { anchorDate: "2026-10-20" });
    await post("/forecast/resolutions", { recurringItemId: id, occurrenceDate: "2026-10-20", status: "not_match", matchedTxnId: txn });
    expect(await stored(id)).toEqual([`not_match@2026-10-20#${txn}`]);
  });

  it("a partial whose new amount the row now covers needs review rather than turning paid", async () => {
    const id = await oneTime("2026-09-20");
    const txn = await row("2026-09-19", "-200.00");
    await resolve("partial", id, "2026-09-20", { txnId: txn });
    await patch(id, { anchorDate: "2026-09-22", amount: "200" });
    expect(await stored(id)).toEqual([`needs_review_partial@2026-09-22#${txn}`]);
    expect(planOf(await signal(), id)).toEqual([["2026-09-22", "-200.00", null]]);
  });
});

describe("review L1 — a match on a deleted row is not carried", () => {
  it("the row is gone: the match is dropped and the bill is unpaid on its new date", async () => {
    const { id, txn } = await paidRoof();
    await db.delete(transactionsTable).where(eq(transactionsTable.id, txn));
    await patch(id, { anchorDate: "2026-09-25" });
    expect(await stored(id)).toEqual([]);
    expect(planOf(await signal(), id)).toEqual([["2026-09-25", "-300.00", null]]);
  });
});
