import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  settingsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import {
  refreshAmexAnchor,
  anchorBalanceIsRefreshOwned,
} from "../lib/amexAnchor";
import { createTestHousehold } from "./_helpers/testHousehold";

/**
 * (PR-E) The Amex estimate refresh never writes a debt balance, resolves Plaid
 * rows through `plaid_accounts.account_id`, and keeps an anchor balance that was
 * typed in. Owner decision 2: repairing the integration must not silently
 * replace a balance someone deliberately entered.
 */

const USER = `amex-anchor-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, USER));
}

async function insertAmexTxn(
  date: string,
  amount: string,
  source: "amex" | "plaid:amex" = "amex",
  plaidAccountId: string | null = null,
): Promise<void> {
  await db.insert(transactionsTable).values({
    userId: USER,
    householdId: TEST_HOUSEHOLD_ID,
    occurredOn: date,
    description: "Test charge",
    amount,
    source,
    plaidAccountId,
  });
}

async function insertDebt(opts: {
  name: string;
  balance: string;
  balanceSource?: string;
  plaidAccountId?: string | null;
}): Promise<string> {
  const [d] = await db
    .insert(debtsTable)
    .values({
      userId: USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: opts.name,
      balance: opts.balance,
      apr: "0.2849",
      minPayment: "40",
      payment: "40",
      balanceSource: opts.balanceSource ?? "manual",
      plaidAccountId: opts.plaidAccountId ?? null,
    })
    .returning({ id: debtsTable.id });
  return d!.id;
}

async function debtRow(id: string) {
  const [d] = await db.select().from(debtsTable).where(eq(debtsTable.id, id));
  return d!;
}

async function readPrefs(): Promise<Record<string, unknown>> {
  const [s] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, USER));
  return (s?.preferences as Record<string, unknown> | null) ?? {};
}

async function readAnchor(): Promise<Record<string, unknown>> {
  return ((await readPrefs()).amexAnchor ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  const _h = await createTestHousehold(USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(cleanup);

describe("refreshAmexAnchor", () => {
  it("no-ops with no Amex transactions", async () => {
    const r = await refreshAmexAnchor(USER);
    expect(r.changed).toBe(false);
    expect(r.balance).toBeNull();
    expect(await readAnchor()).toEqual({});
  });

  it("never moves a never-anchored household's Amex-named debt; it writes the estimate only", async () => {
    await insertAmexTxn("2026-04-01", "100.00");
    await insertAmexTxn("2026-04-02", "50.50");
    const debtId = await insertDebt({ name: "American Express", balance: "9999.99" });
    const before = await debtRow(debtId);

    const r = await refreshAmexAnchor(USER);
    expect(r.changed).toBe(true);
    expect(r.balance).toBeCloseTo(150.5, 2);
    expect(r.keptEnteredAnchor).toBe(false);

    const after = await debtRow(debtId);
    expect(after.balance).toBe("9999.99");
    expect(after.balanceSource).toBe("manual");
    expect(after.lastBalanceUpdate).toEqual(before.lastBalanceUpdate);
    expect(after.updatedAt).toEqual(before.updatedAt);

    const anchor = await readAnchor();
    expect(anchor.balance).toBeCloseTo(150.5, 2);
    expect(anchor.lastAutoBalance).toBeCloseTo(150.5, 2);
    expect(anchor.computedBalance).toBeCloseTo(150.5, 2);
    expect(anchor.computedTxnCount).toBe(2);
    expect(anchor.asOf).toBeTruthy();
  });

  it("never moves an Amex-named debt that still equals the last estimate (the old 'unedited' case)", async () => {
    await insertAmexTxn("2026-04-01", "100.00");
    const debtId = await insertDebt({ name: "Amex Gold", balance: "100.00" });
    await refreshAmexAnchor(USER);
    await insertAmexTxn("2026-04-05", "25.00");

    const r = await refreshAmexAnchor(USER, db);

    expect(r.balance).toBeCloseTo(125, 2);
    expect((await readAnchor()).balance).toBeCloseTo(125, 2);
    expect((await debtRow(debtId)).balance).toBe("100.00");
  });

  it("resolves Plaid Amex rows through plaid_accounts.account_id, reports the linked debt, and writes to no debt", async () => {
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `item-${randomUUID()}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    const externalId = `acct-${randomUUID()}`;
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: externalId,
        name: "Amex Gold",
        type: "credit",
        subtype: "credit card",
      })
      .returning();
    const linkedId = await insertDebt({
      name: "Amex Gold",
      balance: "1000.00",
      balanceSource: "plaid",
      plaidAccountId: acct!.id,
    });
    const namedId = await insertDebt({ name: "American Express", balance: "777.77" });
    await insertAmexTxn("2026-04-01", "-42.00", "plaid:amex", externalId);
    await insertAmexTxn("2026-04-02", "-7.50", "plaid:amex", externalId);
    await insertAmexTxn("2026-03-01", "20.00", "amex");

    // Before PR-E this threw: `${debts.plaid_account_id}::text = ANY(${array})`.
    const r = await refreshAmexAnchor(USER);

    expect(r.txnCount).toBe(3);
    expect(r.balance).toBeCloseTo(-29.5, 2);
    expect(r.accountIds).toEqual([externalId]);
    expect(r.linkedDebtIds).toEqual([linkedId]);
    expect((await debtRow(linkedId)).balance).toBe("1000.00");
    expect((await debtRow(namedId)).balance).toBe("777.77");
    expect((await readAnchor()).computedBalance).toBeCloseTo(-29.5, 2);
  });

  it("aggregates both 'amex' and 'plaid:amex' transactions", async () => {
    await insertAmexTxn("2026-04-01", "100.00", "amex");
    await insertAmexTxn("2026-04-02", "25.00", "plaid:amex");
    await insertAmexTxn("2026-04-03", "-10.00", "plaid:amex");

    const r = await refreshAmexAnchor(USER);
    expect(r.txnCount).toBe(3);
    expect(r.balance).toBeCloseTo(115, 2);
  });

  it("keeps an anchor balance typed in through POST /amex/anchor, and stores the estimate beside it", async () => {
    await db.insert(settingsTable).values({
      userId: USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: {
        amexAnchor: { balance: 1293.08, asOf: "2026-09-01T12:00:00.000Z" },
        amexCardCadence: { "acct-1": "monthly" },
      },
    });
    await insertAmexTxn("2026-04-01", "200.00");

    const r = await refreshAmexAnchor(USER);

    expect(r.keptEnteredAnchor).toBe(true);
    const prefs = await readPrefs();
    expect(prefs.amexCardCadence).toEqual({ "acct-1": "monthly" });
    const anchor = prefs.amexAnchor as Record<string, unknown>;
    expect(anchor.balance).toBe(1293.08);
    expect(anchor.asOf).toBe("2026-09-01T12:00:00.000Z");
    expect(anchor.lastAutoBalance).toBeUndefined();
    expect(anchor.computedBalance).toBeCloseTo(200, 2);

    // Still kept on the next run.
    await insertAmexTxn("2026-04-02", "5.00");
    await refreshAmexAnchor(USER);
    const again = await readAnchor();
    expect(again.balance).toBe(1293.08);
    expect(again.computedBalance).toBeCloseTo(205, 2);
  });

  it("keeps an anchor balance whose origin is unknown (lastAutoBalance disagrees with it)", async () => {
    await db.insert(settingsTable).values({
      userId: USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: { amexAnchor: { balance: 500, asOf: "2026-08-01T00:00:00.000Z", lastAutoBalance: 450 } },
    });
    await insertAmexTxn("2026-04-01", "60.00");
    await refreshAmexAnchor(USER);
    const anchor = await readAnchor();
    expect(anchor.balance).toBe(500);
    expect(anchor.lastAutoBalance).toBe(450);
    expect(anchor.computedBalance).toBeCloseTo(60, 2);
  });

  it("moves its own last write, clears a recorded failure, and leaves other preference keys alone", async () => {
    await db.insert(settingsTable).values({
      userId: USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: {
        amexAnchor: {
          balance: 100,
          asOf: "2026-08-01T00:00:00.000Z",
          lastAutoBalance: 100,
          refreshError: "boom",
          refreshFailedAt: "2026-09-10T00:00:00.000Z",
        },
        weeklyAllowanceOverrides: { "2026-09-06": "150.00" },
      },
    });
    await insertAmexTxn("2026-04-01", "300.00");

    const r = await refreshAmexAnchor(USER);

    expect(r.keptEnteredAnchor).toBe(false);
    const prefs = await readPrefs();
    expect(prefs.weeklyAllowanceOverrides).toEqual({ "2026-09-06": "150.00" });
    const anchor = prefs.amexAnchor as Record<string, unknown>;
    expect(anchor.balance).toBeCloseTo(300, 2);
    expect(anchor.lastAutoBalance).toBeCloseTo(300, 2);
    expect(anchor.refreshError).toBeUndefined();
    expect(anchor.refreshFailedAt).toBeUndefined();
  });
});

describe("anchorBalanceIsRefreshOwned", () => {
  it("owns nothing stored, or a stored object with no balance", () => {
    expect(anchorBalanceIsRefreshOwned(undefined)).toBe(true);
    expect(anchorBalanceIsRefreshOwned(null)).toBe(true);
    expect(anchorBalanceIsRefreshOwned({ refreshError: "x" })).toBe(true);
  });
  it("owns a balance equal to its own lastAutoBalance", () => {
    expect(anchorBalanceIsRefreshOwned({ balance: 12.34, lastAutoBalance: 12.34 })).toBe(true);
    expect(anchorBalanceIsRefreshOwned({ balance: "12.34", lastAutoBalance: 12.34 })).toBe(true);
  });
  it("never owns a typed-in balance or one of unknown origin", () => {
    expect(anchorBalanceIsRefreshOwned({ balance: 12.34, asOf: "2026-09-01" })).toBe(false);
    expect(anchorBalanceIsRefreshOwned({ balance: 12.34, lastAutoBalance: 12.0 })).toBe(false);
    expect(anchorBalanceIsRefreshOwned({ balance: "abc", lastAutoBalance: "abc" })).toBe(false);
  });
});
