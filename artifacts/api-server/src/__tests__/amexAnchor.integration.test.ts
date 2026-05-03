import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  settingsTable,
} from "@workspace/db";
import { refreshAmexAnchor } from "../lib/amexAnchor";

const USER = `amex-anchor-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, USER));
}

async function insertAmexTxn(
  date: string,
  amount: string,
  source: "amex" | "plaid:amex" = "amex",
): Promise<void> {
  await db.insert(transactionsTable).values({
    userId: USER,
    occurredOn: date,
    description: "Test charge",
    amount,
    source,
  });
}

async function insertAmexDebt(balance: string): Promise<string> {
  const [d] = await db
    .insert(debtsTable)
    .values({
      userId: USER,
      name: "American Express",
      balance,
      apr: "0.2849",
      minPayment: "40",
      payment: "40",
    })
    .returning({ id: debtsTable.id });
  return d!.id;
}

async function readAnchor(): Promise<{
  balance?: number;
  asOf?: string;
  lastAutoBalance?: number;
}> {
  const [s] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, USER));
  const prefs =
    (s?.preferences as { amexAnchor?: Record<string, unknown> } | null) ?? {};
  return (prefs.amexAnchor ?? {}) as {
    balance?: number;
    asOf?: string;
    lastAutoBalance?: number;
  };
}

beforeAll(cleanup);
afterAll(cleanup);
beforeEach(cleanup);

describe("refreshAmexAnchor", () => {
  it("no-ops with no Amex transactions", async () => {
    const r = await refreshAmexAnchor(USER);
    expect(r.changed).toBe(false);
    expect(r.balance).toBeNull();
    expect(await readAnchor()).toEqual({});
  });

  it("writes settings.amexAnchor and updates the linked debt on first run", async () => {
    await insertAmexTxn("2026-04-01", "100.00");
    await insertAmexTxn("2026-04-02", "50.50");
    const debtId = await insertAmexDebt("9999.99");

    const r = await refreshAmexAnchor(USER);
    expect(r.changed).toBe(true);
    expect(r.balance).toBeCloseTo(150.5, 2);
    expect(r.updatedDebt).toBe(true);

    const [d] = await db.select().from(debtsTable).where(eq(debtsTable.id, debtId));
    expect(Number(d!.balance)).toBeCloseTo(150.5, 2);

    const anchor = await readAnchor();
    expect(anchor.balance).toBeCloseTo(150.5, 2);
    expect(anchor.lastAutoBalance).toBeCloseTo(150.5, 2);
    expect(anchor.asOf).toBeTruthy();
  });

  it("respects manual UI overrides on subsequent auto-updates (adopt=false)", async () => {
    await insertAmexTxn("2026-04-01", "100.00");
    const debtId = await insertAmexDebt("100.00");

    // First refresh adopts (no prior anchor) → both anchor and debt = 100.
    await refreshAmexAnchor(USER);

    // User manually edits the debt balance through the UI.
    await db
      .update(debtsTable)
      .set({ balance: "777.77" })
      .where(eq(debtsTable.id, debtId));

    // A new Amex txn arrives.
    await insertAmexTxn("2026-04-05", "25.00");
    const r = await refreshAmexAnchor(USER, db, { adopt: false });

    // The settings anchor advances to the new computed balance...
    expect(r.balance).toBeCloseTo(125, 2);
    const anchor = await readAnchor();
    expect(anchor.balance).toBeCloseTo(125, 2);
    expect(anchor.lastAutoBalance).toBeCloseTo(125, 2);

    // ...but the debt row is left at the manual override.
    const [d] = await db.select().from(debtsTable).where(eq(debtsTable.id, debtId));
    expect(Number(d!.balance)).toBeCloseTo(777.77, 2);
    expect(r.updatedDebt).toBe(false);
  });

  it("aggregates both 'amex' and 'plaid:amex' transactions", async () => {
    await insertAmexTxn("2026-04-01", "100.00", "amex");
    await insertAmexTxn("2026-04-02", "25.00", "plaid:amex");
    await insertAmexTxn("2026-04-03", "-10.00", "plaid:amex");
    await insertAmexDebt("0");

    const r = await refreshAmexAnchor(USER);
    expect(r.txnCount).toBe(3);
    expect(r.balance).toBeCloseTo(115, 2);
  });

  it("adopt=true overwrites the debt even when it disagrees with the prior auto value", async () => {
    await insertAmexTxn("2026-04-01", "200.00");
    const debtId = await insertAmexDebt("0");

    // Seed a prior anchor whose lastAutoBalance does NOT match the debt.
    await db.insert(settingsTable).values({
      userId: USER,
      preferences: { amexAnchor: { balance: 999, lastAutoBalance: 999 } },
    });

    const r = await refreshAmexAnchor(USER, db, { adopt: true });
    expect(r.updatedDebt).toBe(true);
    const [d] = await db.select().from(debtsTable).where(eq(debtsTable.id, debtId));
    expect(Number(d!.balance)).toBeCloseTo(200, 2);
  });
});
