// ⭐ (F3) THE BANK BALANCE CHECK, end to end: a manual Sync (Plaid mocked, as the
// other sync tests mock it — no network) stores what it checked, and
// GET /banking/review answers `balanceCheck` from it — matches / off by / resolved
// since / not checked and why, stale and why — recomputing from the stored
// previous anchor in one query, never calling Plaid.
//
// Synthetic household, made-up amounts. The anchor is read three days before
// today (household day S); rows are dated from S on. Real clock, like the other
// sync tests (the 45-day anchor rule reads the clock).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `f3-check-${process.pid}-${randomUUID().slice(0, 8)}`;
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

type Balances = { available: number | null; current: number | null };
let bank: Balances | "throw" = { available: 1000, current: 1000 };
let balanceCalls = 0;
let transactionsGetCalls = 0;
let checkingExt = "";

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], next_cursor: "", has_more: false } }),
      accountsBalanceGet: async () => {
        balanceCalls += 1;
        if (bank === "throw") throw new Error("bank unavailable");
        return { data: { accounts: [{ account_id: checkingExt, balances: bank }] } };
      },
      itemGet: async () => ({ data: { item: { item_id: "item-default", consent_expiration_time: null } } }),
      // The drift self-heal: Plaid has nothing more to give.
      transactionsGet: async () => {
        transactionsGetCalls += 1;
        return { data: { transactions: [], total_transactions: 0 } };
      },
    }),
  };
});

import { db, forecastSettingsTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import { GetBankingReviewResponse } from "@workspace/api-zod";
import { addDaysISO } from "@workspace/avalanche-core";
import bankingRouter from "../routes/banking";
import forecastRouter from "../routes/forecast";
import spineRouter from "../routes/spine";
import { syncPlaidItem } from "../lib/plaidSync";
import { classifyLedgerRowsThroughToday } from "../lib/ledgerCashRows";
import { computeCashSignal } from "../lib/cashSignal";
import { householdDayOf, householdTodayISO } from "../lib/householdClock";
import { logger } from "../lib/logger";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const DRIFT_LOG = "[plaid-sync] bank reconciliation: our rows do not explain the bank balance";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(bankingRouter);
app.use(forecastRouter);
app.use(spineRouter);
let server: Server;
let baseUrl = "";

let itemRowId = "";
let checkingRowId = "";
let savingsRowId = "";
let anchorAt = new Date();
let S = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

async function cleanup(): Promise<void> {
  if (!HH) return;
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
}

async function setUp(opts: { anchorBalance?: string; anchorDaysAgo?: number } = {}): Promise<void> {
  await cleanup();
  const owned = { userId: OWNER, householdId: HH };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...owned, itemId: `f3-item-${randomUUID()}`, accessToken: `access-sandbox-chase-${randomUUID()}`, institutionName: "Chase", institutionSlug: "chase" })
    .returning();
  itemRowId = item!.id;
  checkingExt = `f3-chk-${randomUUID().slice(0, 8)}`;
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values({ ...owned, itemId: itemRowId, accountId: checkingExt, name: "Chase Checking", mask: "4401", type: "depository", subtype: "checking" })
    .returning();
  checkingRowId = chk!.id;
  const [sav] = await db
    .insert(plaidAccountsTable)
    .values({ ...owned, itemId: itemRowId, accountId: `f3-sav-${randomUUID().slice(0, 8)}`, name: "Chase Savings", mask: "4402", type: "depository", subtype: "savings" })
    .returning();
  savingsRowId = sav!.id;
  anchorAt = new Date(Date.now() - (opts.anchorDaysAgo ?? 3) * 86_400_000);
  S = householdDayOf(anchorAt);
  await db.insert(forecastSettingsTable).values({
    ...owned,
    daysAhead: 90,
    cashBuffer: "0",
    bankSnapshotBalance: opts.anchorBalance ?? "1000.00",
    bankSnapshotAt: anchorAt,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: checkingRowId,
    bankSnapshotName: "Chase Checking",
    bankSnapshotMask: "4401",
  });
}

