// ⭐ (PR-B1) GET /money/position — one synthetic household, every figure worked
// by hand, and a second household that must see none of it.
//
// Pinned now: Wed 2026-10-07 12:00 Central. The household week is Sun 10/4 –
// Sat 10/10. All figures are synthetic.
//
// Household A
//   Checking snapshot $3,000.00 (typed in, Sun 10/4 08:00), cash buffer $500.
//   Chase since:  10/5 transfer to savings −100.00 · 10/6 "Taco Shop" −25.50
//                 (filed nowhere) · 10/6 "CITY WATER UTILITY" −60.00 (pays the
//                 City Water bill by its full name: a tier-2 pair)
//                 → cash today 2,814.50
//   Amex:         10/5 groceries −80.00 (weekly) · 10/6 hardware −40.00
//                 (unplanned) · 10/7 shoes −30.00 (monthly)
//   Plans:        Paycheck +2,000 biweekly from Fri 10/9 · Reimbursement +150
//                 monthly on the 8th · Electric −340 monthly on the 8th
//                 (ESTIMATE) · City Water −60 monthly on the 6th · Rent −1,200
//                 monthly on the 12th
//   Weekly cap:   $250 (allowance plan)
//
//   Payday:       Fri 10/9 — the $150 reimbursement on 10/8 is under 25% of the
//                 $2,000 paycheck, so it is not payday.
//   Curve:        10/7 2,814.50 · 10/8 2,814.50 + 150 − 340 = 2,624.50 ·
//                 10/9 4,624.50, read before its $2,000 paycheck: 2,624.50 (a tie)
//   Lowest through payday 2,624.50 on 10/8 → available 2,624.50 − 500 = 2,124.50
//   Week:         counted 80.00 weekly + 25.50 unfiled = 105.50; unplanned
//                 40.00 and monthly 30.00 beside it; the City Water row is the
//                 bill (tier 2), the transfer is a transfer.
//                 remaining 250 − 105.50 = 144.50; pace (Wed, 4 of 7 days)
//                 142.86; within plan: 144.50 × 7 = 1,011.50 ≥ 250 × 4 = 1,000 → yes
//   Safe to spend now = min(144.50, 2,124.50) = 144.50; estimated (Electric).
//
// Household B — another owner and a member of B, with nothing set up: no bank,
// no plan, no rows.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const A_OWNER = `money-pos-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_OWNER = `money-pos-b-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_MEMBER = `money-pos-bm-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      headers: Record<string, string | string[] | undefined>;
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? A_OWNER);
    const hh = HH[who]!;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  allowancePlansTable,
  budgetCategoriesTable,
  forecastSettingsTable,
  householdMembersTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import moneyRouter from "../routes/money";
import forecastRouter from "../routes/forecast";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-07T12:00:00-05:00");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(forecastRouter);

let server: Server;
let baseUrl: string;
let chaseItemRowId = "";

async function get<T>(path: string, as: string = A_OWNER): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": as } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

type Position = Record<string, unknown> & {
  safeToSpendNow: string | null;
  availableUntilPayday: string | null;
  remainingWeek: string | null;
  weekCap: string | null;
};

