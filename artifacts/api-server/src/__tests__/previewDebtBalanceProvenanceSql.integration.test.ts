import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inArray } from "drizzle-orm";

/** The part of node-postgres's per-statement result this test reads. */
type QueryResult = { command: string; rows: unknown[] };
import {
  db,
  pool,
  debtBalanceHistoryTable,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { createTestHousehold } from "./_helpers/testHousehold";

/**
 * (PR-E review M1) The production preview must size what the merge changes.
 * This runs the READ ONLY file itself against seeded households and checks each
 * flag, so the preview cannot drift from the code it describes.
 */

const SQL_PATH = fileURLToPath(
  new URL("../../scripts/sql/preview-debt-balance-provenance.sql", import.meta.url),
);

const tag = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const U1 = `preview-sql-a-${tag}`;
const U2 = `preview-sql-b-${tag}`;
const U3 = `preview-sql-c-${tag}`;
const U4 = `preview-sql-d-${tag}`;
const U5 = `preview-sql-e-${tag}`;
const U6 = `preview-sql-f-${tag}`;
const USERS = [U1, U2, U3, U4, U5, U6];
const H: Record<string, string> = {};
const ids: Record<string, string> = {};

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

type Row = Record<string, unknown>;
let q1: Row[] = [];
let q2: Row[] = [];
let q3: Row[] = [];

async function item(user: string, slug: string, extra: Partial<typeof plaidItemsTable.$inferInsert> = {}) {
  const [i] = await db
    .insert(plaidItemsTable)
    .values({
      userId: user,
      householdId: H[user]!,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionName: slug === "amex" ? "American Express" : "TestBank",
      institutionSlug: slug,
      ...extra,
    })
    .returning();
  return i!.id;
}

async function account(user: string, itemId: string, extra: Partial<typeof plaidAccountsTable.$inferInsert>) {
  const externalId = `acct-${randomUUID()}`;
  const [a] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: user,
      householdId: H[user]!,
      itemId,
      accountId: externalId,
      name: "Card",
      type: "credit",
      subtype: "credit card",
      ...extra,
    })
    .returning();
  return { id: a!.id, externalId };
}

async function debt(user: string, values: Partial<typeof debtsTable.$inferInsert> & { name: string }) {
  const [d] = await db
    .insert(debtsTable)
    .values({ userId: user, householdId: H[user]!, apr: "0.2000", minPayment: "25.00", ...values })
    .returning({ id: debtsTable.id });
  return d!.id;
}

async function attempt(user: string, itemId: string, success: boolean, at: Date) {
  await db.insert(plaidSyncAttemptsTable).values({
    userId: user,
    plaidItemId: itemId,
    kind: "liabilities",
    success,
    errorCode: success ? null : "INTERNAL_SERVER_ERROR",
    attemptedAt: at,
  });
}

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, USERS));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, USERS));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, USERS));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, USERS));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, USERS));
}