/** A checking row dated `day` days after the anchor's day S. */
async function addRow(row: { day: number; amount: string; pending?: boolean; createdAt?: Date; description?: string }): Promise<string> {
  const occurredOn = addDaysISO(S, row.day);
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: OWNER,
      householdId: HH,
      occurredOn,
      description: row.description ?? "ROW",
      amount: row.amount,
      pending: row.pending ?? false,
      plaidAccountId: checkingExt,
      plaidTransactionId: `f3-${randomUUID()}`,
      source: "plaid:chase",
      forecastFlag: true,
      createdAt: row.createdAt ?? createdAtStartOfHouseholdDay(occurredOn),
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

async function sync() {
  const warn = vi.spyOn(logger, "warn");
  try {
    const result = await syncPlaidItem(OWNER, itemRowId, { syncOrigin: "manual" });
    return { result, driftLogged: warn.mock.calls.some((c) => c[1] === DRIFT_LOG) };
  } finally {
    warn.mockRestore();
  }
}

async function review(account?: string): Promise<Json> {
  const today = householdTodayISO();
  const qs = `from=${addDaysISO(today, -6)}&to=${today}${account ? `&account=${account}` : ""}`;
  const r = await fetch(`${baseUrl}/banking/review?${qs}`);
  const body = (await r.json()) as Json;
  if (r.status !== 200) throw new Error(`review ${r.status} ${JSON.stringify(body)}`);
  expect(() => GetBankingReviewResponse.parse(body)).not.toThrow();
  return body;
}

/** The review never calls Plaid: no balance call, no /transactions/get. */
async function reviewCheck(account?: string): Promise<Json> {
  const [b, t] = [balanceCalls, transactionsGetCalls];
  const body = await review(account);
  expect([balanceCalls, transactionsGetCalls]).toEqual([b, t]);
  return body.balanceCheck;
}

const stored = async () =>
  (await db.select({ r: forecastSettingsTable.lastBankReconciliation }).from(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER)))[0]?.r ?? null;

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

beforeEach(() => {
  bank = { available: 1000, current: 1000 };
  balanceCalls = 0;
  transactionsGetCalls = 0;
});