async function cleanup(): Promise<void> {
  for (const u of [A_OWNER, B_OWNER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, u));
    await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, u));
    await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, u));
    await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, u));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
  for (const h of Object.values(HH)) {
    await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, h.householdId));
  }
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH[A_OWNER] = await createTestHousehold(A_OWNER);
  HH[B_OWNER] = await createTestHousehold(B_OWNER);
  await db
    .insert(householdMembersTable)
    .values({ userId: B_MEMBER, householdId: HH[B_OWNER]!.householdId, role: "member" })
    .onConflictDoNothing();
  HH[B_MEMBER] = { householdId: HH[B_OWNER]!.householdId, ownerUserId: B_OWNER };
  await cleanup();
  const A = HH[A_OWNER]!.householdId;
  const base = { userId: A_OWNER, householdId: A };

  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  chaseItemRowId = item!.id;
  const chase = `acct-chase-${randomUUID()}`;
  const amex = `acct-amex-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: item!.id, accountId: chase, name: "Chase Checking", type: "depository", subtype: "checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: acct!.id,
  });
  const [dining] = await db
    .insert(budgetCategoriesTable)
    .values({ ...base, name: `Dining ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Food" })
    .returning();

  const row = (r: {
    occurredOn: string;
    description: string;
    amount: string;
    account: string;
    source: string;
    categoryId?: string | null;
    isTransfer?: boolean;
    weeklyAllowance?: boolean;
    monthlyAllowance?: boolean;
    unplannedAllowance?: boolean;
  }) => ({
    ...base,
    occurredOn: r.occurredOn,
    createdAt: createdAtStartOfHouseholdDay(r.occurredOn),
    description: r.description,
    amount: r.amount,
    plaidAccountId: r.account,
    source: r.source,
    categoryId: r.categoryId ?? null,
    isTransfer: r.isTransfer ?? false,
    weeklyAllowance: r.weeklyAllowance ?? false,
    monthlyAllowance: r.monthlyAllowance ?? false,
    unplannedAllowance: r.unplannedAllowance ?? false,
  });
  await db.insert(transactionsTable).values([
    row({ occurredOn: "2026-10-05", description: "Online Transfer to SAV ...8801", amount: "-100.00", account: chase, source: "plaid", isTransfer: true }),
    row({ occurredOn: "2026-10-06", description: "TACO SHOP 22", amount: "-25.50", account: chase, source: "plaid", categoryId: dining!.id }),
    row({ occurredOn: "2026-10-06", description: "CITY WATER UTILITY", amount: "-60.00", account: chase, source: "plaid" }),
    row({ occurredOn: "2026-10-05", description: "HEB GROCERY", amount: "-80.00", account: amex, source: "plaid:amex", weeklyAllowance: true }),
    row({ occurredOn: "2026-10-06", description: "HOME DEPOT", amount: "-40.00", account: amex, source: "plaid:amex", unplannedAllowance: true }),
    row({ occurredOn: "2026-10-07", description: "SHOE STORE", amount: "-30.00", account: amex, source: "plaid:amex", monthlyAllowance: true }),
  ]);

  const plan = (p: { name: string; kind: string; amount: string; frequency: string; anchorDate: string; amountKind?: string }) => ({
    ...base,
    name: p.name,
    kind: p.kind,
    amount: p.amount,
    frequency: p.frequency,
    dayOfMonth: Number(p.anchorDate.slice(8, 10)),
    anchorDate: p.anchorDate,
    active: "true",
    amountKind: p.amountKind ?? "fixed",
  });
  await db.insert(recurringItemsTable).values([
    plan({ name: "Paycheck", kind: "income", amount: "2000", frequency: "biweekly", anchorDate: "2026-10-09" }),
    plan({ name: "Reimbursement", kind: "income", amount: "150", frequency: "monthly", anchorDate: "2026-10-08" }),
    plan({ name: "Electric", kind: "bill", amount: "340", frequency: "monthly", anchorDate: "2026-10-08", amountKind: "estimate" }),
    plan({ name: "City Water", kind: "bill", amount: "60", frequency: "monthly", anchorDate: "2026-10-06" }),
    plan({ name: "Rent", kind: "bill", amount: "1200", frequency: "monthly", anchorDate: "2026-10-12" }),
  ]);
  await db.insert(allowancePlansTable).values({
    householdId: A,
    memberUserId: null,
    period: "weekly",
    amount: "250.00",
    effectiveFrom: "2026-05-01",
    source: "owner",
  });

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
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, B_MEMBER));
});

