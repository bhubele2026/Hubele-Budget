import { test, expect, type Locator, type Response } from "@playwright/test";
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
 * End-to-end coverage for task #459 (browser-level guarantee for #452),
 * rewritten for PR14: the Chase page (`/transactions`) reads the server's
 * paginated ledger (GET /api/transactions/ledger). The browser no longer
 * dedupes rows (`dedupeTransactionsByIdentity` is gone from the page); the
 * server settles what each row moves the balance by.
 *
 * The guarantee is unchanged: a purchase a relink leaves on two accounts is
 * never counted twice. What changed is how: the server lists both copies, each
 * once, and the copy on the mask twin (same institution + mask + type +
 * subtype, a second `plaid_accounts` row) counts 0 (`balanceReason`
 * `not_bank`), shown with a "Not counted" chip. The day total, Money out and
 * the balances sum counted rows only.
 *
 * Strategy (no network mocks: the rows go through the real ledger code):
 *   1. Seed one Chase checking account that owns the bank snapshot, and its
 *      mask twin under a second Chase item (a relink). The twin carries a
 *      different account name and `autoDedupeRanAt` is stamped, so no dedupe
 *      hook collapses the pair before the ledger reads it; the server's twin
 *      rule ignores the name.
 *   2. Last month: the same purchase (-$12.34, same day, time and
 *      description) on both accounts, and a solo -$4.50 on another day.
 *      The relinked copy has its own Plaid id: `transactions_plaid_txn_uq`
 *      forbids two rows with one `plaidTransactionId`, so the `duplicate`
 *      reason cannot be seeded here (the API integration tests cover it).
 *   3. Assert: each row renders once (no id twice), the twin copy carries
 *      "Not counted" and the original does not, the day total is -$12.34 (not
 *      -$24.68), Money out is $16.84 (not the listed $29.18), and the balance
 *      card's Start is End plus $16.84 (not $29.18).
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

/** A day total / signed figure: "+$x.xx" when positive, else `formatCurrency`. */
function signedUsd(cents: number): string {
  return cents > 0 ? `+${usd(cents)}` : usd(cents);
}

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

function legendRow(card: Locator, label: "In" | "Out" | "Net"): Locator {
  return card.getByText(label, { exact: true }).locator("xpath=..");
}

