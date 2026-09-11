import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { LedgerPage } from "@workspace/api-client-react";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #453 (the rendered-page guarantee for #448),
 * rewritten for PR14: the Chase page (`/transactions`) reads the server's
 * paginated ledger (GET /api/transactions/ledger) instead of pulling
 * GET /api/transactions and scoping rows in the browser.
 *
 * The guarantee is unchanged: Amex rows (and other cards' rows) never reach the
 * Chase page, neither the list nor the Money in / Money out figures. The scope
 * is now the server's (PR13 `isBankRow`): the snapshot account's rows, its mask
 * twins' rows, and manual rows (no Plaid account, source neither `amex` nor
 * `plaid:*`). So the rows go through the real ledger code: no network mocks.
 *
 * Two tests:
 *   1. A linked Chase checking account with a bank snapshot. Seeded in last
 *      month (every day before the household's today): a Plaid deposit on the
 *      checking account, a "chase"-sourced manual import and a manual cash row
 *      (the Chase rows), plus an Amex-sourced manual row, a row on the linked
 *      Amex card account, a `plaid:amex` row with no account and a
 *      `plaid:capitalone` row with no account (the rows that must stay off).
 *      Asserts every Chase row renders, every other row is absent, the ledger
 *      totals and the Money in vs out card equal the Chase rows only, and the
 *      balance card's Start is End less the Chase rows' net.
 *   2. No Plaid checking linked at all (the #448 source fallback): the same
 *      shape with the Chase rows as manual imports. Asserts the same rows
 *      render and the ledger's totals exclude the Amex / debt rows. (With no
 *      linked checking the page shows no Money in vs out card, so the totals
 *      are read from the ledger response the page rendered.)
 *
 * The amounts make the regression loud: Chase rows only give Money in $200.00
 * and Money out $40.00; sweeping in the Amex / debt rows gives Money out
 * $202.00.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, userId));
      await db
        .delete(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, userId));
      await db
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, userId));
      await db
        .delete(plaidItemsTable)
        .where(eq(plaidItemsTable.userId, userId));
    } catch {
      // best-effort
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

const HOUSEHOLD_TZ = "America/Chicago";

/** The calendar day of an instant in the household's zone, YYYY-MM-DD. */
function householdDateOf(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HOUSEHOLD_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => {
    const v = parts.find((p) => p.type === type)?.value;
    if (!v) throw new Error(`Intl gave no ${type} for ${d.toISOString()}`);
    return v;
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The first day of the month before the household's current month. */
function previousMonthStart(today: string): string {
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  return new Date(Date.UTC(y, m0 - 1, 1)).toISOString().slice(0, 10);
}

/** Integer cents from a server money string ("5000.00", "-12.34"). */
function parseCents(raw: string | null | undefined): number {
  if (raw == null) throw new Error("expected a money string, got null");
  const m = raw.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`could not parse money: "${raw}"`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

/** Cents as the page renders money (`formatCurrency`): "$1,234.56", "-$12.34". */
function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
}

/** A signed figure as `MoneyText signed` renders it: "+$160.00", "-$4.50", "$0.00". */
function signedUsd(cents: number): string {
  return cents > 0 ? `+${usd(cents)}` : usd(cents);
}

/** The register's first page for a month, on the default (snapshot) account. */
function isRegisterLedger(from: string) {
  return (res: Response): boolean => {
    if (res.request().method() !== "GET") return false;
    const u = new URL(res.url());
    if (!u.pathname.endsWith("/api/transactions/ledger")) return false;
    if (u.searchParams.get("from") !== from) return false;
    if (u.searchParams.has("pending")) return false;
    if (u.searchParams.has("account")) return false;
    return !u.searchParams.has("cursor");
  };
}

async function readLedger(res: Response): Promise<LedgerPage> {
  expect(res.status(), `ledger request failed: ${res.url()}`).toBe(200);
  return (await res.json()) as LedgerPage;
}

/** A legend row of the Money in vs out card ("In" / "Out"). */
function legendRow(card: Locator, label: "In" | "Out" | "Net"): Locator {
  return card.getByText(label, { exact: true }).locator("xpath=..");
}

async function openMonth(page: Page, email: string, password: string, monthStart: string) {
  const firstPagePromise = page.waitForResponse(isRegisterLedger(monthStart), {
    timeout: 90_000,
  });
  await signInAndOpen(page, email, password, `/transactions?month=${monthStart}`);
  await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
    timeout: 15_000,
  });
  return readLedger(await firstPagePromise);
}

const CHASE_IN_CENTS = 20_000; // $200.00
const CHASE_OUT_CENTS = 4_000; // $30.00 + $10.00
const SWEPT_OUT_CENTS = 20_200; // + $50.00 + $70.00 + $17.00 + $25.00

test.describe("Chase Transactions page — Amex/debt rows stay off the page (#453, covers #448, PR14 ledger)", () => {
  test("with a linked Chase checking account, only its rows + manual rows reach the list, the ledger totals and the Money in vs out card", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { userId, email, password } = await createTestUser(
      "txn-chase-hides-amex",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const suffix = Math.random().toString(36).slice(2, 8);
    const today = householdDateOf(new Date());
    const monthStart = previousMonthStart(today);
    const day = `${monthStart.slice(0, 8)}10`;

    // --- One Chase checking account (the snapshot's) and one Amex card.
    const [chaseItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `e2e-chase-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [checking] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: chaseItem!.id,
        accountId: `e2e-chase-acct-${suffix}`,
        name: "Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    const [amexItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `e2e-amex-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    const [amexCard] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: amexItem!.id,
        accountId: `e2e-amex-acct-${suffix}`,
        name: "Platinum Card",
        mask: "1009",
        type: "credit",
        subtype: "credit card",
      })
      .returning();

    const at = (hour: number) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
    const chaseRows = await db
      .insert(transactionsTable)
      .values([
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(14),
          description: `E2E-${suffix} CHASE PAYROLL`,
          amount: "200.00",
          account: checking!.name,
          source: "plaid:chase",
          plaidTransactionId: `e2e-${suffix}-chase-in`,
          plaidAccountId: checking!.accountId,
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(15),
          description: `E2E-${suffix} CHASE GROCERIES`,
          amount: "-30.00",
          account: "Chase",
          source: "chase",
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(16),
          description: `E2E-${suffix} MANUAL CASH`,
          amount: "-10.00",
          account: "Cash",
          source: "manual",
        },
      ])
      .returning({ id: transactionsTable.id });
    const offRows = await db
      .insert(transactionsTable)
      .values([
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(17),
          description: `E2E-${suffix} AMEX RESTAURANT`,
          amount: "-50.00",
          account: "amex",
          source: "amex",
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(18),
          description: `E2E-${suffix} PLAID AMEX TRAVEL`,
          amount: "-70.00",
          account: amexCard!.name,
          source: "plaid:amex",
          plaidTransactionId: `e2e-${suffix}-amex-card`,
          plaidAccountId: amexCard!.accountId,
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(19),
          description: `E2E-${suffix} PLAID AMEX NO ACCOUNT`,
          amount: "-17.00",
          account: "amex",
          source: "plaid:amex",
          plaidTransactionId: `e2e-${suffix}-amex-orphan`,
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(20),
          description: `E2E-${suffix} CAPITAL ONE DEBT`,
          amount: "-25.00",
          account: "capitalone",
          source: "plaid:capitalone",
          plaidTransactionId: `e2e-${suffix}-capone-out`,
        },
        // (PR14 second review N3) The original fixture's `plaid:chase` row with no
        // account. With a linked account the old page listed no account-less rows
        // either; PR13's server rule leaves it out, as the bank balance does.
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(21),
          description: `E2E-${suffix} PLAID CHASE NO ACCOUNT`,
          amount: "-33.00",
          account: "chase",
          source: "plaid:chase",
          plaidTransactionId: `e2e-${suffix}-chase-orphan`,
        },
      ])
      .returning({ id: transactionsTable.id, description: transactionsTable.description });

    // The bank snapshot, read now: every seeded row happened before it.
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "2500.00",
      bankSnapshotAt: new Date(),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: checking!.id,
      bankSnapshotName: checking!.name,
      bankSnapshotMask: checking!.mask,
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    const ledger = await openMonth(page, email, password, monthStart);

    // --- The server's scope, before any DOM check.
    const chaseIds = chaseRows.map((r) => r.id);
    const offIds = offRows.map((r) => r.id);
    expect(new Set(ledger.rows.map((r) => r.id))).toEqual(new Set(chaseIds));
    expect(ledger.matchingCount).toBe(chaseIds.length);
    expect(parseCents(ledger.totals.moneyIn)).toBe(CHASE_IN_CENTS);
    expect(parseCents(ledger.totals.moneyOut)).toBe(CHASE_OUT_CENTS);
    expect(parseCents(ledger.totals.net)).toBe(CHASE_IN_CENTS - CHASE_OUT_CENTS);
    for (const r of ledger.rows) expect(r.countsInBalance).toBe(true);

    await expect(page.getByTestId("chase-showing")).toHaveText(
      `Showing 3 of 3 · 3 to review`,
      { timeout: 20_000 },
    );

    // --- (1) Every Chase + manual row renders; no Amex / debt row does.
    for (const id of chaseIds) {
      await expect(page.getByTestId(`row-tx-${id}`)).toBeVisible({ timeout: 15_000 });
    }
    for (const id of offIds) {
      await expect(page.getByTestId(`row-tx-${id}`)).toHaveCount(0);
    }
    // (2) Belt and braces: their descriptions appear nowhere on the page.
    for (const r of offRows) {
      await expect(page.getByText(r.description)).toHaveCount(0);
    }
    await expect(page.locator('[data-testid^="row-tx-"]')).toHaveCount(chaseIds.length);

    // --- (3) The Money in vs out card: Chase rows only. Sweeping the Amex /
    // debt rows in would read Money out $202.00.
    const inOut = page.getByTestId("chase-stats-in-out");
    await expect(legendRow(inOut, "In")).toContainText(usd(CHASE_IN_CENTS), {
      timeout: 15_000,
    });
    await expect(legendRow(inOut, "Out")).toContainText(usd(CHASE_OUT_CENTS));
    await expect(legendRow(inOut, "Out")).not.toContainText(usd(SWEPT_OUT_CENTS));
    await expect(legendRow(inOut, "Net")).toContainText(
      signedUsd(CHASE_IN_CENTS - CHASE_OUT_CENTS),
    );

    // --- (4) The balance card's Start is End less the Chase rows' net: an Amex
    // row inside the register would move Start by its amount.
    expect(ledger.balanceEnd, "no balanceEnd: the snapshot did not resolve").not.toBeNull();
    expect(ledger.balanceStart).not.toBeNull();
    const endCents = parseCents(ledger.balanceEnd);
    expect(parseCents(ledger.balanceStart)).toBe(
      endCents - (CHASE_IN_CENTS - CHASE_OUT_CENTS),
    );
    const balanceCard = page.getByTestId("chase-stats-balance");
    await expect(balanceCard).toContainText(usd(endCents), { timeout: 15_000 });
    await expect(balanceCard).toContainText(usd(parseCents(ledger.balanceStart)));

    await context.close();
  });

  test("with no Plaid checking linked (source fallback), only Chase + manual rows are listed and totalled", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { userId, email, password } = await createTestUser(
      "txn-chase-hides-amex-fallback",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // No plaid item, account or bank snapshot on purpose: this is the
    // "no Plaid checking linked" fallback, where the ledger lists manual rows
    // whose source is neither `amex` nor `plaid:*`.
    const suffix = Math.random().toString(36).slice(2, 8);
    const today = householdDateOf(new Date());
    const monthStart = previousMonthStart(today);
    const day = `${monthStart.slice(0, 8)}10`;
    const at = (hour: number) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;

    const chaseRows = await db
      .insert(transactionsTable)
      .values([
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(14),
          description: `E2E-${suffix} CHASE PAYROLL`,
          amount: "200.00",
          account: "Chase",
          source: "chase",
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(15),
          description: `E2E-${suffix} CHASE GROCERIES`,
          amount: "-30.00",
          account: "Chase",
          source: "chase",
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(16),
          description: `E2E-${suffix} MANUAL CASH`,
          amount: "-10.00",
          account: "Cash",
          source: "manual",
        },
      ])
      .returning({ id: transactionsTable.id });
    const offRows = await db
      .insert(transactionsTable)
      .values([
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(17),
          description: `E2E-${suffix} AMEX RESTAURANT`,
          amount: "-50.00",
          account: "amex",
          source: "amex",
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(18),
          description: `E2E-${suffix} PLAID AMEX TRAVEL`,
          amount: "-70.00",
          account: "amex",
          source: "plaid:amex",
          plaidTransactionId: `e2e-${suffix}-amex-out`,
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(19),
          description: `E2E-${suffix} PLAID AMEX SECOND`,
          amount: "-17.00",
          account: "amex",
          source: "PLAID:AMEX",
          plaidTransactionId: `e2e-${suffix}-amex-upper`,
        },
        {
          userId,
          householdId,
          occurredOn: day,
          occurredAt: at(20),
          description: `E2E-${suffix} CAPITAL ONE DEBT`,
          amount: "-25.00",
          account: "capitalone",
          source: "plaid:capitalone",
          plaidTransactionId: `e2e-${suffix}-capone-out`,
        },
      ])
      .returning({ id: transactionsTable.id, description: transactionsTable.description });

    const context = await browser.newContext();
    const page = await context.newPage();
    const ledger = await openMonth(page, email, password, monthStart);

    const chaseIds = chaseRows.map((r) => r.id);
    const offIds = offRows.map((r) => r.id);
    expect(new Set(ledger.rows.map((r) => r.id))).toEqual(new Set(chaseIds));
    expect(ledger.matchingCount).toBe(chaseIds.length);
    // The totals the page shows for this range: Chase + manual only.
    expect(parseCents(ledger.totals.moneyIn)).toBe(CHASE_IN_CENTS);
    expect(parseCents(ledger.totals.moneyOut)).toBe(CHASE_OUT_CENTS);
    expect(parseCents(ledger.totals.moneyOut)).not.toBe(SWEPT_OUT_CENTS);
    expect(parseCents(ledger.totals.net)).toBe(CHASE_IN_CENTS - CHASE_OUT_CENTS);
    // No snapshot: no balance is invented.
    expect(ledger.balanceToday).toBeNull();

    await expect(page.getByTestId("chase-showing")).toHaveText(
      `Showing 3 of 3 · 3 to review`,
      { timeout: 20_000 },
    );
    for (const id of chaseIds) {
      await expect(page.getByTestId(`row-tx-${id}`)).toBeVisible({ timeout: 15_000 });
    }
    for (const id of offIds) {
      await expect(page.getByTestId(`row-tx-${id}`)).toHaveCount(0);
    }
    for (const r of offRows) {
      await expect(page.getByText(r.description)).toHaveCount(0);
    }
    await expect(page.locator('[data-testid^="row-tx-"]')).toHaveCount(chaseIds.length);
    // The day total is the Chase rows' net, never the swept one.
    await expect(page.getByTestId(`day-net-${day}`)).toHaveText(
      signedUsd(CHASE_IN_CENTS - CHASE_OUT_CENTS),
    );

    await context.close();
  });
});
