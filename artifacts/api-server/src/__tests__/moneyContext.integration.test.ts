// (PR-H) `loadMoneyContext` — the shared server read for the household money
// model. Load-bearing for PR8r/PR10:
//   - `weeklyAllowanceOverrides` read SERVER-SIDE for the first time (today
//     only the web app reads them, straight off `useSettings()`);
//   - confirmed bill matches bounded to a date range, by the MATCHED
//     TRANSACTION's own date, not the bill's `occurrence_date`.
// Round 2:
//   - review L1: categories in the shape `classifyMovement` needs, the settings
//     row read once, pre-read pending pairs accepted;
//   - review L2: every field checked against real rows (checking account,
//     Amex cadence, pending pairs) and scoped to ONE household, two households
//     side by side;
//   - review M2: a match confirmed on a pending row carries to its posted row.

import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";

vi.mock("../lib/amexCardCadence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/amexCardCadence")>();
  return { ...actual, discoverAmexCards: vi.fn(actual.discoverAmexCards) };
});

import {
  db,
  budgetCategoriesTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { classifyMovement, everydayPlan } from "@workspace/avalanche-core";
import { discoverAmexCards } from "../lib/amexCardCadence";
import { loadMoneyContext } from "../lib/moneyContext";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const TEST_USER = `pr-h-money-context-${RUN}`;
const LINKED_USER = `pr-h-money-context-linked-${RUN}`;
const OTHER_USER = `pr-h-money-context-other-${RUN}`;
const USERS = [TEST_USER, LINKED_USER, OTHER_USER];
let TEST_HOUSEHOLD_ID: string;
let LINKED_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

const SEPT = { start: "2026-09-01", end: "2026-09-30" };
const OCT = { start: "2026-10-01", end: "2026-10-31" };
const NOV = { start: "2026-11-01", end: "2026-11-30" };

let DEBT_ID: string;
let DEBT_CAT: string;
let INCOME_CAT: string;
let UNCATEGORIZED_CAT: string;
let OTHER_CAT: string;

const LINKED_CHECKING = `acct-checking-${randomUUID()}`;
const LINKED_BLUE = `acct-blue-${randomUUID()}`;
const LINKED_PLATINUM = `acct-platinum-${randomUUID()}`;
const LINKED_PLATINUM_MONTHLY = `acct-platinum-monthly-${randomUUID()}`;
const LINKED_PREFS = { amexCardCadence: { [LINKED_PLATINUM_MONTHLY]: "monthly" } };

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  LINKED_HOUSEHOLD_ID = (await createTestHousehold(LINKED_USER)).householdId;
  OTHER_HOUSEHOLD_ID = (await createTestHousehold(OTHER_USER)).householdId;

  await db.insert(settingsTable).values([
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      weeklyAllowanceAmount: "150.00",
      monthlyAllowanceAmount: "400.00",
      unplannedAllowanceAmount: "75.00",
      preferences: { weeklyAllowanceOverrides: { "2026-09-06": "200.00" } },
    },
    { userId: LINKED_USER, householdId: LINKED_HOUSEHOLD_ID, preferences: LINKED_PREFS },
    {
      userId: OTHER_USER,
      householdId: OTHER_HOUSEHOLD_ID,
      weeklyAllowanceAmount: "999.00",
      monthlyAllowanceAmount: "888.00",
      unplannedAllowanceAmount: "777.00",
      preferences: { weeklyAllowanceOverrides: { "2026-09-06": "1.00" } },
    },
  ]);

  const [debt] = await db
    .insert(debtsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Test Card" })
    .returning({ id: debtsTable.id });
  DEBT_ID = debt!.id;
  const cats = await db
    .insert(budgetCategoriesTable)
    .values([
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Card Payoff", kind: "expense", debtId: DEBT_ID },
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Paycheck", kind: "income" },
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Uncategorized", kind: "expense" },
      { userId: OTHER_USER, householdId: OTHER_HOUSEHOLD_ID, name: "Groceries", kind: "expense" },
    ])
    .returning({ id: budgetCategoriesTable.id });
  [DEBT_CAT, INCOME_CAT, UNCATEGORIZED_CAT, OTHER_CAT] = cats.map((c) => c.id) as [string, string, string, string];

  // The linked household: a checking account the bank snapshot points at, and
  // an Amex login with three cards.
  const [chase] = await db
    .insert(plaidItemsTable)
    .values({ userId: LINKED_USER, householdId: LINKED_HOUSEHOLD_ID, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning({ id: plaidItemsTable.id });
  const [amex] = await db
    .insert(plaidItemsTable)
    .values({ userId: LINKED_USER, householdId: LINKED_HOUSEHOLD_ID, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "amex" })
    .returning({ id: plaidItemsTable.id });
  const accounts = await db
    .insert(plaidAccountsTable)
    .values([
      { userId: LINKED_USER, householdId: LINKED_HOUSEHOLD_ID, itemId: chase!.id, accountId: LINKED_CHECKING, name: "Checking", mask: "3001", type: "depository", subtype: "checking" },
      { userId: LINKED_USER, householdId: LINKED_HOUSEHOLD_ID, itemId: amex!.id, accountId: LINKED_BLUE, name: "Blue Cash Everyday", mask: "3002", type: "credit", subtype: "credit card" },
      { userId: LINKED_USER, householdId: LINKED_HOUSEHOLD_ID, itemId: amex!.id, accountId: LINKED_PLATINUM, name: "Platinum Card", mask: "3003", type: "credit", subtype: "credit card" },
      { userId: LINKED_USER, householdId: LINKED_HOUSEHOLD_ID, itemId: amex!.id, accountId: LINKED_PLATINUM_MONTHLY, name: "Platinum Card", mask: "3004", type: "credit", subtype: "credit card" },
    ])
    .returning({ id: plaidAccountsTable.id, accountId: plaidAccountsTable.accountId });
  await db.insert(forecastSettingsTable).values({
    userId: LINKED_USER,
    householdId: LINKED_HOUSEHOLD_ID,
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: new Date("2026-09-01T12:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: accounts.find((a) => a.accountId === LINKED_CHECKING)!.id,
  });
});

afterAll(async () => {
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, USERS));
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.userId, USERS));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, USERS));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, USERS));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, USERS));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, USERS));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, USERS));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, USERS));
});