describe("(F3) the bank balance check — sync stores, review answers", () => {
  it("never checked: not_checked · never, nothing to compare", async () => {
    await setUp();
    expect(await reviewCheck()).toEqual({
      status: "not_checked",
      reason: "never",
      stale: false,
      staleReason: null,
      checkedAt: null,
      bank: null,
      h2: null,
      difference: null,
      direction: null,
      lastDrift: null,
    });
  });

  it("⭐ matches: the bank's figure (and field) beside H2's — H2's is the shared cash rule from the previous anchor", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    // H2's figure is the ledger's own: the anchor plus `classifyLedgerRowsThroughToday`'s Plaid rows.
    const shared = await classifyLedgerRowsThroughToday({
      householdId: HH,
      anchor: { at: anchorAt, day: S },
      accountExternalId: checkingExt,
      todayISO: householdTodayISO(),
    });
    expect((1000 + shared.plaidRowsThroughToday.net).toFixed(2)).toBe("900.00");
    bank = { available: 900, current: 950 };
    const { result, driftLogged } = await sync();
    expect(result.balanceDrift ?? null).toBeNull();
    expect(driftLogged).toBe(false);

    const c = await reviewCheck();
    expect(c).toMatchObject({
      status: "matches",
      reason: null,
      stale: false,
      staleReason: null,
      bank: { balance: "900.00", field: "available" },
      h2: { balance: "900.00" },
      difference: "0.00",
      direction: null,
      lastDrift: null,
    });
    expect(Date.parse(c.checkedAt)).toBeGreaterThan(Date.now() - 60_000);
    // The record keeps the previous anchor and what was read.
    expect(await stored()).toMatchObject({
      status: "ties",
      unexplained: "0.00",
      predicted: "900.00",
      prevAnchor: { balance: "1000.00", at: anchorAt.toISOString(), field: null },
      bank: { balance: "900.00", field: "available" },
      anchor: { balance: "900.00", field: "available" },
    });
    // The short form is unchanged; the inbox and freshness stay their own fields.
    const r = await review();
    expect(r.balanceTie).toMatchObject({ status: "ties", unexplained: "0.00" });
    expect(r.reviewInbox).toBeDefined();
    expect(r.freshness).toBeDefined();
  });

  it("off by — the bank holds more: difference, bank_higher, both figures", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    bank = { available: 1069.9, current: 1069.9 };
    const { result, driftLogged } = await sync();
    expect(result.balanceDrift).toEqual({ bank: "1069.90", ledger: "900.00", unexplained: "169.90" });
    expect(driftLogged).toBe(true);
    expect(await reviewCheck()).toMatchObject({
      status: "off_by",
      stale: false,
      bank: { balance: "1069.90", field: "available" },
      h2: { balance: "900.00" },
      difference: "169.90",
      direction: "bank_higher",
    });
  });

  it("off by — the bank holds less: bank_lower", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    bank = { available: 887.66, current: 887.66 };
    await sync();
    expect(await reviewCheck()).toMatchObject({ status: "off_by", difference: "12.34", direction: "bank_lower", h2: { balance: "900.00" } });
  });

  it("⭐ resolved since: the missing deposit arrives after the check — recomputed from the same anchor it ties; no Plaid call", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    bank = { available: 1069.9, current: 1069.9 };
    await sync();
    expect((await reviewCheck()).status).toBe("off_by");
    // The feed delivers it late, dated before the check's day.
    await addRow({ day: 2, amount: "169.90", createdAt: new Date(Date.now() + 1000), description: "DEPOSIT" });
    expect(await reviewCheck()).toMatchObject({
      status: "resolved_since",
      difference: "169.90",
      direction: "bank_higher",
      stale: true,
      staleReason: "rows_since",
    });
  });

  it("stale by age: more than 7 days after the check", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    bank = { available: 900, current: 900 };
    await sync();
    vi.setSystemTime(new Date(Date.now() + 8 * 86_400_000));
    try {
      expect(await reviewCheck()).toMatchObject({ status: "matches", stale: true, staleReason: "age" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stale by a newer anchor: a balance typed after the check", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    bank = { available: 900, current: 900 };
    await sync();
    expect((await reviewCheck()).stale).toBe(false);
    const r = await fetch(`${baseUrl}/forecast/bank-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: "950.00" }),
    });
    expect(r.status).toBe(200);
    expect(await reviewCheck()).toMatchObject({ status: "matches", stale: true, staleReason: "anchor_changed" });
  });

  it("another account: not_checked · not_forecast_account (never borrows the checking account's check)", async () => {
    await setUp();
    bank = { available: 1000, current: 1000 };
    await sync();
    expect((await reviewCheck()).status).toBe("matches");
    expect(await reviewCheck(savingsRowId)).toMatchObject({ status: "not_checked", reason: "not_forecast_account", checkedAt: null, bank: null });
  });

  it("anchor too old: not_checked · anchor_too_old, with the bank's figure read (it was stored as nothing before)", async () => {
    await setUp({ anchorDaysAgo: 60 });
    bank = { available: 1234.56, current: 1234.56 };
    await sync();
    const c = await reviewCheck();
    expect(c).toMatchObject({
      status: "not_checked",
      reason: "anchor_too_old",
      stale: false,
      bank: { balance: "1234.56", field: "available" },
      h2: null,
      difference: null,
      direction: null,
    });
    expect(c.checkedAt).toEqual(expect.any(String));
  });

  it("balance unavailable: not_checked · balance_unavailable; the anchor stands", async () => {
    await setUp();
    bank = "throw";
    await sync();
    expect(await reviewCheck()).toMatchObject({ status: "not_checked", reason: "balance_unavailable", bank: null });
    const [s] = await db.select().from(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
    expect(s!.bankSnapshotBalance).toBe("1000.00");
    // Plaid answering with no balance at all reads the same.
    bank = { available: null, current: null };
    await sync();
    expect(await reviewCheck()).toMatchObject({ status: "not_checked", reason: "balance_unavailable" });
  });

  it("⭐ a pending deposit no longer drifts — and once it posts, the deposit the anchor did not hold is counted", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    const pay = await addRow({ day: 3, amount: "2000.00", pending: true, description: "PAYROLL" });
    // Before F3 the prediction counted the pending paycheck that `available` does not hold: 2,900 against 900.
    const shared = await classifyLedgerRowsThroughToday({
      householdId: HH,
      anchor: { at: anchorAt, day: S },
      accountExternalId: checkingExt,
      todayISO: householdTodayISO(),
    });
    expect((1000 + shared.plaidRowsThroughToday.net).toFixed(2)).toBe("2900.00");
    // The forecast's own cash today is untouched by the check's rule (it still counts the pending deposit).
    expect((await computeCashSignal(HH, OWNER, { horizonDays: 90 })).bankToday).toBe("2900.00");

    bank = { available: 900, current: 900 };
    const first = await sync();
    expect(first.result.balanceDrift ?? null).toBeNull();
    expect(first.driftLogged).toBe(false);
    expect(transactionsGetCalls).toBe(0);
    expect(await reviewCheck()).toMatchObject({ status: "matches", difference: "0.00", h2: { balance: "900.00" } });
    expect(await stored()).toMatchObject({
      excluded: { ids: [pay], amount: "2000.00" },
      pendingDeposits: { ids: [pay], amount: "2000.00" },
    });

    // The paycheck posts (Plaid re-keys the pending row: same row, same day). The re-anchored
    // snapshot (900.00, read while it was pending) holds every row dated before or on its day,
    // so the cash rule adds nothing for it — yet the bank now holds it.
    await db.update(transactionsTable).set({ pending: false }).where(eq(transactionsTable.id, pay));
    bank = { available: 2900, current: 2900 };
    const second = await sync();
    expect(second.result.balanceDrift ?? null).toBeNull();
    expect(second.driftLogged).toBe(false);
    expect(await reviewCheck()).toMatchObject({ status: "matches", h2: { balance: "2900.00" }, bank: { balance: "2900.00" } });
    expect(await stored()).toMatchObject({
      prevAnchor: { balance: "900.00", field: "available", pendingDepositIds: [pay] },
      added: { ids: [pay], amount: "2000.00" },
    });
  });

  it("a later Sync re-anchors, but the earlier drift is kept (lastDrift)", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    bank = { available: 1069.9, current: 1069.9 };
    await sync();
    // The next Sync reads the same balance: H2 now starts from 1,069.90 and ties.
    await sync();
    const c = await reviewCheck();
    expect(c.status).toBe("matches");
    expect(c.lastDrift).toMatchObject({ difference: "169.90", direction: "bank_higher" });
    expect(await stored()).toMatchObject({ lastDrift: { unexplained: "169.90", predicted: "900.00", bank: { balance: "1069.90" } } });
  });

  it("like with like: the previous anchor was `current`, the bank now gives both — `current` is compared, and the change is recorded", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    // First Sync: the bank gives no `available`; the anchor takes `current`.
    bank = { available: null, current: 900 };
    await sync();
    expect(await stored()).toMatchObject({ status: "ties", anchor: { field: "current" }, bank: { field: "current" } });
    // Second Sync: `available` is back (a pending charge of 25.00 sits in it, not yet in the feed).
    bank = { available: 875, current: 900 };
    await sync();
    expect(await stored()).toMatchObject({
      status: "ties",
      prevAnchor: { field: "current" },
      bank: { balance: "900.00", field: "current" },
      anchor: { balance: "875.00", field: "available" },
      fieldChanged: true,
    });
  });
});

describe("(Q1) the spine's bankConfidence — this check, the bank's figure beside H2's, the pending rows", () => {
  const spine = async (): Promise<Json> => {
    const r = await fetch(`${baseUrl}/spine`);
    const body = (await r.json()) as Json;
    if (r.status !== 200) throw new Error(`spine ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const strip = (c: Json) => {
    const { bank: _b, h2: _h, lastDrift: _l, ...rest } = c;
    return rest;
  };

  it("⭐ after a Sync that was off: the same check as the review, no Plaid call; pending counted once", async () => {
    await setUp();
    await addRow({ day: 1, amount: "-100.00" });
    bank = { available: 1069.9, current: 1069.9 };
    await sync();
    // After the Sync: one pending charge, and a pending charge its posted row replaced.
    await addRow({ day: 3, amount: "-12.34", pending: true, description: "CORNER CAFE 0042" });
    await addRow({ day: 2, amount: "-20.00", pending: true, description: "FUEL STOP 12" });
    await addRow({ day: 3, amount: "-20.00", description: "FUEL STOP 12" });
    const [b, t] = [balanceCalls, transactionsGetCalls];
    const [s, r] = await Promise.all([spine(), review()]);
    expect([balanceCalls, transactionsGetCalls]).toEqual([b, t]);
    expect(s.bankConfidence.check).toEqual(strip(r.balanceCheck));
    expect(s.bankConfidence.check).toMatchObject({ status: "off_by", difference: "169.90", direction: "bank_higher" });
    // The replaced pending row is not counted; the café's is.
    expect(r.cashFlow.supersededExcluded).toBe(1);
    expect(r.cashFlow.pendingCount).toBe(1);
    expect(s.bankConfidence.pendingCount).toBe(1);
    // The bank's own figure (the Sync re-anchored on it) beside H2's roll-forward of it.
    expect(s.bankConfidence).toMatchObject({
      bankBalance: s.bank.snapshot.balance,
      bankAsOf: s.bank.snapshot.at,
      h2Balance: s.bank.balance,
    });
    expect(s.bankConfidence.bankBalance).toBe("1069.90");
    // fetchedAt: the later of that read and the last successful sync (a Plaid balance).
    const later = Math.max(Date.parse(s.bank.snapshot.at), s.bank.lastContactAt ? Date.parse(s.bank.lastContactAt) : 0);
    expect(Date.parse(s.bankConfidence.fetchedAt)).toBe(later);
  });

  it("never checked: not checked · never on both", async () => {
    await setUp();
    const [s, r] = await Promise.all([spine(), review()]);
    expect(s.bankConfidence.check).toEqual(strip(r.balanceCheck));
    expect(s.bankConfidence.check).toMatchObject({ status: "not_checked", reason: "never" });
    expect(s.bankConfidence.pendingCount).toBe(0);
  });
});
