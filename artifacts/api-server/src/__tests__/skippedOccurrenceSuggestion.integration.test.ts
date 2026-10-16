// ⭐ (Task 6, A2) THE UNCONFIRMED LOAN-PAYMENT ROW AND THE SKIPPED BILL — one
// fixture with the live household's SHAPE, every name, amount and date synthetic:
//
//   a monthly credit line, $820.00 on the 2nd ("Credit Line (Northwind)");
//   April's occurrence the household MATCHED to a row "NWD LNS PMT" −861.37;
//   May's occurrence SKIPPED; February's and March's MISSED;
//   this week's row "NWD LNS PMT" −861.37 (Plaid LOAN_PAYMENTS), no category,
//   that someone marked "not a planned payment" (`ignored_unforecasted`).
//
// Before the repair: Spending called the row Unconfirmed (the evidence rule),
// Banking called it "Marked unplanned" (it never read the evidence), and nothing
// offered the one decision that resolves it (May's occurrence was skipped, so
// the matcher never looked at it; the evidence had no target).
//
// What this file proves (the app proposes; nothing is written until the owner answers):
//   1. Banking places the row in Unclear (evidence_unresolved) with the evidence
//      ("bank says loan payment") and a suggestion naming May's occurrence,
//      planned −820.00, skipped;
//   2. the ledger offers May as a SUGGESTION only (tier 3, never off the curve):
//      May stays skipped, `matches` never names the row;
//   3. Spending's Unconfirmed figure is the same row, unchanged;
//   4. Match = ONE write (the skip and the "not planned" answer replaced by the
//      match); the forecast then shows May matched by the row, Banking moves the
//      row to Amount differences (confirmed), Spending stops calling it Unconfirmed;
//   5. Undo puts back exactly what the Match replaced (same ids, statuses, times);
//   6. "Not this" keeps the skip, drops the suggestion, and leaves the row Unclear;
//   7. an undo that names answers the write could not have replaced is refused,
//      nothing written.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `t6-skipped-${process.pid}-${randomUUID().slice(0, 8)}`;
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

import {
  db,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { GetBankingReviewResponse } from "@workspace/api-zod";
import bankingRouter from "../routes/banking";
import forecastRouter from "../routes/forecast";
import moneyRouter from "../routes/money";
import { computeCashSignalDetailed } from "../lib/cashSignal";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-05-14T12:00:00-05:00"); // a Thursday; the week is May 10–16
const WEEK = { from: "2026-05-10", to: "2026-05-14" };
const LINE = { name: "Credit Line (Northwind)", amount: "820.00", day: 2 };
const MAY = "2026-05-02";
const PFC = { pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT" };

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
for (const r of [bankingRouter, forecastRouter, moneyRouter]) app.use(r);

let server: Server;
let baseUrl = "";
let itemId = "";
let checkingExt = "";
const row = { april: "", may: "", grocer: "" };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const get = async (path: string): Promise<Json> => {
  const r = await call("GET", path);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const review = async (): Promise<Json> => {
  const body = await get(`/banking/review?from=${WEEK.from}&to=${WEEK.to}&rowsPerBucket=20`);
  expect(() => GetBankingReviewResponse.parse(body)).not.toThrow();
  return body;
};
/** Where the row sits: "<bucket> <reason>", and the row itself. */
async function placed(txnId: string): Promise<{ where: string; row: Json }> {
  const r = await review();
  for (const b of ["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"]) {
    const hit = (r.notInPlan[b].rows as Json[]).find((x) => x.id === txnId);
    if (hit) return { where: `${b} ${hit.reason}`, row: hit };
  }
  return { where: "asPlanned", row: {} };
}
const week = () => get(`/money/period-breakdown?period=week&start=${WEEK.from}`);
const ledger = async () => (await computeCashSignalDetailed(HH, OWNER, { horizonDays: 90 })).ledger;
const answers = async () =>
  (await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, HH)))
    .map((r) => ({ id: r.id, status: r.status, item: r.recurringItemId, on: r.occurrenceDate, txn: r.matchedTxnId, at: r.createdAt.toISOString() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

async function cleanup(): Promise<void> {
  if (!HH) return;
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, HH));
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, HH));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
}

