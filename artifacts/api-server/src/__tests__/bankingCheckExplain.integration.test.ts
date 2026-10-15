// ⭐ (T2) "REVIEW DIFFERENCE" — GET /banking/check-explain, end to end.
//
// The owner's case, synthetic: a Sync read the bank at $0.00 while H2 expected
// $432.00 from the previous reading, and re-anchored H2 to the bank. Today H2
// and the bank agree; the check stays "off by $432.00 — bank lower". The
// investigation shows the stored record and the rows H2 holds, and says what
// explains it: nothing (unknown), the rows H2 recorded itself (manual_rows_match)
// or rows that arrived late (late_rows_tie). It never writes or clears the record,
// and never calls Plaid.
//
// Synthetic household, made-up amounts. Real clock: the previous reading is
// three days back, the check a minute ago.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `t2-explain-${process.pid}-${randomUUID().slice(0, 8)}`;
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

// No Plaid, ever: any call fails the test.
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => {
      throw new Error("check-explain must not call Plaid");
    },
  };
});

import { db, forecastSettingsTable, plaidAccountsTable, plaidItemsTable, transactionsTable, type BankBalanceCheckRecord } from "@workspace/db";
import { GetBankingCheckExplainResponse } from "@workspace/api-zod";
import { addDaysISO } from "@workspace/avalanche-core";
import bankingRouter from "../routes/banking";
import bankingCheckExplainRouter from "../routes/bankingCheckExplain";
import spineRouter from "../routes/spine";
import { householdDayOf } from "../lib/householdClock";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(bankingCheckExplainRouter);
app.use(bankingRouter);
app.use(spineRouter);
let server: Server;
let baseUrl = "";

let checkingExt = "";
let checkingRowId = "";
/** The previous reading (three days back) and the check / current reading (a minute ago). */
let T1 = new Date();
let T2 = new Date();
let D1 = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

async function cleanup(): Promise<void> {
  if (!HH) return;
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
}

/** The record a manual Sync stores when the previous reading rolled forward to `predicted` and the bank read $0.00. */
function driftRecord(prev: string, predicted: string, unexplained: string): BankBalanceCheckRecord {
  return {
    checkedAt: T2.toISOString(),
    accountId: checkingExt,
    status: "drift",
    reason: null,
    unexplained,
    prevAnchor: { balance: prev, at: T1.toISOString(), field: "available", pendingDepositIds: [] },
    bank: { balance: "0.00", at: T2.toISOString(), field: "available" },
    anchor: { balance: "0.00", at: T2.toISOString(), field: "available" },
    predicted,
    pendingDeposits: { ids: [], amount: "0.00" },
    excluded: { ids: [], amount: "0.00" },
    added: { ids: [], amount: "0.00" },
    fieldChanged: false,
    lastDrift: null,
  };
}

async function setUp(record: BankBalanceCheckRecord | null): Promise<void> {
  await cleanup();
  const owned = { userId: OWNER, householdId: HH };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...owned, itemId: `t2-item-${randomUUID()}`, accessToken: `access-sandbox-t2-${randomUUID()}`, institutionName: "Sample Bank", institutionSlug: "sample" })
    .returning();
  checkingExt = `t2-chk-${randomUUID().slice(0, 8)}`;
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values({ ...owned, itemId: item!.id, accountId: checkingExt, name: "Everyday Checking", mask: "0001", type: "depository", subtype: "checking" })
    .returning();
  checkingRowId = chk!.id;
  await db.insert(forecastSettingsTable).values({
    ...owned,
    daysAhead: 90,
    cashBuffer: "500",
    bankSnapshotBalance: "0.00",
    bankSnapshotAt: T2,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: checkingRowId,
    bankSnapshotName: "Everyday Checking",
    bankSnapshotMask: "0001",
    lastBankReconciliation: record ? { ...record, accountId: checkingExt } : null,
  });
}

async function addRow(row: {
  day: string;
  amount: string;
  pending?: boolean;
  manual?: boolean;
  createdAt?: Date;
  description?: string;
}): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: OWNER,
      householdId: HH,
      occurredOn: row.day,
      description: row.description ?? "ROW",
      amount: row.amount,
      pending: row.pending ?? false,
      plaidAccountId: row.manual ? null : checkingExt,
      plaidTransactionId: row.manual ? null : `t2-${randomUUID()}`,
      source: row.manual ? "manual" : "plaid:sample",
      forecastFlag: true,
      createdAt: row.createdAt ?? createdAtStartOfHouseholdDay(row.day),
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

const stored = async () =>
  (await db.select({ r: forecastSettingsTable.lastBankReconciliation }).from(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER)))[0]?.r ?? null;

