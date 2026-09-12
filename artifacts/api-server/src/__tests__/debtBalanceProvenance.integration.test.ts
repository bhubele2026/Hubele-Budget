import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

/**
 * (PR-E) Owner decision 2: a balance someone entered is never silently
 * replaced. The bank balance keeps arriving beside it, the API says whose the
 * active balance is and when each was set, "Use bank balance" is the explicit
 * way back, and a failed bank refresh is recorded and shown — never swallowed.
 */

const TEST_USER = `debt-prov-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

const plaidState = vi.hoisted(() => ({
  mode: "ok" as
    | "ok"
    | "plaidThrows"
    | "nonPlaidThrow"
    | "accountsOnlyThrows"
    | "liabilitiesOnlyThrows",
  accounts: [] as Array<{ account_id: string; current: number }>,
}));

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  const accounts = () =>
    plaidState.accounts.map((a) => ({
      account_id: a.account_id,
      type: "credit",
      subtype: "credit card",
      balances: { current: a.current },
    }));
  return {
    ...actual,
    plaid: () => ({
      accountsGet: async () => {
        if (plaidState.mode === "plaidThrows" || plaidState.mode === "accountsOnlyThrows") {
          throw new Error("bank said no (test)");
        }
        return { data: { accounts: accounts() } };
      },
      liabilitiesGet: async () => {
        if (plaidState.mode === "plaidThrows" || plaidState.mode === "liabilitiesOnlyThrows") {
          throw new Error("bank said no (test)");
        }
        return {
          data: {
            accounts: accounts(),
            liabilities: { credit: [], student: [], mortgage: [] },
          },
        };
      },
    }),
  };
});

vi.mock("../lib/plaidLiabilities", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaidLiabilities")>(
    "../lib/plaidLiabilities",
  );
  return {
    ...actual,
    fetchLiabilitiesForItem: async (
      ...args: Parameters<typeof actual.fetchLiabilitiesForItem>
    ) => {
      if (plaidState.mode === "nonPlaidThrow") {
        throw new TypeError("connection reset while caching balances (test)");
      }
      return actual.fetchLiabilitiesForItem(...args);
    },
  };
});

import {
  db,
  debtsTable,
  debtBalanceHistoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
} from "@workspace/db";
import debtsRouter from "../routes/debts";
import { linkRevolvingAmexDebts } from "../lib/linkRevolvingAmexDebts";
import { householdTodayISO } from "../lib/householdClock";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const { request } = createTestApp(debtsRouter);

type DebtJson = {
  id: string;
  balance: string;
  balanceSource: string;
  lastBalanceUpdate: string | null;
  aprSource: string;
  bankBalance: string | null;
  bankBalanceAt: string | null;
  bankBalanceStale: boolean;
  bankRefreshError: string | null;
  bankRefreshFailedAt: string | null;
};

async function cleanup(): Promise<void> {
  await db.delete(plaidSyncAttemptsTable).where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
  await db.delete(debtBalanceHistoryTable).where(eq(debtBalanceHistoryTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(async () => {
  await cleanup();
  plaidState.mode = "ok";
  plaidState.accounts = [];
});

async function seedItem(
  opts: { institutionName?: string; institutionSlug?: string } = {},
): Promise<string> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: opts.institutionName ?? "TestBank",
      institutionSlug: opts.institutionSlug ?? "testbank",
    })
    .returning();
  return item!.id;
}

async function seedAccount(
  itemRowId: string,
  opts: {
    liabilityBalance: string | null;
    liabilityLastFetchedAt: Date | null;
    name?: string;
    mask?: string;
    liabilityApr?: string | null;
    liabilityMinPayment?: string | null;
    liabilityKind?: string | null;
    liabilityDueDay?: number | null;
    liabilityStatementDay?: number | null;
  },
): Promise<{ accountRowId: string; externalId: string }> {
  const externalId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: itemRowId,
      accountId: externalId,
      name: opts.name ?? "Visa Card",
      mask: opts.mask ?? "1234",
      type: "credit",
      subtype: "credit card",
      liabilityBalance: opts.liabilityBalance,
      liabilityLastFetchedAt: opts.liabilityLastFetchedAt,
      liabilityApr: opts.liabilityApr ?? null,
      liabilityMinPayment: opts.liabilityMinPayment ?? null,
      liabilityKind: opts.liabilityKind ?? null,
      liabilityDueDay: opts.liabilityDueDay ?? null,
      liabilityStatementDay: opts.liabilityStatementDay ?? null,
    })
    .returning();
  return { accountRowId: acct!.id, externalId };
}

async function seedDebt(values: Partial<typeof debtsTable.$inferInsert> & { name: string }): Promise<string> {
  const [d] = await db
    .insert(debtsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      apr: "0.2000",
      minPayment: "25.00",
      payment: "25.00",
      ...values,
    })
    .returning({ id: debtsTable.id });
  return d!.id;
}

async function debtRow(id: string) {
  const [d] = await db.select().from(debtsTable).where(eq(debtsTable.id, id));
  return d!;
}

async function listDebts(): Promise<DebtJson[]> {
  const { status, json } = await request("GET", "/debts");
  expect(status).toBe(200);
  return json as DebtJson[];
}

const FRESH_SYNC = () => new Date(Date.now() - 60_000);
const STALE_SYNC = new Date("2026-01-01T00:00:00.000Z");

describe("(PR-E) a debt's balance provenance", () => {
  it("keeps a manual $5,000 balance while the bank says $4,812.40, and returns both, dated, with the source", async () => {
    const bankAt = new Date(Date.now() - 60 * 60 * 1000);
    const enteredAt = new Date("2026-09-01T17:00:00.000Z");
    const itemRowId = await seedItem();
    const { accountRowId } = await seedAccount(itemRowId, {
      liabilityBalance: "4812.40",
      liabilityLastFetchedAt: bankAt,
    });
    const debtId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      balanceSource: "manual",
      lastBalanceUpdate: enteredAt,
      plaidAccountId: accountRowId,
      plaidLastSyncedAt: FRESH_SYNC(),
    });

    const d = (await listDebts()).find((x) => x.id === debtId)!;

    expect(d.balance).toBe("5000.00");
    expect(d.balanceSource).toBe("manual");
    expect(d.lastBalanceUpdate).toBe(enteredAt.toISOString());
    expect(d.bankBalance).toBe("4812.40");
    expect(d.bankBalanceAt).toBe(bankAt.toISOString());
    expect(d.bankBalanceStale).toBe(false);
    expect(d.bankRefreshError).toBeNull();
    expect(d.bankRefreshFailedAt).toBeNull();
    expect((await debtRow(debtId)).balance).toBe("5000.00");
  });

  it("an unlinked debt carries no bank balance", async () => {
    const debtId = await seedDebt({ name: "Loan", balance: "300.00" });
    const d = (await listDebts()).find((x) => x.id === debtId)!;
    expect(d.bankBalance).toBeNull();
    expect(d.bankBalanceAt).toBeNull();
    expect(d.bankBalanceStale).toBe(false);
    expect(d.bankRefreshError).toBeNull();
  });

  it("a refresh keeps fetching the bank balance for a kept balance and never overwrites it — manual or an unknown source", async () => {
    const itemRowId = await seedItem();
    const a1 = await seedAccount(itemRowId, { liabilityBalance: "4812.40", liabilityLastFetchedAt: STALE_SYNC });
    const a2 = await seedAccount(itemRowId, { liabilityBalance: "300.00", liabilityLastFetchedAt: STALE_SYNC, mask: "5678" });
    plaidState.accounts = [
      { account_id: a1.externalId, current: 4700 },
      { account_id: a2.externalId, current: 250.55 },
    ];
    const manualId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      balanceSource: "manual",
      plaidAccountId: a1.accountRowId,
      plaidLastSyncedAt: STALE_SYNC,
    });
    const unknownId = await seedDebt({
      name: "Store card",
      balance: "900.00",
      balanceSource: "imported",
      plaidAccountId: a2.accountRowId,
      plaidLastSyncedAt: STALE_SYNC,
    });

    const debts = await listDebts();
    const manual = debts.find((x) => x.id === manualId)!;
    const unknown = debts.find((x) => x.id === unknownId)!;

    expect(manual.balance).toBe("5000.00");
    expect(manual.balanceSource).toBe("manual");
    expect(manual.bankBalance).toBe("4700.00");
    expect(unknown.balance).toBe("900.00");
    expect(unknown.balanceSource).toBe("imported");
    expect(unknown.bankBalance).toBe("250.55");
    expect((await debtRow(manualId)).balance).toBe("5000.00");
    expect((await debtRow(unknownId)).balance).toBe("900.00");
  });

  it("POST /debts/:id/use-bank-balance swaps in $4,812.40, marks it the bank's, and writes a history row", async () => {
    const itemRowId = await seedItem();
    const { accountRowId } = await seedAccount(itemRowId, {
      liabilityBalance: "4812.40",
      liabilityLastFetchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const debtId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      originalBalance: "6000.00",
      balanceSource: "manual",
      aprSource: "manual",
      plaidAccountId: accountRowId,
      plaidLastSyncedAt: FRESH_SYNC(),
    });

    const { status, json } = await request("POST", `/debts/${debtId}/use-bank-balance`);

    expect(status).toBe(200);
    const body = json as DebtJson;
    expect(body.balance).toBe("4812.40");
    expect(body.balanceSource).toBe("plaid");
    expect(body.aprSource).toBe("manual");
    expect(body.bankBalance).toBe("4812.40");
    const row = await debtRow(debtId);
    expect(row.balance).toBe("4812.40");
    expect(row.balanceSource).toBe("plaid");
    expect(row.originalBalance).toBe("6000.00");
    expect(row.lastBalanceUpdate).not.toBeNull();
    const history = await db
      .select()
      .from(debtBalanceHistoryTable)
      .where(
        and(
          eq(debtBalanceHistoryTable.debtId, debtId),
          eq(debtBalanceHistoryTable.recordedOn, householdTodayISO()),
        ),
      );
    expect(history.map((h) => h.balance)).toEqual(["4812.40"]);
  });

  it("use-bank-balance refuses an unlinked debt (400), a link with no bank balance (409) and an unknown debt (404), changing nothing", async () => {
    const unlinkedId = await seedDebt({ name: "Loan", balance: "300.00" });
    const itemRowId = await seedItem();
    const { accountRowId } = await seedAccount(itemRowId, {
      liabilityBalance: null,
      liabilityLastFetchedAt: null,
    });
    const noBankId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      plaidAccountId: accountRowId,
      plaidLastSyncedAt: FRESH_SYNC(),
    });

    expect((await request("POST", `/debts/${unlinkedId}/use-bank-balance`)).status).toBe(400);
    expect((await request("POST", `/debts/${noBankId}/use-bank-balance`)).status).toBe(409);
    expect((await request("POST", `/debts/${randomUUID()}/use-bank-balance`)).status).toBe(404);
    expect((await debtRow(unlinkedId)).balance).toBe("300.00");
    const noBank = await debtRow(noBankId);
    expect(noBank.balance).toBe("5000.00");
    expect(noBank.balanceSource).toBe("manual");
  });

  it("a bank refresh that fails at Plaid is recorded, GET /debts still answers, no balance moves, and the debt says so", async () => {
    plaidState.mode = "plaidThrows";
    const itemRowId = await seedItem();
    const a1 = await seedAccount(itemRowId, {
      liabilityBalance: "4812.40",
      liabilityLastFetchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const a2 = await seedAccount(itemRowId, {
      liabilityBalance: "1200.00",
      liabilityLastFetchedAt: new Date(Date.now() - 60 * 60 * 1000),
      mask: "5678",
    });
    const manualId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      plaidAccountId: a1.accountRowId,
      plaidLastSyncedAt: STALE_SYNC,
    });
    const bankId = await seedDebt({
      name: "Store card",
      balance: "1200.00",
      balanceSource: "plaid",
      plaidAccountId: a2.accountRowId,
      plaidLastSyncedAt: STALE_SYNC,
    });

    const debts = await listDebts();

    const manual = debts.find((x) => x.id === manualId)!;
    expect(manual.balance).toBe("5000.00");
    expect(manual.bankBalance).toBe("4812.40");
    // extractPlaidError words a non-Plaid-shaped error as "Couldn't reach Plaid…".
    expect(manual.bankRefreshError).toMatch(/Plaid/);
    expect(manual.bankRefreshFailedAt).not.toBeNull();
    expect(manual.bankBalanceStale).toBe(true);
    expect(debts.find((x) => x.id === bankId)!.balance).toBe("1200.00");
    expect((await debtRow(manualId)).balance).toBe("5000.00");
    expect((await debtRow(bankId)).balance).toBe("1200.00");
    const attempts = await db
      .select()
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    expect(attempts.map((a) => [a.kind, a.success])).toEqual([["liabilities", false]]);
  });

  it("a bank refresh that throws for any other reason is recorded once instead of vanishing into the catch", async () => {
    plaidState.mode = "nonPlaidThrow";
    const itemRowId = await seedItem();
    const { accountRowId } = await seedAccount(itemRowId, {
      liabilityBalance: "4812.40",
      liabilityLastFetchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const debtId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      plaidAccountId: accountRowId,
      plaidLastSyncedAt: STALE_SYNC,
    });

    const d = (await listDebts()).find((x) => x.id === debtId)!;

    expect(d.balance).toBe("5000.00");
    expect(d.bankRefreshError).toBe("connection reset while caching balances (test)");
    const attempts = await db
      .select()
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.kind).toBe("liabilities");
    expect(attempts[0]!.success).toBe(false);
  });

  it("the automatic revolving-Amex sweep links a same-name manual debt without replacing its balance, APR or minimum", async () => {
    const itemRowId = await seedItem({
      institutionName: "American Express",
      institutionSlug: "amex",
    });
    const { accountRowId } = await seedAccount(itemRowId, {
      name: "Sky Card",
      mask: "1001",
      liabilityBalance: "10512.33",
      liabilityLastFetchedAt: new Date(),
      liabilityApr: "0.2499",
      liabilityMinPayment: "315.00",
      liabilityKind: "credit",
      liabilityDueDay: 15,
      liabilityStatementDay: 20,
    });
    const debtId = await seedDebt({
      name: "American Express ••1001",
      balance: "10000.00",
      apr: "0.1999",
      minPayment: "250.00",
      payment: "250.00",
      balanceSource: "manual",
      statementDay: 3,
    });

    const summary = await linkRevolvingAmexDebts({ householdId: TEST_HOUSEHOLD_ID });

    expect(summary.linked).toBe(1);
    const row = await debtRow(debtId);
    expect(row.plaidAccountId).toBe(accountRowId);
    expect(row.balance).toBe("10000.00");
    expect(row.apr).toBe("0.1999");
    expect(row.minPayment).toBe("250.00");
    // Calendar hints only: an empty due day is filled, a typed statement day stays.
    expect(row.dueDay).toBe(15);
    expect(row.statementDay).toBe(3);
    expect([row.balanceSource, row.aprSource, row.minPaymentSource]).toEqual([
      "manual",
      "manual",
      "manual",
    ]);
    const d = (await listDebts()).find((x) => x.id === debtId)!;
    expect(d.balance).toBe("10000.00");
    expect(d.bankBalance).toBe("10512.33");
  });

  it("(review H1) a hand edit dates the entered balance now: PATCH then GET shows the edit's date beside the bank's", async () => {
    const itemRowId = await seedItem();
    const bankAt = new Date(Date.now() - 60 * 60 * 1000);
    const { accountRowId } = await seedAccount(itemRowId, {
      liabilityBalance: "4812.40",
      liabilityLastFetchedAt: bankAt,
    });
    const aug1 = new Date("2026-08-01T17:00:00.000Z");
    const debtId = await seedDebt({
      name: "Visa",
      balance: "4812.40",
      balanceSource: "plaid",
      lastBalanceUpdate: aug1,
      plaidAccountId: accountRowId,
      plaidLastSyncedAt: FRESH_SYNC(),
    });
    const before = Date.now();

    const patch = await request("PATCH", `/debts/${debtId}`, { balance: "5000.00" });

    expect(patch.status).toBe(200);
    const d = (await listDebts()).find((x) => x.id === debtId)!;
    expect(d.balance).toBe("5000.00");
    expect(d.balanceSource).toBe("manual");
    expect(d.lastBalanceUpdate).not.toBeNull();
    expect(new Date(d.lastBalanceUpdate!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(d.bankBalance).toBe("4812.40");
    expect(d.bankBalanceAt).toBe(bankAt.toISOString());
  });

  it("(review H1) an edit that leaves the balance alone keeps the balance's date", async () => {
    const aug1 = new Date("2026-08-01T17:00:00.000Z");
    const debtId = await seedDebt({
      name: "Loan",
      balance: "5000.00",
      lastBalanceUpdate: aug1,
    });
    const patch = await request("PATCH", `/debts/${debtId}`, { apr: "0.1500" });
    expect(patch.status).toBe(200);
    expect((await debtRow(debtId)).lastBalanceUpdate).toEqual(aug1);
  });

  it("(review) PATCH with the same numbers written differently ('5000' for '5000.00', '0.2' for '0.2000') changes nothing: no new date, source or history", async () => {
    const aug1 = new Date("2026-08-01T17:00:00.000Z");
    const debtId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      balanceSource: "plaid",
      apr: "0.2000",
      aprSource: "plaid",
      minPayment: "25.00",
      minPaymentSource: "plaid",
      lastBalanceUpdate: aug1,
    });

    const patch = await request("PATCH", `/debts/${debtId}`, {
      balance: "5000",
      apr: "0.2",
      minPayment: "25",
    });

    expect(patch.status).toBe(200);
    const row = await debtRow(debtId);
    expect(row.lastBalanceUpdate).toEqual(aug1);
    expect([row.balanceSource, row.aprSource, row.minPaymentSource]).toEqual([
      "plaid",
      "plaid",
      "plaid",
    ]);
    const history = await db
      .select()
      .from(debtBalanceHistoryTable)
      .where(eq(debtBalanceHistoryTable.debtId, debtId));
    expect(history).toEqual([]);

    // A real change of one cent is still a change.
    await request("PATCH", `/debts/${debtId}`, { balance: "5000.01" });
    expect((await debtRow(debtId)).balanceSource).toBe("manual");
  });

  it("(review H1) POST /debts with a balance dates it now, so a debt created by hand never shows 'date unknown'", async () => {
    const before = Date.now();
    const { status, json } = await request("POST", "/debts", {
      name: "Hand-made card",
      balance: "750.00",
      apr: "0.1999",
      minPayment: "25.00",
    });
    expect(status).toBe(201);
    const body = json as DebtJson;
    expect(body.lastBalanceUpdate).not.toBeNull();
    expect(new Date(body.lastBalanceUpdate!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await debtRow(body.id)).lastBalanceUpdate).not.toBeNull();
  });

  it("(review) a failed accounts call while the liabilities call answers is not a failed refresh: the balance lands, nothing is recorded as failed", async () => {
    plaidState.mode = "accountsOnlyThrows";
    const itemRowId = await seedItem();
    const a = await seedAccount(itemRowId, {
      liabilityBalance: "4812.40",
      liabilityLastFetchedAt: STALE_SYNC,
    });
    plaidState.accounts = [{ account_id: a.externalId, current: 4700 }];
    const debtId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      plaidAccountId: a.accountRowId,
      plaidLastSyncedAt: STALE_SYNC,
    });

    const d = (await listDebts()).find((x) => x.id === debtId)!;

    expect(d.bankBalance).toBe("4700.00");
    expect(d.bankRefreshError).toBeNull();
    expect(d.bankBalanceStale).toBe(false);
    expect(d.balance).toBe("5000.00");
    const attempts = await db
      .select()
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    expect(attempts.map((x) => [x.kind, x.success])).toEqual([["liabilities", true]]);
  });

  it("(review) a failed liabilities call is still recorded, even though the accounts call refreshed the balance", async () => {
    plaidState.mode = "liabilitiesOnlyThrows";
    const itemRowId = await seedItem();
    const a = await seedAccount(itemRowId, {
      liabilityBalance: "4812.40",
      liabilityLastFetchedAt: STALE_SYNC,
    });
    plaidState.accounts = [{ account_id: a.externalId, current: 4700 }];
    const debtId = await seedDebt({
      name: "Visa",
      balance: "5000.00",
      plaidAccountId: a.accountRowId,
      plaidLastSyncedAt: STALE_SYNC,
    });

    const d = (await listDebts()).find((x) => x.id === debtId)!;

    expect(d.bankBalance).toBe("4700.00");
    expect(d.bankRefreshError).not.toBeNull();
    const attempts = await db
      .select()
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    expect(attempts.map((x) => [x.kind, x.success])).toEqual([["liabilities", false]]);
  });
});
