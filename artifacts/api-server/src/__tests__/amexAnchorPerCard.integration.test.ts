import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

// ⭐ (WP8b) GET /amex/anchor?accountId= — ONE CARD'S OWN FIGURE, FOR ANY CARD.
//
// A card's own page (WP7 lists any card's rows) anchors its running balances
// and chart on the card's own current balance: Plaid's stored liability figure
// (what the account Summary prints as "Card's current balance" for a card with
// no debt row) or the card's debt row. Outside the Amex set the per-card answer
// was `missing`, and the page ran "bal" and its chart up from $0. And a single
// card's balance is never a running sum of its rows from $0 (`computed`).

const TEST_USER = `amex-per-card-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

import { db, debtsTable, plaidAccountsTable, plaidItemsTable, settingsTable, transactionsTable } from "@workspace/db";
import amexRouter from "../routes/amex";
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

type Anchor = { amexEndingBalance: number | null; asOf: string; source: string };
async function anchor(accountId?: string): Promise<Anchor> {
  const res = await fetch(`${baseUrl}/amex/anchor${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Anchor;
}

const FETCHED = new Date("2026-09-16T11:00:00.000Z");
let ids: Record<"plat" | "blue" | "delta" | "freedom" | "citi" | "sapphire" | "checking", string>;

/** Amex Platinum (Plaid figure), Amex Blue (rows only), Delta (Plaid figure), Chase Freedom (Plaid figure),
 *  Citi (rows only), Chase Sapphire (a debt row, no Plaid figure), Chase checking. */
async function seed(): Promise<void> {
  const s = randomUUID().slice(0, 8);
  const item = async (name: string, slug: string) =>
    (
      await db
        .insert(plaidItemsTable)
        .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: `item-${slug}-${s}`, accessToken: "t", institutionName: name, institutionSlug: slug })
        .returning()
    )[0]!.id;
  const amex = await item("American Express", "amex");
  const chase = await item("Chase", "chase");
  const citi = await item("Citi", "citi");
  ids = {
    plat: `plat-${s}`,
    blue: `blue-${s}`,
    delta: `delta-${s}`,
    freedom: `freedom-${s}`,
    citi: `citi-${s}`,
    sapphire: `sapphire-${s}`,
    checking: `chk-${s}`,
  };
  const card = (itemId: string, accountId: string, name: string, mask: string, liabilityBalance: string | null) => ({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId,
    accountId,
    name,
    mask,
    type: "credit",
    subtype: "credit card",
    liabilityBalance,
    liabilityLastFetchedAt: liabilityBalance ? FETCHED : null,
  });
  const rows = await db
    .insert(plaidAccountsTable)
    .values([
      card(amex, ids.plat, "Amex Platinum", "1005", "3842.98"),
      card(amex, ids.blue, "Blue Cash Preferred", "1001", null),
      card(amex, ids.delta, "Delta SkyMiles Gold", "1009", "11500.00"),
      card(chase, ids.freedom, "Freedom Unlimited", "4417", "512.34"),
      card(citi, ids.citi, "Double Cash", "6620", null),
      card(chase, ids.sapphire, "Sapphire Preferred", "7730", null),
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: chase, accountId: ids.checking, name: "Total Checking", mask: "5526", type: "depository", subtype: "checking" },
    ])
    .returning({ id: plaidAccountsTable.id, accountId: plaidAccountsTable.accountId });
  const sapphireRowId = rows.find((r) => r.accountId === ids.sapphire)!.id;
  await db.insert(debtsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    name: "Chase Sapphire",
    balance: "1450.00",
    apr: "0.2499",
    minPayment: "35",
    payment: "35",
    plaidAccountId: sapphireRowId,
    updatedAt: new Date("2026-09-15T15:00:00.000Z"),
  });
  const txn = (accountId: string, source: string, amount: string, on: string) => ({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    occurredOn: on,
    description: `ROW ${accountId} ${on}`,
    amount,
    source,
    plaidAccountId: accountId,
    plaidTransactionId: `ptx-${randomUUID()}`,
  });
  await db.insert(transactionsTable).values([
    txn(ids.plat, "plaid:amex", "-120.00", "2026-09-10"),
    txn(ids.blue, "plaid:amex", "-64.20", "2026-09-11"),
    txn(ids.blue, "plaid:amex", "-18.75", "2026-09-12"),
    txn(ids.freedom, "plaid:chase", "-14.82", "2026-09-15"),
    txn(ids.citi, "plaid:citi", "-22.40", "2026-09-15"),
  ]);
}

describe("(WP8b) GET /amex/anchor?accountId= answers the card's own figure for ANY credit card", () => {
  beforeEach(seed);

  it("a card outside the Amex set answers Plaid's stored liability balance (it answered missing)", async () => {
    expect(await anchor(ids.freedom)).toEqual({ amexEndingBalance: 512.34, asOf: FETCHED.toISOString(), source: "plaid" });
  });

  it("a card outside the Amex set with a debt row and no Plaid figure answers the debt row", async () => {
    const a = await anchor(ids.sapphire);
    expect(a).toMatchObject({ amexEndingBalance: 1450, source: "debt" });
  });

  it("a card with no figure at all answers missing — never a running sum of its rows from $0, in the Amex set or out of it", async () => {
    for (const id of [ids.citi, ids.blue]) {
      const a = await anchor(id);
      expect(a.source, id).toBe("missing");
      expect(a.amexEndingBalance, id).toBeNull();
    }
  });

  it("an Amex card still answers its own Plaid figure; the Delta charge card, out of the combined set, answers its own on its own page", async () => {
    expect(await anchor(ids.plat)).toMatchObject({ amexEndingBalance: 3842.98, source: "plaid" });
    expect(await anchor(ids.delta)).toMatchObject({ amexEndingBalance: 11500, source: "plaid" });
  });

  it("a depository account or an unknown id is not a card: missing", async () => {
    for (const id of [ids.checking, `nobody-${randomUUID()}`]) {
      expect((await anchor(id)).source, id).toBe("missing");
    }
  });

  it("the combined answer is unchanged: the Amex set's Plaid figures only (no Delta, no other bank's card)", async () => {
    // Platinum 3842.98 + Blue (no figure). Freedom, Citi, Sapphire and Delta stay out.
    expect(await anchor()).toMatchObject({ amexEndingBalance: 3842.98, source: "plaid" });
  });
});
