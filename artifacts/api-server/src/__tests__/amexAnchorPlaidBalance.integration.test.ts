import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

// (#483) Regression coverage: when a user has Plaid-linked Amex accounts but
// no `debts` row named "Amex" (and no manual settings anchor), GET
// /amex/anchor must resolve the ending balance from the live Plaid liability
// balances cached on the linked plaid_accounts rows — not stay null and
// leave the page tile stuck on "Loading…".

const TEST_USER = `amex-plaid-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import amexRouter from "../routes/amex";

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
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
}

beforeAll(async () => {
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

describe("GET /amex/anchor — Plaid liability fallback (#483)", () => {
  it("sums Plaid balances across multiple linked Amex accounts when no debt row matches", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `amex-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();

    const fetchedAt = new Date("2026-04-15T12:00:00.000Z");
    const olderFetchedAt = new Date("2026-04-14T08:00:00.000Z");
    await db.insert(plaidAccountsTable).values([
      {
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `acct-gold-${suffix}`,
        name: "Amex Gold",
        mask: "1001",
        type: "credit",
        subtype: "credit card",
        liabilityBalance: "500.25",
        liabilityLastFetchedAt: olderFetchedAt,
      },
      {
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `acct-platinum-${suffix}`,
        name: "Amex Platinum",
        mask: "1002",
        type: "credit",
        subtype: "credit card",
        liabilityBalance: "1200.50",
        liabilityLastFetchedAt: fetchedAt,
      },
      {
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `acct-blue-${suffix}`,
        name: "Amex Blue",
        mask: "1003",
        type: "credit",
        subtype: "credit card",
        liabilityBalance: "75.00",
        liabilityLastFetchedAt: olderFetchedAt,
      },
    ]);

    // No debts row for Amex; no settings anchor; no transactions yet.
    const res = await fetch(`${baseUrl}/amex/anchor`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      amexEndingBalance: number | null;
      asOf: string;
      source: string;
    };
    expect(body.source).toBe("plaid");
    expect(body.amexEndingBalance).toBeCloseTo(500.25 + 1200.5 + 75.0, 2);
    // asOf is the most recent liability_last_fetched_at across the linked
    // accounts (the Platinum row).
    expect(body.asOf).toBe(fetchedAt.toISOString());
  });

  it("still falls back to Plaid balance when only transactions (no debt) exist", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `amex-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "Some Bank",
        // Intentionally non-amex slug so discovery has to come from
        // the txn-derived path instead of institution_slug.
        institutionSlug: "some-bank",
      })
      .returning();
    const externalAcct = `acct-amex-${suffix}`;
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      itemId: item!.id,
      accountId: externalAcct,
      name: "Amex Card",
      mask: "1010",
      type: "credit",
      subtype: "credit card",
      liabilityBalance: "321.00",
      liabilityLastFetchedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      occurredOn: "2026-04-10",
      description: "Some Amex charge",
      amount: "-50.00",
      source: "plaid:amex",
      plaidAccountId: externalAcct,
    });

    const res = await fetch(`${baseUrl}/amex/anchor`);
    const body = (await res.json()) as {
      amexEndingBalance: number | null;
      source: string;
    };
    expect(body.source).toBe("plaid");
    expect(body.amexEndingBalance).toBeCloseTo(321.0, 2);
  });

  it("manual settings anchor still wins over the live Plaid balance", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `amex-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      itemId: item!.id,
      accountId: `acct-${suffix}`,
      name: "Amex",
      mask: "9999",
      type: "credit",
      subtype: "credit card",
      liabilityBalance: "100.00",
      liabilityLastFetchedAt: new Date("2026-04-15T00:00:00.000Z"),
    });
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      preferences: {
        amexAnchor: { balance: 999.99, asOf: "2026-04-01T00:00:00.000Z" },
      },
    });

    const res = await fetch(`${baseUrl}/amex/anchor`);
    const body = (await res.json()) as {
      amexEndingBalance: number;
      source: string;
    };
    expect(body.source).toBe("anchor");
    expect(body.amexEndingBalance).toBeCloseTo(999.99, 2);
  });

  it("returns missing when Plaid accounts exist but liability balances are null", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `amex-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      itemId: item!.id,
      accountId: `acct-${suffix}`,
      name: "Amex",
      mask: "9999",
      type: "credit",
      subtype: "credit card",
      // No liabilityBalance yet (Plaid sync hasn't run for this item).
    });

    const res = await fetch(`${baseUrl}/amex/anchor`);
    const body = (await res.json()) as {
      amexEndingBalance: number | null;
      source: string;
    };
    expect(body.source).toBe("missing");
    expect(body.amexEndingBalance).toBeNull();
  });
});