describe("GET /money/position — household A, worked by hand", () => {
  it("returns every figure to the cent", async () => {
    const p = await get<Position>("/money/position");
    expect(p).toEqual({
      todayISO: "2026-10-07",
      status: "ready",
      paydayDate: "2026-10-09",
      payday: { itemId: expect.any(String), label: "Paycheck", amount: "2000.00" },
      horizon: { kind: "payday", endDate: "2026-10-09", lastDay: "2026-10-09" },
      lowestUntilPayday: "2624.50",
      lowestUntilPaydayDate: "2026-10-08",
      committedUntilPayday: "340.00",
      cashBuffer: "500.00",
      reservesHeld: "0.00",
      availableUntilPayday: "2124.50",
      weekStart: "2026-10-04",
      weekEnd: "2026-10-10",
      weekCap: "250.00",
      // (V5) No carry-over row: null, and every figure as before.
      weekAdjustment: null,
      spentWeekDiscretionary: "105.50",
      needsClassificationWeek: "25.50",
      unplannedWeek: "40.00",
      monthlyWeek: "30.00",
      remainingWeek: "144.50",
      paceAllowedToday: "142.86",
      withinPlan: "yes",
      safeToSpendNow: "144.50",
      confidence: "estimated",
      estimates: [{ itemId: expect.any(String), label: "Electric", amount: "-340.00", date: "2026-10-08" }],
      assumptions: [
        "available credit is not counted",
        "bank data from 2026-10-04",
        "bills due on payday are counted before the paycheck",
        "spending not yet filed counts against the weekly cap",
      ],
      degraded: false,
      degradedReason: null,
    });
  });

  it("sits on the forecast's own curve: the same cash today and the same daily balances", async () => {
    const signal = await get<{ bankToday: string; daily: Array<{ date: string; balance: string }>; matches: Array<{ txnId: string; tier: number; offCurve: boolean; planAmount: string }> }>(
      "/forecast/cash-signal?horizonDays=90",
    );
    expect(signal.bankToday).toBe("2814.50");
    expect(signal.daily.slice(0, 3)).toEqual([
      { date: "2026-10-07", balance: "2814.50" },
      { date: "2026-10-08", balance: "2624.50" },
      { date: "2026-10-09", balance: "4624.50" },
    ]);
    // Not vacuous: the City Water row IS a tier-2 pair the ledger took off the
    // curve — the pair the position hands `classifyMovement` so the row is the
    // bill, not $60 of spending to file.
    expect(signal.matches).toContainEqual(expect.objectContaining({ tier: 2, offCurve: true, planAmount: "-60.00" }));
  });

  it("stale bank data: degraded with the reason, every figure unchanged", async () => {
    const before = await get<Position>("/money/position");
    await db.insert(plaidSyncAttemptsTable).values({
      userId: A_OWNER,
      householdId: HH[A_OWNER]!.householdId,
      plaidItemId: chaseItemRowId,
      attemptedAt: new Date("2026-10-07T11:00:00-05:00"),
      kind: "transactions",
      success: false,
      errorCode: "INTERNAL_SERVER_ERROR",
    });
    try {
      const after = await get<Position>("/money/position");
      expect(after.degraded).toBe(true);
      expect(after.degradedReason).toBe("refresh_failed");
      const strip = ({ degraded: _a, degradedReason: _b, ...rest }: Position) => rest;
      expect(strip(after)).toEqual(strip(before));
    } finally {
      await db.delete(plaidSyncAttemptsTable).where(eq(plaidSyncAttemptsTable.plaidItemId, chaseItemRowId));
    }
  });
});

describe("GET /money/position — household scoping", () => {
  it("another household's owner and member each get THEIR household: nothing of A's", async () => {
    for (const who of [B_OWNER, B_MEMBER]) {
      const p = await get<Position>("/money/position", who);
      expect(p.status).toBe("no_data");
      expect(p.availableUntilPayday).toBeNull();
      expect(p.safeToSpendNow).toBeNull();
      expect(p.weekCap).toBeNull();
      expect(p.remainingWeek).toBeNull();
      expect(p.spentWeekDiscretionary).toBe("0.00");
      expect(p.unplannedWeek).toBe("0.00");
      expect(p.estimates).toEqual([]);
      expect(p.paydayDate).toBeNull();
      expect(JSON.stringify(p)).not.toMatch(/2624\.50|2124\.50|144\.50|Electric|Paycheck/);
    }
  });
});
