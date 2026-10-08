// (B5) REGRESSION — the Amex anchor refresh on Plaid-synced rows.
//
// `refreshAmexAnchor` looked for a debt linked to the card with
// `plaid_account_id::text = ANY(${ids})`. Drizzle spreads a JS array into a
// parameter list, so Postgres received `ANY(($2))` and refused it ("malformed
// array literal") whenever an Amex row carried a `plaid_account_id` — that is,
// on every Plaid-synced Amex row. The sync swallows the error, so neither
// `settings.amexAnchor` nor the auto-anchored debt balance ever moved after a
// Plaid sync (B4 scenario, difference D3: docs/reviews/2026-10-08-b4-money-proof.md).
//
// The same events as the B4 scenario: a $500.00 anchor (debt and settings),
// then a $86.33 charge, a $20.00 refund and a $100.00 payment on the card, each
// a `plaid:amex` row WITH its Plaid account id. Expected after each refresh:
// 586.33 / 566.33 / 466.33 owed, 41.367 / 43.367 / 53.367 % paid.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, debtsTable, settingsTable, transactionsTable } from "@workspace/db";
import { payoffPct } from "@workspace/avalanche-core";
import { refreshAmexAnchor } from "../lib/amexAnchor";
import { createTestHousehold } from "./_helpers/testHousehold";

const USER = `amex-anchor-plaid-${process.pid}-${randomUUID().slice(0, 8)}`;
const CARD = `ext-amex-1005-${randomUUID().slice(0, 8)}`;
let HH = "";
let DEBT = "";

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, USER));
}

async function cardRow(occurredOn: string, description: string, amount: string): Promise<void> {
  await db.insert(transactionsTable).values({
    userId: USER,
    householdId: HH,
    occurredOn,
    description,
    amount,
    source: "plaid:amex",
    plaidAccountId: CARD,
    plaidTransactionId: `${CARD}-${description}-${occurredOn}`,
  });
}

async function debtNow() {
  const [d] = await db.select().from(debtsTable).where(eq(debtsTable.id, DEBT));
  return d!;
}

beforeAll(async () => {
  HH = (await createTestHousehold(USER)).householdId;
  await cleanup();
  const [d] = await db
    .insert(debtsTable)
    .values({ userId: USER, householdId: HH, name: "American Express", balance: "500.00", originalBalance: "1000.00" })
    .returning({ id: debtsTable.id });
  DEBT = d!.id;
  await db.insert(settingsTable).values({
    userId: USER,
    householdId: HH,
    preferences: { amexAnchor: { balance: 500, asOf: "2026-10-01T12:00:00.000Z", lastAutoBalance: 500 } },
  });
  await cardRow("2026-08-14", "DELTA AIR LINES", "-500.00");
});
afterAll(cleanup);

describe("refreshAmexAnchor on Plaid rows that carry plaid_account_id", () => {
  for (const [step, row, owed, pct] of [
    ["charge $86.33", ["2026-10-06", "KROGER #442", "-86.33"], "586.33", "41.367"],
    ["refund $20.00", ["2026-10-08", "KROGER #442 REFUND", "20.00"], "566.33", "43.367"],
    ["payment $100.00", ["2026-10-12", "ONLINE PAYMENT - THANK YOU", "100.00"], "466.33", "53.367"],
  ] as const) {
    it(`${step}: the anchor and the auto-anchored debt move to ${owed}`, async () => {
      await cardRow(row[0], row[1], row[2]);
      const r = await refreshAmexAnchor(USER);
      expect(r).toMatchObject({ changed: true, updatedDebt: true, balance: Number(owed) });
      const d = await debtNow();
      expect(d.balance).toBe(owed);
      expect(payoffPct([d])?.toFixed(3)).toBe(pct);
      const [s] = await db.select().from(settingsTable).where(eq(settingsTable.userId, USER));
      expect((s!.preferences as { amexAnchor: { balance: number; lastAutoBalance: number } }).amexAnchor).toMatchObject({
        balance: Number(owed),
        lastAutoBalance: Number(owed),
      });
    });
  }
});