async function insertTxn(
  userId: string,
  householdId: string,
  values: Partial<typeof transactionsTable.$inferInsert> & { occurredOn: string },
): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({ userId, householdId, description: "GENERIC CHARGE", amount: "-10.00", ...values })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

async function resolve(
  userId: string,
  householdId: string,
  matchedTxnId: string,
  status = "matched",
  occurrenceDate = "2026-09-01",
): Promise<void> {
  await db.insert(forecastResolutionsTable).values({
    userId,
    householdId,
    recurringItemId: `rec-${randomUUID().slice(0, 8)}`,
    occurrenceDate,
    status,
    matchedTxnId,
  });
}

describe("loadMoneyContext — settings and weeklyAllowanceOverrides", () => {
  it("reads the standing amounts and the overrides map", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT);
    expect(ctx.settings.weeklyAllowanceAmount).toBe("150.00");
    expect(ctx.settings.monthlyAllowanceAmount).toBe("400.00");
    expect(ctx.settings.unplannedAllowanceAmount).toBe("75.00");
    expect(ctx.settings.weeklyAllowanceOverrides).toEqual({ "2026-09-06": "200.00" });
  });

  it("an override for the week changes everydayPlan; a week without one uses the default", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT);

    // 2026-09-06 (Sunday) has an override.
    const overriddenWeek = everydayPlan("2026-09-06", ctx.settings, ctx.settings.weeklyAllowanceOverrides);
    expect(overriddenWeek.weeklyCents).toBe(20000);

    // 2026-08-30 (Sunday, no override) falls back to the standing amount.
    const plainWeek = everydayPlan("2026-08-30", ctx.settings, ctx.settings.weeklyAllowanceOverrides);
    expect(plainWeek.weeklyCents).toBe(15000);

    // Monthly is never overridden.
    expect(overriddenWeek.monthlyCents).toBe(40000);
    expect(plainWeek.monthlyCents).toBe(40000);
  });
});