test.describe("Chase Transactions page — a relinked twin is listed once and never counted twice (#459, covers #452, PR14 ledger)", () => {
  test("the same purchase on a Chase account and its mask twin renders once each, the twin copy is Not counted, and the day total, Money out and balances count it once", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { userId, email, password } = await createTestUser(
      "txn-chase-no-dup",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `e2e-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: item!.id,
        accountId: `e2e-acct-${suffix}`,
        name: "Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    // The relink: a second Chase item and a second `plaid_accounts` row for the
    // same physical account (institution + mask + type + subtype).
    const [relinkItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `e2e-item-relink-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [twin] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: relinkItem!.id,
        accountId: `e2e-acct-relink-${suffix}`,
        name: "Total Checking (relinked)",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    const today = householdDateOf(new Date());
    const monthStart = previousMonthStart(today);
    const twinDay = `${monthStart.slice(0, 8)}08`;
    const soloDay = `${monthStart.slice(0, 8)}09`;
    const TWIN_DESCRIPTION = `E2E-${suffix} EXACT SCIENCES`;
    const SOLO_DESCRIPTION = `E2E-${suffix} STARBUCKS`;

    const [original] = await db
      .insert(transactionsTable)
      .values({
        userId,
        householdId,
        occurredOn: twinDay,
        occurredAt: `${twinDay}T15:00:00.000Z`,
        description: TWIN_DESCRIPTION,
        amount: "-12.34",
        account: acct!.name,
        source: "plaid:chase",
        plaidTransactionId: `e2e-${suffix}-ptx-exact`,
        plaidAccountId: acct!.accountId,
      })
      .returning({ id: transactionsTable.id });
    const [relinked] = await db
      .insert(transactionsTable)
      .values({
        userId,
        householdId,
        occurredOn: twinDay,
        occurredAt: `${twinDay}T15:00:00.000Z`,
        description: TWIN_DESCRIPTION,
        amount: "-12.34",
        account: twin!.name,
        source: "plaid:chase",
        // A relink mints a fresh Plaid id; the unique index forbids reusing one.
        plaidTransactionId: `e2e-${suffix}-ptx-exact-relink`,
        plaidAccountId: twin!.accountId,
      })
      .returning({ id: transactionsTable.id });
    const [solo] = await db
      .insert(transactionsTable)
      .values({
        userId,
        householdId,
        occurredOn: soloDay,
        occurredAt: `${soloDay}T15:00:00.000Z`,
        description: SOLO_DESCRIPTION,
        amount: "-4.50",
        account: acct!.name,
        source: "plaid:chase",
        plaidTransactionId: `e2e-${suffix}-ptx-coffee`,
        plaidAccountId: acct!.accountId,
      })
      .returning({ id: transactionsTable.id });

    // The bank snapshot, read now (after every seeded row). The dedupe gate is
    // stamped so the page load does not collapse the twin before the ledger reads it.
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "3565.09",
      bankSnapshotAt: new Date(),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acct!.id,
      bankSnapshotName: acct!.name,
      bankSnapshotMask: acct!.mask,
      autoDedupeRanAt: new Date(),
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    const firstPagePromise = page.waitForResponse(isRegisterLedger(monthStart), {
      timeout: 90_000,
    });
    await signInAndOpen(page, email, password, `/transactions?month=${monthStart}`);
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    const ledger = await readLedger(await firstPagePromise);

    // --- The server: both copies listed, the twin copy counts 0.
    const ids = [original!.id, relinked!.id, solo!.id];
    expect(ledger.rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(ledger.matchingCount).toBe(3);
    expect(ledger.nextCursor).toBeNull();
    expect(ledger.account.plaidAccountIds).toEqual(
      expect.arrayContaining([acct!.accountId, twin!.accountId]),
    );
    const byId = new Map(ledger.rows.map((r) => [r.id, r]));
    expect(byId.get(original!.id)).toMatchObject({ countsInBalance: true, balanceReason: "counted" });
    expect(byId.get(solo!.id)).toMatchObject({ countsInBalance: true, balanceReason: "counted" });
    expect(byId.get(relinked!.id)).toMatchObject({ countsInBalance: false, balanceReason: "not_bank" });
    expect(parseCents(byId.get(relinked!.id)!.balanceAmount)).toBe(0);
    const COUNTED_OUT = 1_234 + 450; // $16.84
    const LISTED_OUT = COUNTED_OUT + 1_234; // $29.18
    expect(parseCents(ledger.totals.moneyOut)).toBe(COUNTED_OUT);
    expect(parseCents(ledger.totals.moneyIn)).toBe(0);
    expect(parseCents(ledger.totals.net)).toBe(-COUNTED_OUT);

    await expect(page.getByTestId("chase-showing")).toHaveText(
      `Showing 3 of 3 · 3 to review`,
      { timeout: 20_000 },
    );

    // --- (1) Every row once: no id twice, and exactly the three seeded rows.
    const rowLocator = page.locator('[data-testid^="row-tx-"]');
    await expect(rowLocator).toHaveCount(3, { timeout: 15_000 });
    const renderedIds = await rowLocator.evaluateAll((els) =>
      els.map((el) => (el.getAttribute("data-testid") ?? "").slice("row-tx-".length)),
    );
    expect(new Set(renderedIds).size, "a row rendered twice").toBe(renderedIds.length);
    expect([...renderedIds].sort()).toEqual([...ids].sort());
    await expect(page.getByText(SOLO_DESCRIPTION)).toHaveCount(1);

    // --- (2) The twin copy says it does not count; the original does not.
    await expect(page.getByTestId(`label-not-counted-${relinked!.id}`)).toHaveText(
      "Not counted",
    );
    await expect(page.getByTestId(`label-not-counted-${original!.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`label-not-counted-${solo!.id}`)).toHaveCount(0);

    // --- (3) The day total counts the purchase once: -$12.34, never -$24.68.
    await expect(page.getByTestId(`day-net-${twinDay}`)).toHaveText(signedUsd(-1_234));
    await expect(page.getByTestId(`day-net-${soloDay}`)).toHaveText(signedUsd(-450));

    // --- (4) Money out is the counted rows ($16.84), not the listed sum ($29.18).
    const inOut = page.getByTestId("chase-stats-in-out");
    await expect(legendRow(inOut, "Out")).toContainText(usd(COUNTED_OUT), {
      timeout: 15_000,
    });
    await expect(inOut).not.toContainText(usd(LISTED_OUT));
    await expect(legendRow(inOut, "Net")).toContainText(signedUsd(-COUNTED_OUT));

    // --- (5) The balances count it once: Start = End + $16.84.
    expect(ledger.balanceEnd, "no balanceEnd: the snapshot did not resolve").not.toBeNull();
    const endCents = parseCents(ledger.balanceEnd);
    expect(endCents, "End of last month is today's balance (nothing after it)").toBe(356_509);
    expect(parseCents(ledger.balanceStart)).toBe(endCents + COUNTED_OUT);
    const balanceCard = page.getByTestId("chase-stats-balance");
    await expect(balanceCard).toContainText(usd(endCents), { timeout: 15_000 });
    await expect(balanceCard).toContainText(usd(endCents + COUNTED_OUT));
    await expect(balanceCard).not.toContainText(usd(endCents + LISTED_OUT));

    await context.close();
  });
});
