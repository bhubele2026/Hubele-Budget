import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

/**
 * (PR-E) A failed Amex estimate refresh is RECORDED — never swallowed by an
 * empty catch — never fails the sync or the import, and never moves a balance.
 * The real refresh, run by a sync of Plaid Amex rows, no longer throws.
 */

const USER = `amex-recorded-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

const anchorMode = vi.hoisted(() => ({
  mode: "actual" as "actual" | "throw" | "sqlError",
}));

vi.mock("../lib/amexAnchor", async () => {
  const actual = await vi.importActual<typeof import("../lib/amexAnchor")>("../lib/amexAnchor");
  const { sql: rawSql } = await import("drizzle-orm");
  return {
    ...actual,
    refreshAmexAnchor: async (
      userId: string,
      exec: Parameters<typeof actual.refreshAmexAnchor>[1],
    ) => {
      if (anchorMode.mode === "throw") throw new Error("estimate refresh exploded (test)");
      if (anchorMode.mode === "sqlError") await exec!.execute(rawSql`select 1/0`);
      return actual.refreshAmexAnchor(userId, exec);
    },
  };
});

type AddedTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
};
const plaidState = vi.hoisted(() => ({
  added: [] as Array<{
    transaction_id: string;
    account_id: string;
    date: string;
    amount: number;
    name: string;
  }>,
}));

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: {
          added: plaidState.added,
          modified: [],
          removed: [],
          next_cursor: "cursor-next",
          has_more: false,
        },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "item-default", consent_expiration_time: null } },
      }),
    }),
  };
});

import {
  db,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { refreshAmexAnchorRecorded } from "../lib/amexAnchorRefresh";
import { syncPlaidItem } from "../lib/plaidSync";
import { createTestHousehold } from "./_helpers/testHousehold";

async function cleanup(): Promise<void> {
  await db.delete(plaidSyncAttemptsTable).where(eq(plaidSyncAttemptsTable.userId, USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(async () => {
  await cleanup();
  anchorMode.mode = "actual";
  plaidState.added = [];
});

async function readAnchor(): Promise<Record<string, unknown>> {
  const [s] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, USER));
  const prefs = (s?.preferences as Record<string, unknown> | null) ?? {};
  return (prefs.amexAnchor ?? {}) as Record<string, unknown>;
}

async function seedAmex(): Promise<{
  itemRowId: string;
  externalId: string;
  linkedDebtId: string;
  namedDebtId: string;
}> {
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
  const [linked] = await db
    .insert(debtsTable)
    .values({
      userId: USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Amex Gold",
      balance: "1000.00",
      balanceSource: "plaid",
      plaidAccountId: acct!.id,
    })
    .returning();
  const [named] = await db
    .insert(debtsTable)
    .values({
      userId: USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "American Express",
      balance: "777.77",
    })
    .returning();
  return {
    itemRowId: item!.id,
    externalId,
    linkedDebtId: linked!.id,
    namedDebtId: named!.id,
  };
}

async function balances(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: debtsTable.id, balance: debtsTable.balance })
    .from(debtsTable)
    .where(inArray(debtsTable.id, ids));
  return ids.map((id) => rows.find((r) => r.id === id)!.balance);
}

async function attemptsFor(itemRowId: string) {
  return db
    .select()
    .from(plaidSyncAttemptsTable)
    .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId))
    .orderBy(asc(plaidSyncAttemptsTable.attemptedAt));
}

function charge(externalId: string): AddedTxn {
  return {
    transaction_id: `plaid-${randomUUID()}`,
    account_id: externalId,
    date: "2026-09-08",
    amount: 42.5,
    name: "Grocer",
  };
}

describe("(PR-E) refreshAmexAnchorRecorded", () => {
  it("inside a caller's transaction, a failed statement is recorded on the pref and the caller's transaction still commits", async () => {
    anchorMode.mode = "sqlError";
    let outcome: Awaited<ReturnType<typeof refreshAmexAnchorRecorded>> | undefined;

    await db.transaction(async (tx) => {
      await tx.insert(debtsTable).values({
        userId: USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Before",
        balance: "10.00",
      });
      outcome = await refreshAmexAnchorRecorded({
        ownerUserId: USER,
        exec: tx,
        context: "workbook-import",
      });
      await tx.insert(debtsTable).values({
        userId: USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "After",
        balance: "20.00",
      });
    });

    expect(outcome?.ok).toBe(false);
    expect(outcome && !outcome.ok ? outcome.error : "").toMatch(/division by zero/);
    const names = (
      await db
        .select({ name: debtsTable.name })
        .from(debtsTable)
        .where(eq(debtsTable.userId, USER))
        .orderBy(asc(debtsTable.name))
    ).map((r) => r.name);
    expect(names).toEqual(["After", "Before"]);
    const anchor = await readAnchor();
    expect(anchor.refreshError).toMatch(/division by zero/);
    expect(anchor.refreshFailedAt).toBeTruthy();
  });

  it("a refresh that throws during a Plaid sync is recorded as an amex_anchor attempt and on the pref; the sync completes and no balance moves", async () => {
    anchorMode.mode = "throw";
    const { itemRowId, externalId, linkedDebtId, namedDebtId } = await seedAmex();
    plaidState.added = [charge(externalId)];

    const result = await syncPlaidItem(USER, itemRowId);

    expect(result.error ?? null).toBeNull();
    expect(result.added).toBe(1);
    const attempts = await attemptsFor(itemRowId);
    const anchorRows = attempts.filter((a) => a.kind === "amex_anchor");
    expect(anchorRows).toHaveLength(1);
    expect(anchorRows[0]!.success).toBe(false);
    expect(anchorRows[0]!.errorMessage).toMatch(/exploded/);
    expect(attempts.some((a) => a.kind === "transactions" && a.success)).toBe(true);
    expect((await readAnchor()).refreshError).toMatch(/exploded/);
    expect(await balances([linkedDebtId, namedDebtId])).toEqual(["1000.00", "777.77"]);
  });

  it("the real refresh, run by a sync of Plaid Amex rows, no longer throws: the estimate lands, nothing is recorded, no balance moves", async () => {
    const { itemRowId, externalId, linkedDebtId, namedDebtId } = await seedAmex();
    plaidState.added = [charge(externalId), { ...charge(externalId), amount: 7.25 }];

    const result = await syncPlaidItem(USER, itemRowId);

    expect(result.error ?? null).toBeNull();
    const [sum] = await db
      .select({
        net: sql<string>`sum(${transactionsTable.amount})::text`,
        n: sql<number>`count(*)::int`,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, USER),
          inArray(transactionsTable.source, ["amex", "plaid:amex"]),
        ),
      );
    expect(sum!.n).toBe(2);
    const anchor = await readAnchor();
    expect(anchor.computedBalance).toBeCloseTo(Number(sum!.net), 2);
    expect(anchor.computedTxnCount).toBe(2);
    expect(anchor.refreshError).toBeUndefined();
    expect((await attemptsFor(itemRowId)).filter((a) => a.kind === "amex_anchor")).toEqual([]);
    expect(await balances([linkedDebtId, namedDebtId])).toEqual(["1000.00", "777.77"]);
  });

  it("the next successful refresh clears a recorded failure", async () => {
    const { itemRowId, externalId } = await seedAmex();
    anchorMode.mode = "throw";
    plaidState.added = [charge(externalId)];
    await syncPlaidItem(USER, itemRowId);
    expect((await readAnchor()).refreshError).toMatch(/exploded/);

    anchorMode.mode = "actual";
    plaidState.added = [];
    await syncPlaidItem(USER, itemRowId);

    const anchor = await readAnchor();
    expect(anchor.refreshError).toBeUndefined();
    expect(anchor.refreshFailedAt).toBeUndefined();
    expect(anchor.computedTxnCount).toBe(1);
  });
});