describe("loadMoneyContext — confirmed bill matches, bounded to the range", () => {
  it("includes a matched transaction dated in range, by its OWN date", async () => {
    const txn = await insertTxn(TEST_USER, TEST_HOUSEHOLD_ID, {
      occurredOn: "2026-09-15",
      description: "AUTO INSURANCE CO",
      amount: "-120.00",
    });
    // The bill's own occurrence date is OUTSIDE the range queried below —
    // matchedTxnIds must still find it, because it bounds by the matched
    // transaction's date, not this one.
    await resolve(TEST_USER, TEST_HOUSEHOLD_ID, txn, "matched", "2026-08-01");

    expect((await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT)).matchedTxnIds.has(txn)).toBe(true);
    expect((await loadMoneyContext(TEST_HOUSEHOLD_ID, OCT)).matchedTxnIds.has(txn)).toBe(false);
  });

  it("excludes a resolution that is not matched or partial", async () => {
    const txn = await insertTxn(TEST_USER, TEST_HOUSEHOLD_ID, { occurredOn: "2026-09-20", amount: "-40.00" });
    await resolve(TEST_USER, TEST_HOUSEHOLD_ID, txn, "skipped", "2026-09-20");
    expect((await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT)).matchedTxnIds.has(txn)).toBe(false);
  });

  it("a 'partial' match counts the same as 'matched'", async () => {
    const txn = await insertTxn(TEST_USER, TEST_HOUSEHOLD_ID, {
      occurredOn: "2026-09-22",
      description: "PARTIAL PAYMENT",
      amount: "-30.00",
    });
    await resolve(TEST_USER, TEST_HOUSEHOLD_ID, txn, "partial", "2026-09-22");
    expect((await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT)).matchedTxnIds.has(txn)).toBe(true);
  });

  it("a matched transaction dated in the days read before the range, with no pair, is not in the range's set", async () => {
    const txn = await insertTxn(TEST_USER, TEST_HOUSEHOLD_ID, { occurredOn: "2026-10-28", amount: "-15.00" });
    await resolve(TEST_USER, TEST_HOUSEHOLD_ID, txn, "matched", "2026-10-28");
    expect((await loadMoneyContext(TEST_HOUSEHOLD_ID, NOV)).matchedTxnIds.has(txn)).toBe(false);
    expect((await loadMoneyContext(TEST_HOUSEHOLD_ID, OCT)).matchedTxnIds.has(txn)).toBe(true);
  });
});

describe("loadMoneyContext — pending pairs, and a match carried across them (review L2, M2)", () => {
  let PENDING: string;
  let POSTED: string;

  beforeAll(async () => {
    const account = `acct-card-${randomUUID()}`;
    const base = { plaidAccountId: account, source: "plaid", description: "CITY POWER CO" };
    PENDING = await insertTxn(TEST_USER, TEST_HOUSEHOLD_ID, {
      ...base,
      occurredOn: "2026-09-29",
      createdAt: new Date(createdAtStartOfHouseholdDay("2026-09-29").getTime() + 3_600_000),
      amount: "-40.00",
      pending: true,
    });
    POSTED = await insertTxn(TEST_USER, TEST_HOUSEHOLD_ID, {
      ...base,
      occurredOn: "2026-10-02",
      createdAt: new Date(createdAtStartOfHouseholdDay("2026-10-02").getTime() + 3_600_000),
      amount: "-48.00",
      pending: false,
    });
    await resolve(TEST_USER, TEST_HOUSEHOLD_ID, PENDING, "matched", "2026-09-29");
  });

  it("the loader's own read finds the pair: replaced in September, replacing in October", async () => {
    const sept = await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT);
    expect(sept.supersede.replacedIds.has(PENDING)).toBe(true);
    const oct = await loadMoneyContext(TEST_HOUSEHOLD_ID, OCT);
    expect(oct.supersede.replacedBy.get(POSTED)?.id).toBe(PENDING);
  });

  it("a match confirmed on the pending row carries to the posted row, though the pending row is dated before the range", async () => {
    const oct = await loadMoneyContext(TEST_HOUSEHOLD_ID, OCT);
    expect(oct.matchedTxnIds.has(POSTED)).toBe(true);
    expect(oct.matchedTxnIds.has(PENDING)).toBe(false);
    // September: the pending row is in range and matched; its posted row is not in range.
    const sept = await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT);
    expect(sept.matchedTxnIds.has(PENDING)).toBe(true);
    expect(sept.matchedTxnIds.has(POSTED)).toBe(false);
  });

  it("pre-read pairs are used exactly as handed in (the spine's shape)", async () => {
    const pre = { replacedIds: new Set(["pre-read"]), replacedBy: new Map() };
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, OCT, { supersede: pre });
    expect(ctx.supersede).toBe(pre);
    // No pair handed in, so nothing to carry.
    expect(ctx.matchedTxnIds.has(POSTED)).toBe(false);
  });
});

describe("loadMoneyContext — categories, in the shape classifyMovement reads (review L1)", () => {
  it("categoriesById carries name, debt link and kind; debtCategoryIds and the uncategorized ids follow", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT);
    expect(ctx.categoriesById.get(DEBT_CAT)).toEqual({ name: "Card Payoff", debtId: DEBT_ID, kind: "expense" });
    expect(ctx.categoriesById.get(INCOME_CAT)).toEqual({ name: "Paycheck", debtId: null, kind: "income" });
    expect([...ctx.debtCategoryIds]).toEqual([DEBT_CAT]);
    expect([...ctx.filingCtx.uncategorizedIds]).toEqual([UNCATEGORIZED_CAT]);
    expect(ctx.tier2PairedTxnIds.size).toBe(0);
  });

  it("the context IS a MovementContext: classifyMovement reads a debt-linked category through it", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT);
    const c = classifyMovement(
      {
        id: "x",
        occurredOn: "2026-09-03",
        amount: "-80.00",
        source: "manual",
        isTransfer: false,
        categoryId: DEBT_CAT,
        description: "CARD PAYOFF",
        debtId: null,
        isExternalCardPayment: false,
        reimbursable: false,
        pfcDetailed: null,
        plaidAccountId: null,
        unplannedAllowance: false,
        monthlyAllowance: false,
        weeklyAllowance: true,
      },
      ctx,
    );
    expect(c.coverage).toBe("debt_payment");
  });
});