beforeAll(async () => {
  for (const u of USERS) H[u] = (await createTestHousehold(u)).householdId;
  await cleanup();

  // Household A: the three row lines, the entered-date flags, and a sweep candidate.
  const itemOk = await item(U1, "testbank");
  const acctA = await account(U1, itemOk, { liabilityBalance: "4812.40", liabilityLastFetchedAt: ago(HOUR) });
  await attempt(U1, itemOk, true, ago(HOUR));
  ids.A = await debt(U1, {
    name: "Visa",
    balance: "5000.00",
    balanceSource: "manual",
    lastBalanceUpdate: ago(HOUR),
    plaidAccountId: acctA.id,
  });

  const itemFail = await item(U1, "testbank");
  const acctB = await account(U1, itemFail, { liabilityBalance: "1200.00", liabilityLastFetchedAt: ago(72 * HOUR) });
  await attempt(U1, itemFail, false, ago(HOUR));
  ids.B = await debt(U1, { name: "Store card", balance: "1200.00", balanceSource: "plaid", plaidAccountId: acctB.id });

  const itemReauth = await item(U1, "testbank", { lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" });
  const acctC = await account(U1, itemReauth, { liabilityBalance: "900.00", liabilityLastFetchedAt: ago(72 * HOUR) });
  await attempt(U1, itemReauth, false, ago(HOUR));
  ids.C = await debt(U1, { name: "Gas card", balance: "900.00", balanceSource: "plaid", plaidAccountId: acctC.id });

  const itemOld = await item(U1, "testbank");
  const acctD = await account(U1, itemOld, { liabilityBalance: "300.00", liabilityLastFetchedAt: ago(72 * HOUR) });
  await attempt(U1, itemOld, true, ago(72 * HOUR));
  ids.D = await debt(U1, { name: "Loan", balance: "300.00", balanceSource: "plaid", plaidAccountId: acctD.id });

  ids.E = await debt(U1, {
    name: "Hand-edited",
    balance: "5000.00",
    balanceSource: "manual",
    lastBalanceUpdate: new Date("2026-08-01T17:00:00.000Z"),
  });
  await db.insert(debtBalanceHistoryTable).values([
    { userId: U1, householdId: H[U1]!, debtId: ids.E, recordedOn: "2026-08-01", balance: "4812.40" },
    { userId: U1, householdId: H[U1]!, debtId: ids.E, recordedOn: "2026-09-10", balance: "5000.00" },
  ]);
  ids.F = await debt(U1, { name: "Undated", balance: "250.00", balanceSource: "manual", lastBalanceUpdate: null });

  const itemAmex = await item(U1, "amex");
  const sky = await account(U1, itemAmex, {
    name: "Sky Card",
    mask: "1001",
    liabilityKind: "credit",
    liabilityBalance: "10512.33",
    liabilityApr: "0.2499",
    liabilityMinPayment: "315.00",
    liabilityDueDay: 15,
    liabilityLastFetchedAt: ago(HOUR),
  });
  ids.skyAccount = sky.id;
  ids.sweepDebt = await debt(U1, { name: "American Express ••1001", balance: "10000.00", balanceSource: "manual" });

  // Household B: Amex rows, an Amex item, no debt, no anchor → "Calculated" today.
  const itemB = await item(U2, "amex");
  const cardB = await account(U2, itemB, { name: "Amex Gold", liabilityBalance: null });
  for (const [day, amt] of [["2026-09-03", "100.00"], ["2026-09-05", "50.00"]] as const) {
    await db.insert(transactionsTable).values({
      userId: U2,
      householdId: H[U2]!,
      occurredOn: day,
      description: "Amex charge",
      amount: amt,
      source: "plaid:amex",
      plaidAccountId: cardB.externalId,
    });
  }

  // Household C: a debt-row answer whose date the refreshed anchor used to advance.
  const itemC = await item(U3, "amex");
  const cardC = await account(U3, itemC, { name: "Amex Gold", liabilityBalance: null });
  await debt(U3, {
    name: "American Express",
    balance: "1000.00",
    lastBalanceUpdate: new Date("2026-09-01T17:00:00.000Z"),
    updatedAt: new Date("2026-09-10T15:00:00.000Z"),
  });
  await db.insert(transactionsTable).values({
    userId: U3,
    householdId: H[U3]!,
    occurredOn: "2026-09-03",
    description: "Amex charge",
    amount: "100.00",
    source: "plaid:amex",
    plaidAccountId: cardC.externalId,
  });
  await db.insert(settingsTable).values({
    userId: U3,
    householdId: H[U3]!,
    preferences: { amexAnchor: { balance: 1000, asOf: "2026-09-11T05:00:00.000Z", lastAutoBalance: 1000 } },
  });

  // Household D (review H3): a legacy debt created Jun 1 with no balance date,
  // typed to $1,000 on Sep 1 by the old PATCH (its first history row, and
  // updated_at, that day). No Plaid, so the page answers from the debt row.
  const legacyDebt = await debt(U4, {
    name: "American Express",
    balance: "1000.00",
    lastBalanceUpdate: null,
    createdAt: new Date("2026-06-01T17:00:00.000Z"),
    updatedAt: new Date("2026-09-01T17:00:00.000Z"),
  });

  // Household E (round 5 known residual): created Jun 1 and never edited; its
  // first history row is a Jun 15 page view. The rule's first row always
  // counts as a change, so this dates the debt Jun 15 — dropping the Jun 10
  // charge before it. Bounded, and documented as the one known residual of
  // reverting the round-4 updated_at-gated rule.
  const viewedDebt = await debt(U5, {
    name: "American Express",
    balance: "1000.00",
    lastBalanceUpdate: null,
    createdAt: new Date("2026-06-01T17:00:00.000Z"),
    updatedAt: new Date("2026-06-01T17:00:00.000Z"),
  });
  await db.insert(debtBalanceHistoryTable).values([
    { userId: U5, householdId: H[U5]!, debtId: viewedDebt, recordedOn: "2026-06-15", balance: "1000.00" },
    { userId: U5, householdId: H[U5]!, debtId: viewedDebt, recordedOn: "2026-09-09", balance: "1000.00" },
  ]);
  await db.insert(transactionsTable).values({
    userId: U5,
    householdId: H[U5]!,
    occurredOn: "2026-06-10",
    description: "Amex charge",
    amount: "200.00",
    source: "amex",
  });

  // Household F (round 5 drift fix): a legacy raise on Sep 1 (its only
  // history row), then a later unrelated PATCH (an APR/name/min edit, or a
  // Plaid refresh) moves updated_at to Sep 10. Round 4's rule un-matched the
  // first row against the now-later updated_at and fell back to created_at
  // (Jun 1) — unbounded. Round 5's rule (the first row always counts) still
  // dates this Sep 1 regardless of the later edit.
  const driftDebt = await debt(U6, {
    name: "American Express",
    balance: "1000.00",
    lastBalanceUpdate: null,
    createdAt: new Date("2026-06-01T17:00:00.000Z"),
    updatedAt: new Date("2026-09-10T15:00:00.000Z"),
  });
  await db.insert(debtBalanceHistoryTable).values({
    userId: U6,
    householdId: H[U6]!,
    debtId: driftDebt,
    recordedOn: "2026-09-01",
    balance: "1000.00",
  });

  await db.insert(debtBalanceHistoryTable).values({
    userId: U4,
    householdId: H[U4]!,
    debtId: legacyDebt,
    recordedOn: "2026-09-01",
    balance: "1000.00",
  });
  for (const [day, amt] of [
    ["2026-06-10", "200.00"],
    ["2026-07-10", "300.00"],
    ["2026-08-10", "400.00"],
    ["2026-09-05", "50.00"],
  ] as const) {
    await db.insert(transactionsTable).values({
      userId: U4,
      householdId: H[U4]!,
      occurredOn: day,
      description: "Amex charge",
      amount: amt,
      source: "amex",
    });
  }

  const client = await pool.connect();
  try {
    const results = (await client.query(readFileSync(SQL_PATH, "utf8"))) as unknown as QueryResult[];
    const selects = results.filter((r) => r.command === "SELECT");
    expect(selects).toHaveLength(3);
    [q1, q2, q3] = selects.map((r) => r.rows as Row[]) as [Row[], Row[], Row[]];
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});

afterAll(cleanup);

const debtRow = (id: string) => q1.find((r) => r.debt_id === id)!;
const householdRow = (user: string) => q2.find((r) => r.household_id === H[user])!;

describe("(PR-E review M1) preview-debt-balance-provenance.sql", () => {
  it("flags the three row lines the page will show, honouring the reconnect banner", () => {
    expect(debtRow(ids.A!)).toMatchObject({
      shows_use_bank_balance: true,
      shows_refresh_failed: false,
      shows_bank_balance_old: false,
    });
    expect(debtRow(ids.B!)).toMatchObject({
      shows_use_bank_balance: false,
      shows_refresh_failed: true,
      shows_bank_balance_old: false,
    });
    expect(debtRow(ids.C!)).toMatchObject({
      reconnect_banner_covers: true,
      shows_refresh_failed: false,
      shows_bank_balance_old: false,
    });
    expect(debtRow(ids.D!)).toMatchObject({ shows_refresh_failed: false, shows_bank_balance_old: true });
  });

  it("flags kept balances whose date is unknown or behind their last balance change (the hand-edit symptom)", () => {
    expect(debtRow(ids.E!)).toMatchObject({
      entered_date_unknown: false,
      entered_date_behind_balance_change: true,
    });
    expect(debtRow(ids.F!)).toMatchObject({ entered_date_unknown: true });
    expect(debtRow(ids.A!)).toMatchObject({
      entered_date_unknown: false,
      entered_date_behind_balance_change: false,
    });
    expect(debtRow(ids.sweepDebt!).old_amex_updater_name_match).toBe(true);
  });

  it("says which Amex source the page uses today and after the merge, with its label and the debt-row date", () => {
    expect(householdRow(U1)).toMatchObject({
      source_today: "plaid",
      source_after_merge: "plaid",
      anchor_after_merge: "no Amex rows: the refresh writes nothing",
    });
    expect(householdRow(U2)).toMatchObject({
      source_today: "computed",
      page_label_today: "Calculated",
      source_after_merge: "anchor",
      page_label_after_merge: "From saved anchor",
      anchor_after_merge: "none: the next Amex sync writes balance + estimate",
    });
    const c = householdRow(U3);
    expect(c).toMatchObject({
      source_today: "debt",
      source_after_merge: "debt",
      anchor_after_merge: "refresh-written: the refresh keeps moving it",
    });
    expect((c.debt_tier_as_of_today as Date).toISOString()).toBe("2026-09-11T05:00:00.000Z");
    expect((c.debt_tier_as_of_after_merge as Date).toISOString()).toBe("2026-09-01T17:00:00.000Z");
    // The date moves earlier; the Sep 3 $100 row now counts.
    expect(c).toMatchObject({
      debt_tier_date_move: "earlier",
      debt_tier_date_move_risk: "counted twice if the balance already held these rows",
      amex_rows_between_dates: "100.00",
      page_total_change: "100.00",
    });
  });

  it("(review H3) dates a legacy debt by the day its balance last changed, and prices the move", () => {
    const d = householdRow(U4);
    expect(d).toMatchObject({ source_today: "debt", source_after_merge: "debt" });
    // Today: updated_at Sep 1. After: the Sep 1 history change, not Jun 1.
    expect((d.debt_tier_as_of_today as Date).toISOString()).toBe("2026-09-01T17:00:00.000Z");
    expect((d.debt_tier_as_of_after_merge as Date).toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect(d).toMatchObject({ debt_tier_date_move: "same day", page_total_change: null });
    expect(householdRow(U1).debt_tier_date_move).toBeNull();
  });

  it("(round 5 known residual) dates a never-edited debt by its first page-view history row", () => {
    const e = householdRow(U5);
    expect(e).toMatchObject({ source_today: "debt", source_after_merge: "debt" });
    // Today: updated_at Jun 1 (never edited). After: the first history row,
    // Jun 15 — the documented bounded residual, not the "true" Jun 1.
    expect((e.debt_tier_as_of_today as Date).toISOString()).toBe("2026-06-01T17:00:00.000Z");
    expect((e.debt_tier_as_of_after_merge as Date).toISOString()).toBe("2026-06-15T12:00:00.000Z");
    expect(e.debt_tier_date_move).toBe("later");
  });

  it("(round 5 drift fix) a legacy raise's date survives a later unrelated edit to updated_at", () => {
    const f = householdRow(U6);
    expect(f).toMatchObject({ source_today: "debt", source_after_merge: "debt" });
    // Today: updated_at Sep 10 (the later unrelated edit). After: still the
    // Sep 1 balance change — unmoved by that edit.
    expect((f.debt_tier_as_of_today as Date).toISOString()).toBe("2026-09-10T15:00:00.000Z");
    expect((f.debt_tier_as_of_after_merge as Date).toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect(f.debt_tier_date_move).toBe("earlier");
  });

  it("lists the Amex cards the automatic sweep will link to a same-name manual debt", () => {
    const mine = q3.filter((r) => r.household_id === H[U1]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      plaid_account_uuid: ids.skyAccount,
      debt_id: ids.sweepDebt,
      debt_name: "American Express ••1001",
      entered_balance: "10000.00",
      bank_balance: "10512.33",
    });
  });
});
