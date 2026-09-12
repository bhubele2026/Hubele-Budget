import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

/**
 * (PR-E review H2) The Amex page rolls its balance forward from the answer's
 * asOf. A debt-row answer dated later than its balance drops every charge in
 * between. The estimate refresh now advances the saved anchor's asOf on every
 * sync, so the debt-row answer must be dated by the debt's own balance date.
 */

const TEST_USER = `amex-debt-asof-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  debtBalanceHistoryTable,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import amexRouter from "../routes/amex";
import { refreshAmexAnchor } from "../lib/amexAnchor";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(amexRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(cleanup);

const SEP_1 = new Date("2026-09-01T17:00:00.000Z");
const CHARGES = [
  { occurredOn: "2026-09-03", amount: 100 },
  { occurredOn: "2026-09-05", amount: 50 },
];

/** The household (Chicago) calendar day of an instant, or a bare day as-is. */
function householdDay(at: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/**
 * End-of-September balance by the web's rule (`computeBalanceAtEndOf`): the
 * anchor plus its month's rows dated after the anchor day, then whole months
 * rolled forward or back to the target.
 */
function endOfSeptember2026(
  anchor: { amexEndingBalance: number; asOf: string },
  rows: Array<{ occurredOn: string; amount: number }>,
): number {
  const target = "2026-09";
  const anchorDay = householdDay(anchor.asOf);
  const anchorMonth = anchorDay.slice(0, 7);
  const monthOf = (d: string) => d.slice(0, 7);
  let bal =
    anchor.amexEndingBalance +
    rows
      .filter((r) => monthOf(r.occurredOn) === anchorMonth && r.occurredOn > anchorDay)
      .reduce((s, r) => s + r.amount, 0);
  if (anchorMonth > target) {
    bal -= rows
      .filter((r) => monthOf(r.occurredOn) > target && monthOf(r.occurredOn) <= anchorMonth)
      .reduce((s, r) => s + r.amount, 0);
  } else if (anchorMonth < target) {
    bal += rows
      .filter((r) => monthOf(r.occurredOn) > anchorMonth && monthOf(r.occurredOn) <= target)
      .reduce((s, r) => s + r.amount, 0);
  }
  return Math.round(bal * 100) / 100;
}

async function seedAmexWithoutBankBalance(): Promise<string> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  const externalId = `acct-${randomUUID()}`;
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: externalId,
    name: "Amex Gold",
    type: "credit",
    subtype: "credit card",
    liabilityBalance: null,
  });
  for (const c of CHARGES) {
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: c.occurredOn,
      description: "Amex charge",
      amount: c.amount.toFixed(2),
      source: "plaid:amex",
      plaidAccountId: externalId,
    });
  }
  return externalId;
}

async function getAnchor(): Promise<{ amexEndingBalance: number; asOf: string; source: string }> {
  const res = await fetch(`${baseUrl}/amex/anchor`);
  expect(res.status).toBe(200);
  return (await res.json()) as { amexEndingBalance: number; asOf: string; source: string };
}

describe("(PR-E review H2) GET /amex/anchor dates a debt-row balance by the debt", () => {
  it("with an updater-written anchor refreshed today: $1,000 as of Sep 1, so September ends at $1,150", async () => {
    await seedAmexWithoutBankBalance();
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "American Express",
      balance: "1000.00",
      lastBalanceUpdate: SEP_1,
      updatedAt: SEP_1,
      createdAt: SEP_1,
    });
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: {
        amexCleanupDoneAt: "2026-08-01T00:00:00.000Z",
        amexAnchor: { balance: 1000, asOf: SEP_1.toISOString(), lastAutoBalance: 1000 },
      },
    });

    await refreshAmexAnchor(TEST_USER);
    const body = await getAnchor();

    expect(body.source).toBe("debt");
    expect(body.amexEndingBalance).toBe(1000);
    expect(body.asOf).toBe(SEP_1.toISOString());
    expect(endOfSeptember2026(body, CHARGES)).toBe(1150);
  });

  it("with no anchor, and a later non-balance edit (updated_at Sep 10): still dated Sep 1, still $1,150", async () => {
    await seedAmexWithoutBankBalance();
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "American Express",
      balance: "1000.00",
      lastBalanceUpdate: SEP_1,
      updatedAt: new Date("2026-09-10T15:00:00.000Z"),
      createdAt: SEP_1,
    });
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: { amexCleanupDoneAt: "2026-08-01T00:00:00.000Z" },
    });

    const body = await getAnchor();

    expect(body.source).toBe("debt");
    expect(body.asOf).toBe(SEP_1.toISOString());
    expect(endOfSeptember2026(body, CHARGES)).toBe(1150);
  });

  it("a debt whose balance was never dated and has no balance history (a workbook import) is dated by its creation", async () => {
    await seedAmexWithoutBankBalance();
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "American Express",
      balance: "1000.00",
      lastBalanceUpdate: null,
      updatedAt: new Date("2026-09-10T15:00:00.000Z"),
      createdAt: SEP_1,
    });
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: { amexCleanupDoneAt: "2026-08-01T00:00:00.000Z" },
    });

    const body = await getAnchor();

    expect(body.asOf).toBe(SEP_1.toISOString());
  });
});

describe("(PR-E review H3) a legacy or stale balance date is moved to the day the balance last changed", () => {
  const LEGACY_ROWS = [
    { occurredOn: "2026-06-10", amount: 200 },
    { occurredOn: "2026-07-10", amount: 300 },
    { occurredOn: "2026-08-10", amount: 400 },
    { occurredOn: "2026-09-05", amount: 50 },
  ];

  /** No Plaid at all, so the page answers from the debt row. */
  async function seedLegacyDebt(opts: {
    lastBalanceUpdate: Date | null;
    history: Array<{ recordedOn: string; balance: string }>;
    rows: Array<{ occurredOn: string; amount: number }>;
  }): Promise<void> {
    for (const r of opts.rows) {
      await db.insert(transactionsTable).values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: r.occurredOn,
        description: "Amex charge",
        amount: r.amount.toFixed(2),
        source: "amex",
      });
    }
    const [d] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "American Express",
        balance: "1000.00",
        lastBalanceUpdate: opts.lastBalanceUpdate,
        createdAt: new Date("2026-06-01T17:00:00.000Z"),
        updatedAt: new Date("2026-09-01T17:00:00.000Z"),
      })
      .returning({ id: debtsTable.id });
    for (const h of opts.history) {
      await db.insert(debtBalanceHistoryTable).values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        debtId: d!.id,
        recordedOn: h.recordedOn,
        balance: h.balance,
      });
    }
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: { amexCleanupDoneAt: "2026-08-01T00:00:00.000Z" },
    });
  }

  it("the repro: created Jun 1 with no balance date, typed to $1,000 on Sep 1 by the old PATCH → dated Sep 1, September ends at $1,050 (not $1,950)", async () => {
    await seedLegacyDebt({
      lastBalanceUpdate: null,
      history: [{ recordedOn: "2026-09-01", balance: "1000.00" }],
      rows: LEGACY_ROWS,
    });

    const body = await getAnchor();

    expect(body.source).toBe("debt");
    expect(householdDay(body.asOf)).toBe("2026-09-01");
    expect(endOfSeptember2026(body, LEGACY_ROWS)).toBe(1050);
  });

  it("a stale bank date the old PATCH left behind (Jul 1) is moved to the Sep 1 change → $1,050 (not $1,750)", async () => {
    await seedLegacyDebt({
      lastBalanceUpdate: new Date("2026-07-01T17:00:00.000Z"),
      history: [
        { recordedOn: "2026-07-01", balance: "700.00" },
        { recordedOn: "2026-08-15", balance: "700.00" },
        { recordedOn: "2026-09-01", balance: "1000.00" },
        { recordedOn: "2026-09-09", balance: "1000.00" },
      ],
      rows: LEGACY_ROWS,
    });

    const body = await getAnchor();

    expect(householdDay(body.asOf)).toBe("2026-09-01");
    expect(endOfSeptember2026(body, LEGACY_ROWS)).toBe(1050);
  });

  it("a balance date later than the last history change wins (Sep 4 over Sep 1)", async () => {
    const rows = [...LEGACY_ROWS, { occurredOn: "2026-09-03", amount: 25 }];
    const sep4 = new Date("2026-09-04T17:00:00.000Z");
    await seedLegacyDebt({
      lastBalanceUpdate: sep4,
      history: [{ recordedOn: "2026-09-01", balance: "1000.00" }],
      rows,
    });

    const body = await getAnchor();

    expect(body.asOf).toBe(sep4.toISOString());
    expect(endOfSeptember2026(body, rows)).toBe(1050);
  });
});