describe("loadMoneyContext — a household with linked accounts (review L2)", () => {
  it("resolves the tracked checking account's external id", async () => {
    const ctx = await loadMoneyContext(LINKED_HOUSEHOLD_ID, SEPT);
    expect(ctx.checkingAccountExternalId).toBe(LINKED_CHECKING);
  });

  it("maps every discovered Amex card to its cadence, honouring the owner's override", async () => {
    const ctx = await loadMoneyContext(LINKED_HOUSEHOLD_ID, SEPT);
    expect(Object.fromEntries(ctx.amexCardCadence)).toEqual({
      [LINKED_BLUE]: "monthly",
      [LINKED_PLATINUM]: "weekly",
      [LINKED_PLATINUM_MONTHLY]: "monthly",
    });
  });

  it("reads the owner's settings row once: its preferences are handed to discoverAmexCards (review L1)", async () => {
    vi.mocked(discoverAmexCards).mockClear();
    await loadMoneyContext(LINKED_HOUSEHOLD_ID, SEPT);
    expect(vi.mocked(discoverAmexCards).mock.calls).toEqual([
      [LINKED_HOUSEHOLD_ID, LINKED_USER, { preferences: LINKED_PREFS }],
    ]);
  });
});

describe("loadMoneyContext — one household only (review L2)", () => {
  let OTHER_MATCHED: string;
  let THIS_ROW_OTHER_RESOLUTION: string;
  let OTHER_ROW_THIS_RESOLUTION: string;

  beforeAll(async () => {
    // The other household's own confirmed match.
    OTHER_MATCHED = await insertTxn(OTHER_USER, OTHER_HOUSEHOLD_ID, { occurredOn: "2026-09-12", amount: "-61.00" });
    await resolve(OTHER_USER, OTHER_HOUSEHOLD_ID, OTHER_MATCHED);
    // A resolution filed under the OTHER household that names THIS household's row.
    THIS_ROW_OTHER_RESOLUTION = await insertTxn(TEST_USER, TEST_HOUSEHOLD_ID, { occurredOn: "2026-09-13", amount: "-62.00" });
    await resolve(OTHER_USER, OTHER_HOUSEHOLD_ID, THIS_ROW_OTHER_RESOLUTION);
    // A resolution filed under THIS household that names the OTHER household's row.
    OTHER_ROW_THIS_RESOLUTION = await insertTxn(OTHER_USER, OTHER_HOUSEHOLD_ID, { occurredOn: "2026-09-14", amount: "-63.00" });
    await resolve(TEST_USER, TEST_HOUSEHOLD_ID, OTHER_ROW_THIS_RESOLUTION);
  });

  it("another household's settings, categories and matches never reach this household's context", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT);
    expect(ctx.settings.weeklyAllowanceAmount).toBe("150.00");
    expect(ctx.categoriesById.has(OTHER_CAT)).toBe(false);
    expect(ctx.matchedTxnIds.has(OTHER_MATCHED)).toBe(false);

    const other = await loadMoneyContext(OTHER_HOUSEHOLD_ID, SEPT);
    expect(other.settings.weeklyAllowanceAmount).toBe("999.00");
    expect(other.settings.weeklyAllowanceOverrides).toEqual({ "2026-09-06": "1.00" });
    expect([...other.categoriesById.keys()]).toEqual([OTHER_CAT]);
    expect(other.matchedTxnIds.has(OTHER_MATCHED)).toBe(true);
  });

  it("a resolution filed under another household never marks this household's row matched", async () => {
    expect((await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT)).matchedTxnIds.has(THIS_ROW_OTHER_RESOLUTION)).toBe(false);
  });

  it("a resolution in this household that names another household's row is ignored — on both sides", async () => {
    expect((await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT)).matchedTxnIds.has(OTHER_ROW_THIS_RESOLUTION)).toBe(false);
    expect((await loadMoneyContext(OTHER_HOUSEHOLD_ID, SEPT)).matchedTxnIds.has(OTHER_ROW_THIS_RESOLUTION)).toBe(false);
  });
});

describe("loadMoneyContext — shape", () => {
  it("resolves to no checking account and an empty Amex cadence map for a household with no linked Plaid accounts", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, SEPT);
    expect(ctx.checkingAccountExternalId).toBeNull();
    expect(ctx.amexCardCadence.size).toBe(0);
  });
});