/** The household's answers as the live shape has them. */
async function seedAnswers(): Promise<void> {
  const owned = { userId: OWNER, householdId: HH };
  await db.insert(forecastResolutionsTable).values([
    { ...owned, recurringItemId: itemId, occurrenceDate: "2026-04-02", status: "matched", matchedTxnId: row.april },
    { ...owned, recurringItemId: itemId, occurrenceDate: MAY, status: "skipped", matchedTxnId: null },
    { ...owned, recurringItemId: itemId, occurrenceDate: "2026-03-02", status: "missed", matchedTxnId: null },
    { ...owned, recurringItemId: itemId, occurrenceDate: "2026-02-02", status: "missed", matchedTxnId: null },
    { ...owned, recurringItemId: null, occurrenceDate: null, status: "ignored_unforecasted", matchedTxnId: row.may },
  ]);
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  const owned = { userId: OWNER, householdId: HH };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...owned, itemId: `t6-item-${randomUUID()}`, accessToken: "t", institutionName: "Northgate Bank", institutionSlug: "chase", lastSyncedAt: new Date("2026-05-14T07:00:00-05:00") })
    .returning();
  checkingExt = `t6-chk-${randomUUID().slice(0, 8)}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ ...owned, itemId: item!.id, accountId: checkingExt, name: "Everyday Checking", mask: "0417", type: "depository", subtype: "checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...owned,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "500.00",
    bankSnapshotBalance: "2400.00",
    bankSnapshotAt: new Date("2026-05-09T08:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
    bankSnapshotMask: "0417",
  });
  const [bill] = await db
    .insert(recurringItemsTable)
    .values({ ...owned, name: LINE.name, kind: "bill", amount: LINE.amount, frequency: "monthly", dayOfMonth: LINE.day, anchorDate: "2026-01-02", active: "true" })
    .returning();
  itemId = bill!.id;
  const txn = async (on: string, description: string, amount: string, pfc: { pfcPrimary: string; pfcDetailed: string }) => {
    const [r] = await db
      .insert(transactionsTable)
      .values({
        ...owned,
        occurredOn: on,
        createdAt: createdAtStartOfHouseholdDay(on),
        description,
        amount,
        plaidAccountId: checkingExt,
        plaidTransactionId: `t6-${randomUUID().slice(0, 8)}`,
        source: "plaid:chase",
        categoryId: null,
        pending: false,
        forecastFlag: true,
        ...pfc,
      })
      .returning({ id: transactionsTable.id });
    return r!.id;
  };
  row.april = await txn("2026-04-12", "NWD LNS PMT", "-861.37", PFC);
  row.may = await txn("2026-05-12", "NWD LNS PMT", "-861.37", PFC);
  row.grocer = await txn("2026-05-11", "CORNER GROCER", "-42.18", { pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_GROCERIES" });

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(async () => {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, HH));
  await seedAnswers();
});

afterAll(async () => {
  vi.useRealTimers();
  if (server) await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

describe("(Task 6, A2) the unconfirmed loan-payment row and the skipped bill", () => {
  it("1. Banking: Unclear (evidence_unresolved), the bank's words, and a suggestion naming the skipped occurrence", async () => {
    const { where, row: r } = await placed(row.may);
    expect(where).toBe("uncertain evidence_unresolved");
    expect(r.kind).toBe("spending");
    expect(r.plan).toBeNull();
    expect(r.rowEvidence).toEqual({
      class: "unresolved",
      reason: "loan_payment",
      items: [
        { field: "pfc_primary", value: "LOAN_PAYMENTS" },
        { field: "pfc_detailed", value: "LOAN_PAYMENTS_OTHER_PAYMENT" },
      ],
      suggestion: {
        kind: "loan_payment",
        detail: null,
        target: { kind: "bill", id: itemId, label: LINE.name, planKey: `${itemId}|${MAY}`, occurrenceDate: MAY, planned: "-820.00", skipped: true },
      },
    });
    const rv = await review();
    expect(rv.notInPlan.confirmedUnplanned.count).toBe(0);
    expect(rv.notInPlan.uncertain.byReason.evidence_unresolved).toMatchObject({ count: 1, moneyOut: "861.37" });
    // Every row is still placed once: nothing unexplained.
    expect(rv.reconciliation).toEqual({ rowsPlaced: 2, rowsUnexplained: 0, unexplained: "0.00" });
    // The grocery row is a known purchase nobody planned: unchanged.
    expect((await placed(row.grocer)).where).toBe("unmatched no_plan");
  });

  it("2. the ledger: May is a suggestion only — still skipped, off the curve, never in `matches`", async () => {
    const l = await ledger();
    const may = l.planOccurrences.find((o) => o.planKey === `${itemId}|${MAY}`)!;
    expect(may.fate).toBe("skipped");
    expect(may.txnId).toBeNull();
    expect(l.matches.some((m) => m.txnId === row.may || m.planKey === may.planKey)).toBe(false);
    expect(l.skippedSuggestions).toHaveLength(1);
    expect(l.skippedSuggestions[0]).toMatchObject({ planKey: may.planKey, txnId: row.may, tier: 3, offCurve: false, evidence: null });
    // Nothing of May's on the curve.
    expect(l.items.some((i) => i.kind === "plan" && (i as { itemId: string }).itemId === itemId && i.date >= "2026-05-01" && i.date <= "2026-05-31")).toBe(false);
  });

  it("3. Spending: the same row is Unconfirmed, and the figure is the row (unchanged)", async () => {
    const w = await week();
    expect(w.unresolved.amount).toBe("861.37");
    expect(w.unresolved.count).toBe(1);
    expect(w.unresolved.rows[0].id).toBe(row.may);
    expect(w.unresolved.rows[0].evidence.reason).toBe("loan_payment");
    expect(w.known).toBe("42.18");
    expect(w.provisional).toBe(true);
  });

  it("4–5. Match writes once (skip → matched); the forecast, Banking and Spending follow; Undo puts back exactly what it replaced", async () => {
    const before = await answers();
    const m = await call("POST", "/forecast/resolutions", { recurringItemId: itemId, occurrenceDate: MAY, status: "matched", matchedTxnId: row.may });
    expect(m.status).toBe(200);
    // One insert; the two answers it replaced are named.
    expect(m.body.status).toBe("matched");
    expect((m.body.replaced as Json[]).map((x) => x.status).sort()).toEqual(["ignored_unforecasted", "skipped"]);
    const after = await answers();
    expect(after).toHaveLength(before.length - 1);
    expect(after.filter((a) => a.on === MAY).map((a) => `${a.status}#${a.txn}`)).toEqual([`matched#${row.may}`]);

    // The forecast: May is matched, paid by the row.
    const l = await ledger();
    const may = l.planOccurrences.find((o) => o.planKey === `${itemId}|${MAY}`)!;
    expect(may.fate).toBe("matched");
    expect(may.txnId).toBe(row.may);
    expect(l.skippedSuggestions).toEqual([]);
    // Banking: the existing rules — a confirmed match, $41.37 more than planned.
    const { where, row: r } = await placed(row.may);
    expect(where).toBe("amountDifference amount");
    expect(r.evidence).toBe("confirmed");
    expect(r.plan).toMatchObject({ planned: "-820.00", difference: "41.37", scheduledDate: MAY });
    // Spending: the owner answered — no longer Unconfirmed.
    const w = await week();
    expect(w.unresolved.amount).toBe("0.00");
    expect(w.known).toBe("42.18");

    // Undo: exactly the answers before the Match.
    const u = await call("POST", `/forecast/resolutions/${m.body.id}/undo`, { restore: m.body.replaced });
    expect(u.status).toBe(200);
    expect(u.body).toEqual({ undone: m.body.id, restored: 2 });
    expect(await answers()).toEqual(before);
    expect((await placed(row.may)).where).toBe("uncertain evidence_unresolved");
    expect((await ledger()).planOccurrences.find((o) => o.planKey === `${itemId}|${MAY}`)!.fate).toBe("skipped");
    expect((await week()).unresolved.amount).toBe("861.37");
  });

  it("6. 'Not this' keeps the skip, drops the suggestion, and the row stays Unclear with the bank's words", async () => {
    const n = await call("POST", "/forecast/resolutions", { recurringItemId: itemId, occurrenceDate: MAY, status: "not_match", matchedTxnId: row.may });
    expect(n.status).toBe(200);
    expect(n.body.replaced).toEqual([]);
    const stored = await answers();
    expect(stored.some((a) => a.status === "skipped" && a.on === MAY)).toBe(true);
    expect(stored.some((a) => a.status === "ignored_unforecasted" && a.txn === row.may)).toBe(true);
    const l = await ledger();
    expect(l.skippedSuggestions).toEqual([]);
    expect(l.planOccurrences.find((o) => o.planKey === `${itemId}|${MAY}`)!.fate).toBe("skipped");
    const { where, row: r } = await placed(row.may);
    expect(where).toBe("uncertain evidence_unresolved");
    expect(r.rowEvidence.reason).toBe("loan_payment");
    expect(r.rowEvidence.suggestion.target).toBeNull();
    expect((await week()).unresolved.amount).toBe("861.37");
    // Its Undo removes the rejection and nothing else.
    const u = await call("POST", `/forecast/resolutions/${n.body.id}/undo`, { restore: [] });
    expect(u.status).toBe(200);
    expect((await ledger()).skippedSuggestions).toHaveLength(1);
  });

  it("7. an undo naming answers that write could not have replaced is refused, nothing written", async () => {
    const m = await call("POST", "/forecast/resolutions", { recurringItemId: itemId, occurrenceDate: MAY, status: "matched", matchedTxnId: row.may });
    const snapshot = await answers();
    const foreign = { ...m.body.replaced[0], id: randomUUID(), occurrenceDate: "2026-04-02", recurringItemId: "another-item", matchedTxnId: null };
    const bad = await call("POST", `/forecast/resolutions/${m.body.id}/undo`, { restore: [foreign] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_restore");
    expect(await answers()).toEqual(snapshot);
    // Twice: the second finds the answer gone.
    expect((await call("POST", `/forecast/resolutions/${m.body.id}/undo`, { restore: m.body.replaced })).status).toBe(200);
    const again = await call("POST", `/forecast/resolutions/${m.body.id}/undo`, { restore: m.body.replaced });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("not_found");
  });
});