async function explain(): Promise<Json> {
  const before = JSON.stringify(await stored());
  const r = await fetch(`${baseUrl}/banking/check-explain`);
  const body = (await r.json()) as Json;
  if (r.status !== 200) throw new Error(`check-explain ${r.status} ${JSON.stringify(body)}`);
  expect(() => GetBankingCheckExplainResponse.parse(body)).not.toThrow();
  // ⚠️ Read-only: the stored check is exactly as it was.
  expect(JSON.stringify(await stored())).toBe(before);
  return body;
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  T1 = new Date(Date.now() - 3 * 86_400_000);
  T2 = new Date(Date.now() - 60_000);
  D1 = householdDayOf(T1);
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

describe("(T2) GET /banking/check-explain — the last check, explained, read-only", () => {
  it("⭐ the owner's case: off by $432.00, bank lower, nothing H2 holds explains it → unknown; today the two agree", async () => {
    await setUp(driftRecord("432.00", "432.00", "-432.00"));
    const e = await explain();
    expect(e.check).toMatchObject({ status: "off_by", stale: false, difference: "432.00", direction: "bank_lower" });
    expect(e.record).toMatchObject({
      status: "drift",
      prevAnchor: { balance: "432.00", at: T1.toISOString(), field: "available" },
      bank: { balance: "0.00", at: T2.toISOString(), field: "available" },
      predicted: "432.00",
      unexplained: "-432.00",
    });
    expect(e.counted).toEqual({ listed: true, rowCount: 0, net: "0.00", addsUp: true, rows: [] });
    expect(e.excluded).toEqual({ amount: "0.00", rows: [] });
    expect(e.added).toEqual({ amount: "0.00", rows: [] });
    expect(e.manualRows).toEqual({ amount: "0.00", rows: [] });
    expect(e.rowsSince).toEqual({ count: 0, rows: [] });
    // H2 now starts from the bank's $0.00 reading: today the two agree, at the check's own moment.
    expect(e.today).toEqual({ h2Balance: "0.00", bankReading: "0.00", bankAsOf: T2.toISOString(), sameMoment: true });
    expect(e.verdict).toBe("unknown");
    expect(e.account).toMatchObject({ externalId: checkingExt, institution: "Sample Bank", name: "Everyday Checking", mask: "0001" });
    expect(e.dataAsOf.snapshotAt).toBe(T2.toISOString());
    // The check is the review's own.
    const today = householdDayOf(new Date());
    const review = (await (await fetch(`${baseUrl}/banking/review?from=${addDaysISO(today, -6)}&to=${today}`)).json()) as Json;
    expect(e.check).toEqual(review.balanceCheck);
    // The review's own reading under the balance (T1): one moment with `today`.
    expect(review.balance).toMatchObject({ today: "0.00", reading: "0.00", asOf: T2.toISOString() });
    expect(review.dataAsOf.snapshotAt).toBe(T2.toISOString());
  });

  it("⭐ a row typed into H2 for −$432.00 between the readings → manual_rows_match, listed as H2's own", async () => {
    await setUp(driftRecord("432.00", "432.00", "-432.00"));
    const id = await addRow({ day: addDaysISO(D1, 1), amount: "-432.00", manual: true, description: "CARD PAYMENT (logged)" });
    const e = await explain();
    expect(e.manualRows.amount).toBe("-432.00");
    expect(e.manualRows.rows).toEqual([
      { id, date: addDaysISO(D1, 1), description: "CARD PAYMENT (logged)", amount: "-432.00", pending: false, source: "manual" },
    ]);
    // The check never counts it (no Plaid account): H2 expected the same $432.00.
    expect(e.counted).toMatchObject({ rowCount: 0, net: "0.00", addsUp: true });
    expect(e.verdict).toBe("manual_rows_match");
  });

  it("(H6) a payment typed in before the previous reading is already in it: not listed → unknown", async () => {
    await setUp(driftRecord("432.00", "432.00", "-432.00"));
    await addRow({ day: addDaysISO(D1, -1), amount: "-432.00", manual: true });
    const e = await explain();
    expect(e.manualRows).toEqual({ amount: "0.00", rows: [] });
    expect(e.verdict).toBe("unknown");
  });

  it("(H5) a pending charge and the posted row that replaced it are counted once", async () => {
    // Previous reading $452.00; one $20.00 charge between; H2 expected $432.00; the bank read $0.00.
    await setUp(driftRecord("452.00", "432.00", "-432.00"));
    await addRow({ day: addDaysISO(D1, 1), amount: "-20.00", pending: true, description: "CORNER MARKET" });
    const posted = await addRow({ day: addDaysISO(D1, 2), amount: "-20.00", description: "CORNER MARKET" });
    const e = await explain();
    expect(e.counted).toMatchObject({ listed: true, rowCount: 1, net: "-20.00", addsUp: true });
    expect(e.counted.rows.map((r: Json) => r.id)).toEqual([posted]);
    expect(e.verdict).toBe("unknown");
  });

  it("⭐ rows that arrived after the check tie it → resolved since (not out of date), late_rows_tie", async () => {
    await setUp(driftRecord("432.00", "432.00", "-432.00"));
    const late = await addRow({ day: addDaysISO(D1, 1), amount: "-432.00", createdAt: new Date(), description: "LATE DEBIT" });
    const e = await explain();
    expect(e.check).toMatchObject({ status: "resolved_since", stale: false, staleReason: null, difference: "432.00" });
    expect(e.rowsSince.count).toBe(1);
    expect(e.rowsSince.rows.map((r: Json) => r.id)).toEqual([late]);
    // At the check itself nothing was counted between the readings.
    expect(e.counted).toMatchObject({ rowCount: 0, net: "0.00" });
    expect(e.verdict).toBe("late_rows_tie");
  });

  it("a check that matched has nothing to explain (verdict null); no check at all → no record", async () => {
    await setUp({ ...driftRecord("432.00", "0.00", "0.00"), status: "ties", prevAnchor: { balance: "0.00", at: T1.toISOString(), field: "available", pendingDepositIds: [] } });
    const m = await explain();
    expect(m.check).toMatchObject({ status: "matches" });
    expect(m.verdict).toBeNull();

    await setUp(null);
    const n = await explain();
    expect(n.check).toMatchObject({ status: "not_checked", reason: "never" });
    expect(n.record).toBeNull();
    expect(n.counted).toMatchObject({ listed: false, rowCount: 0, rows: [] });
    expect(n.verdict).toBeNull();
    expect(n.today).toMatchObject({ h2Balance: "0.00", bankReading: "0.00", sameMoment: false });
  });
});
