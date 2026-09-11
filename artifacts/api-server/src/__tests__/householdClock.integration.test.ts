// ⭐ THE EVENING TEST — the server's calendar is the household's, whatever
// timezone the server runs in.
//
// Render runs in UTC. Between 7pm and midnight Central the process clock is
// already tomorrow, and before this change that leaked into what the household
// saw every evening:
//   - "spent this week" rolled into next week at 7pm on Saturday;
//   - a bank snapshot taken after 7pm was dated tomorrow, so the next day's
//     charges were silently left out of the balance until the next sync;
//   - the review badge moved to next month on the last evening of a month.
//
// This file runs the process in UTC (as Render does), pins the clock inside
// that evening window, and reads the numbers back through the real routes.
// The old code gives the figures in the comments; the household calendar gives
// the asserted ones.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "UTC";

const TEST_USER = `household-clock-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
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
  budgetCategoriesTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import spineRouter from "../routes/spine";
import forecastRouter from "../routes/forecast";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(spineRouter);
app.use(forecastRouter);

let server: Server;
let baseUrl: string;

/** Thursday 9/10, 9:30pm Central — 02:30 on Friday in UTC. */
const SNAPSHOT_AT = new Date("2026-09-11T02:30:00Z");
/** Saturday 9/12, 8:30pm Central — 01:30 on Sunday in UTC. */
const SATURDAY_EVENING = new Date("2026-09-13T01:30:00Z");
/** Wednesday 9/30, 9:00pm Central — 02:00 on October 1st in UTC. */
const LAST_EVENING_OF_SEPTEMBER = new Date("2026-10-01T02:00:00Z");

const CHASE = { accountId: "hc-chase-5526", mask: "5526" };

type Spine = {
  bank: { balance: string };
  spentWeek: number;
  reviewCount: number;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();

  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionSlug: "chase",
    })
    .returning();
  const [account] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: CHASE.accountId,
      name: "Chase Checking",
      mask: CHASE.mask,
      type: "depository",
      subtype: "checking",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "1000",
    bankSnapshotAt: SNAPSHOT_AT,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: account!.id,
    bankSnapshotMask: CHASE.mask,
  });
  const [groceries] = await db
    .insert(budgetCategoriesTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Groceries",
      kind: "expense",
      groupName: "Evening",
    })
    .returning();

  // Grocery charges on Chase, one per day around the evenings under test.
  for (const [occurredOn, amount] of [
    ["2026-09-10", "-20.00"], // the snapshot's own day
    ["2026-09-11", "-50.00"], // Friday, after the snapshot
    ["2026-09-12", "-30.00"], // Saturday
    ["2026-09-13", "-40.00"], // Sunday — next week, still ahead on Saturday evening
    ["2026-09-30", "-10.00"], // the last day of September
  ] as const) {
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description: "NEIGHBORHOOD GROCERY",
      amount,
      categoryId: groceries!.id,
      plaidAccountId: CHASE.accountId,
      source: "plaid:chase",
      forecastFlag: true,
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
    });
  }

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  // Assigning undefined would set the literal string "undefined".
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

describe("Saturday 8:30pm Central on a UTC server", () => {
  it("rolls the bank balance from the snapshot's own evening through Saturday", async () => {
    vi.setSystemTime(SATURDAY_EVENING);
    const spine = await get<Spine>("/spine");
    // $1,000 at 9:30pm Thursday. Friday −$50 and Saturday −$30 came after it;
    // Sunday's −$40 hasn't happened yet. The old UTC clock dated the snapshot
    // Friday and today Sunday: $1,000 − $30 − $40 = $930.
    expect(spine.bank.balance).toBe("920.00");
  });

  it("keeps 'spent this week' on Sun 9/6 – Sat 9/12", async () => {
    vi.setSystemTime(SATURDAY_EVENING);
    const spine = await get<Spine>("/spine");
    // $20 + $50 + $30. The old UTC clock had already started next week: $40.
    expect(spine.spentWeek).toBeCloseTo(100, 2);
  });

  it("tells the Review page that today is Saturday", async () => {
    vi.setSystemTime(SATURDAY_EVENING);
    const bundle = await get<{ today: string }>("/forecast?days=30");
    expect(bundle.today).toBe("2026-09-12");
  });
});

describe("the last evening of September on a UTC server", () => {
  it("still counts September's unresolved Chase rows in the review badge", async () => {
    vi.setSystemTime(LAST_EVENING_OF_SEPTEMBER);
    const spine = await get<Spine>("/spine");
    // All five rows are September and unresolved. The old UTC clock was
    // already in October and counted none.
    expect(spine.reviewCount).toBe(5);
  });
});
