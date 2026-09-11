import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import { eq } from "drizzle-orm";
import type { LedgerPage, LedgerRow } from "@workspace/api-client-react";
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
 * End-to-end coverage for the harder mid-re-link variant on the Chase
 * Transactions page (task #462, Chase analogue of Amex #449), rewritten for
 * PR14: the page reads the server's paginated ledger
 * (GET /api/transactions/ledger), so the scenario is seeded in the database and
 * read through the real ledger code (no network mocks).
 *
 * #450 (chase-relink-duplicate-no-double-balance) covers a mask twin with no
 * rows. Here a sync fires before `dedupePlaidAccountsForUser` collapses the
 * re-link, so A's postings are re-imported onto the twin `plaid_accounts` row
 * (same institution, mask, type and subtype; a fresh external account id and
 * fresh Plaid transaction ids).
 *
 * #462 once folded the twin's rows into A in the browser (by institution +
 * mask) so they were not lost from A's view. PR13/PR14 move that to the
 * server's twin rule: the twin's rows are LISTED on A's ledger (never dropped
 * from view) but count 0 (`balanceReason` `not_bank`: the bank balance reads
 * only the snapshot's account), with a "Not counted" chip. So the guard is now:
 * the re-imported copies are visible once each and never double a figure.
 *
 *   Phase 1 (twin present): A's ledger lists 4 rows (A's -$25.00 and -$10.00
 *   and their two copies), each once; the copies say "Not counted"; the day
 *   totals are -$25.00 and -$10.00 (not -$50.00 / -$20.00); Money out is
 *   $35.00 (not $70.00); the balance card reads End $1,000.00 = the ledger's
 *   `balanceToday` / `balanceEnd` and Start $1,035.00 (not $1,070.00); every
 *   running balance is the server's. B and C (H1: not the snapshot's account)
 *   list only their own rows with "Balance unavailable".
 *   Phase 2 (dedupe lands: the copies and the twin row are gone): after a
 *   reload the persisted pick (C) is kept, the twin is not an option, and A's
 *   rows, day totals, Money out and balances are exactly Phase 1's figures.
 *
 * The twin carries a different account name and `autoDedupeRanAt` is stamped,
 * so no dedupe hook collapses it during the page load; the server's twin rule
 * ignores the name.
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

/** A ledger page, with PR14's `balanceUnavailableReason` (optional until the client is regenerated). */
type H1LedgerPage = LedgerPage & { balanceUnavailableReason?: string | null };

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

function previousMonthStart(today: string): string {
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  return new Date(Date.UTC(y, m0 - 1, 1)).toISOString().slice(0, 10);
}

function parseCents(raw: string | null | undefined): number {
  if (raw == null) throw new Error("expected a money string, got null");
  const m = raw.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`could not parse money: "${raw}"`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
}

function signedUsd(cents: number): string {
  return cents > 0 ? `+${usd(cents)}` : usd(cents);
}

function isRegisterLedger(from: string, account: string | null) {
  return (res: Response): boolean => {
    if (res.request().method() !== "GET") return false;
    const u = new URL(res.url());
    if (!u.pathname.endsWith("/api/transactions/ledger")) return false;
    if (u.searchParams.get("from") !== from) return false;
    if (u.searchParams.has("pending") || u.searchParams.has("cursor")) return false;
    return (u.searchParams.get("account") ?? null) === account;
  };
}

async function readLedger(res: Response): Promise<H1LedgerPage> {
  expect(res.status(), `ledger request failed: ${res.url()}`).toBe(200);
  return (await res.json()) as H1LedgerPage;
}

function legendRow(card: Locator, label: "In" | "Out" | "Net"): Locator {
  return card.getByText(label, { exact: true }).locator("xpath=..");
}

async function pickAccount(page: Page, id: string): Promise<void> {
  await page.getByTestId("select-chase-account").click();
  const option = page.getByTestId(`option-chase-account-${id}`);
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
}

const SNAPSHOT_CENTS = 100_000; // $1,000.00
const A_OUT_CENTS = 2_500 + 1_000; // $35.00, counted once
const DOUBLED_OUT_CENTS = 2 * A_OUT_CENTS; // $70.00

/** Every running-balance chip on screen is the server row's `runningBalance`. */
async function expectRunningBalances(page: Page, rows: ReadonlyArray<LedgerRow>) {
  await expect(page.locator('[data-testid^="text-running-balance-"]')).toHaveCount(
    rows.length,
    { timeout: 15_000 },
  );
  for (const r of rows) {
    expect(r.runningBalance, `no runningBalance for ${r.id}`).not.toBeNull();
    await expect(page.getByTestId(`text-running-balance-${r.id}`)).toHaveText(
      `bal ${usd(parseCents(r.runningBalance))}`,
    );
  }
}

/** A's figures, identical with or without the twin: counted once, never doubled. */
async function expectSnapshotFigures(
  page: Page,
  ledger: H1LedgerPage,
  days: { grocerDay: string; pharmacyDay: string },
): Promise<void> {
  expect(ledger.balanceUnavailableReason ?? null).toBeNull();
  expect(parseCents(ledger.balanceToday)).toBe(SNAPSHOT_CENTS);
  expect(parseCents(ledger.balanceEnd)).toBe(SNAPSHOT_CENTS);
  expect(parseCents(ledger.balanceStart)).toBe(SNAPSHOT_CENTS + A_OUT_CENTS);
  expect(parseCents(ledger.totals.moneyOut)).toBe(A_OUT_CENTS);
  expect(parseCents(ledger.totals.moneyIn)).toBe(0);

  await expect(page.getByTestId(`day-net-${days.grocerDay}`)).toHaveText(signedUsd(-2_500), {
    timeout: 15_000,
  });
  await expect(page.getByTestId(`day-net-${days.pharmacyDay}`)).toHaveText(signedUsd(-1_000));

  const inOut = page.getByTestId("chase-stats-in-out");
  await expect(legendRow(inOut, "Out")).toContainText(usd(A_OUT_CENTS), { timeout: 15_000 });
  await expect(inOut).not.toContainText(usd(DOUBLED_OUT_CENTS));

  const balanceCard = page.getByTestId("chase-stats-balance");
  await expect(balanceCard).toContainText(usd(SNAPSHOT_CENTS), { timeout: 15_000 });
  await expect(balanceCard).toContainText(usd(SNAPSHOT_CENTS + A_OUT_CENTS));
  await expect(balanceCard).not.toContainText(usd(SNAPSHOT_CENTS + DOUBLED_OUT_CENTS));
  await expect(balanceCard).not.toContainText(usd(2 * SNAPSHOT_CENTS));
  await expect(page.getByTestId("chase-balance-unavailable")).toHaveCount(0);

  await expectRunningBalances(page, ledger.rows);
}

/** B's or C's view (H1): its own rows and money, no balance of any kind. */
async function expectNonSnapshotAccount(
  page: Page,
  ledger: H1LedgerPage,
  own: { rowId: string; outCents: number },
  absentRowIds: string[],
): Promise<void> {
  expect(ledger.balanceUnavailableReason).toBe("not_snapshot_account");
  expect(ledger.balanceStart).toBeNull();
  expect(ledger.balanceEnd).toBeNull();
  expect(ledger.balanceToday).toBeNull();
  expect(ledger.rows.map((r) => r.id)).toEqual([own.rowId]);
  for (const r of ledger.rows) {
    expect(r.runningBalance).toBeNull();
    expect(r.balanceAmount as string | null).toBeNull();
  }
  expect(parseCents(ledger.totals.moneyOut)).toBe(own.outCents);

  await expect(page.getByTestId(`row-tx-${own.rowId}`)).toBeVisible({ timeout: 15_000 });
  for (const id of absentRowIds) {
    await expect(page.getByTestId(`row-tx-${id}`)).toHaveCount(0);
  }
  await expect(page.getByTestId("chase-balance-unavailable")).toHaveText(
    "Balance unavailable",
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-testid^="text-running-balance-"]')).toHaveCount(0);
  await expect(legendRow(page.getByTestId("chase-stats-in-out"), "Out")).toContainText(
    usd(own.outCents),
  );
}

test.describe("Chase page — re-link duplicate window with transactions never doubles a figure (#462, PR14 ledger)", () => {
  test("rows re-imported onto a mask twin are listed once each and Not counted; day totals, Money out and balances count A's activity once, and are unchanged once dedupe removes the twin", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { userId, email, password } = await createTestUser(
      "chase-relink-dup-txn",
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
    const addAccount = async (
      itemId: string,
      tag: string,
      name: string,
      mask: string,
      subtype: "checking" | "savings",
    ) => {
      const [row] = await db
        .insert(plaidAccountsTable)
        .values({
          userId,
          householdId,
          itemId,
          accountId: `e2e-acct-${tag}-${suffix}`,
          name,
          mask,
          type: "depository",
          subtype,
        })
        .returning();
      return row!;
    };
    const acctA = await addAccount(item!.id, "A", "Total Checking", "1111", "checking");
    const acctB = await addAccount(item!.id, "B", "Joint Checking", "2222", "checking");
    const acctC = await addAccount(item!.id, "C", "Savings", "3333", "savings");
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
    const acctADup = await addAccount(
      relinkItem!.id,
      "A-dup",
      "Total Checking (relinked)",
      "1111",
      "checking",
    );

    const today = householdDateOf(new Date());
    const monthStart = previousMonthStart(today);
    const grocerDay = `${monthStart.slice(0, 8)}12`;
    const pharmacyDay = `${monthStart.slice(0, 8)}14`;

    const seedRow = async (
      acct: typeof acctA,
      key: string,
      day: string,
      hour: number,
      description: string,
      amount: string,
    ) => {
      const [row] = await db
        .insert(transactionsTable)
        .values({
          userId,
          householdId,
          occurredOn: day,
          occurredAt: `${day}T${hour}:00:00.000Z`,
          description,
          amount,
          account: acct.name,
          source: "plaid:chase",
          plaidTransactionId: `e2e-${suffix}-${key}`,
          plaidAccountId: acct.accountId,
        })
        .returning({ id: transactionsTable.id });
      return row!.id;
    };
    const GROCER = `E2E-${suffix} CHASE RELINK GROCER`;
    const PHARMACY = `E2E-${suffix} CHASE RELINK PHARMACY`;
    const a1 = await seedRow(acctA, "a1", grocerDay, 15, GROCER, "-25.00");
    const a2 = await seedRow(acctA, "a2", pharmacyDay, 15, PHARMACY, "-10.00");
    // The re-imports on the twin: same postings, fresh Plaid ids.
    const d1 = await seedRow(acctADup, "a1-relink", grocerDay, 15, GROCER, "-25.00");
    const d2 = await seedRow(acctADup, "a2-relink", pharmacyDay, 15, PHARMACY, "-10.00");
    const bRow = await seedRow(acctB, "b1", grocerDay, 16, `E2E-${suffix} JOINT`, "-50.00");
    const cRow = await seedRow(acctC, "c1", grocerDay, 17, `E2E-${suffix} SAVINGS`, "-75.00");

    const snapAt = new Date().toISOString();
    const snap = (acct: typeof acctA, balance: string) => ({
      balance,
      at: snapAt,
      source: "plaid" as const,
      name: acct.name,
      mask: acct.mask,
    });
    // The twin has no per-account snapshot in this variant: transactions only.
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1000.00",
      bankSnapshotAt: new Date(),
      bankSnapshotSource: "plaid",
      bankSnapshotAccountId: acctA.id,
      bankSnapshotName: acctA.name,
      bankSnapshotMask: acctA.mask,
      accountSnapshots: {
        [acctA.id]: snap(acctA, "1000.00"),
        [acctB.id]: snap(acctB, "500.00"),
        [acctC.id]: snap(acctC, "300.00"),
      },
      autoDedupeRanAt: new Date(),
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // --- Phase 1: the twin and its copies are present.
    const firstA = page.waitForResponse(isRegisterLedger(monthStart, null), {
      timeout: 90_000,
    });
    await signInAndOpen(page, email, password, `/transactions?month=${monthStart}`);
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    const pageA = await readLedger(await firstA);

    // The server lists the copies (not dropped from A's view) and counts them 0.
    expect(pageA.rows.map((r) => r.id).sort()).toEqual([a1, a2, d1, d2].sort());
    const byId = new Map(pageA.rows.map((r) => [r.id, r]));
    for (const id of [a1, a2]) {
      expect(byId.get(id)).toMatchObject({ countsInBalance: true, balanceReason: "counted" });
    }
    for (const id of [d1, d2]) {
      expect(byId.get(id)).toMatchObject({ countsInBalance: false, balanceReason: "not_bank" });
      expect(parseCents(byId.get(id)!.balanceAmount)).toBe(0);
    }

    await expect(page.getByTestId("chase-showing")).toHaveText(
      `Showing 4 of 4 · 4 to review`,
      { timeout: 20_000 },
    );
    const rowLocator = page.locator('[data-testid^="row-tx-"]');
    await expect(rowLocator).toHaveCount(4, { timeout: 15_000 });
    const renderedIds = await rowLocator.evaluateAll((els) =>
      els.map((el) => (el.getAttribute("data-testid") ?? "").slice("row-tx-".length)),
    );
    expect(new Set(renderedIds).size, "a row rendered twice").toBe(renderedIds.length);
    expect([...renderedIds].sort()).toEqual([a1, a2, d1, d2].sort());
    for (const id of [d1, d2]) {
      await expect(page.getByTestId(`label-not-counted-${id}`)).toHaveText("Not counted");
    }
    for (const id of [a1, a2]) {
      await expect(page.getByTestId(`label-not-counted-${id}`)).toHaveCount(0);
    }
    await expectSnapshotFigures(page, pageA, { grocerDay, pharmacyDay });

    // B and C: their own rows, no balance, none of A's rows or copies.
    await expect(page.getByTestId("select-chase-account")).toBeVisible({ timeout: 15_000 });
    const pageBPromise = page.waitForResponse(isRegisterLedger(monthStart, acctB.id), {
      timeout: 30_000,
    });
    await pickAccount(page, acctB.id);
    await expectNonSnapshotAccount(
      page,
      await readLedger(await pageBPromise),
      { rowId: bRow, outCents: 5_000 },
      [a1, a2, d1, d2, cRow],
    );
    const pageCPromise = page.waitForResponse(isRegisterLedger(monthStart, acctC.id), {
      timeout: 30_000,
    });
    await pickAccount(page, acctC.id);
    await expectNonSnapshotAccount(
      page,
      await readLedger(await pageCPromise),
      { rowId: cRow, outCents: 7_500 },
      [a1, a2, d1, d2, bRow],
    );

    // --- Phase 2: dedupe lands. The copies are folded away and the twin row goes.
    await db
      .delete(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, acctADup.accountId));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.id, acctADup.id));

    const reloadC = page.waitForResponse(isRegisterLedger(monthStart, acctC.id), {
      timeout: 60_000,
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    // The pick (C) persisted across the reload.
    await expectNonSnapshotAccount(
      page,
      await readLedger(await reloadC),
      { rowId: cRow, outCents: 7_500 },
      [a1, a2, bRow],
    );

    await page.getByTestId("select-chase-account").click();
    await expect(page.getByTestId(`option-chase-account-${acctA.id}`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId(`option-chase-account-${acctADup.id}`)).toHaveCount(0);
    const pageA2Promise = page.waitForResponse(isRegisterLedger(monthStart, acctA.id), {
      timeout: 30_000,
    });
    await page.getByTestId(`option-chase-account-${acctA.id}`).click();
    const pageA2 = await readLedger(await pageA2Promise);

    expect(pageA2.rows.map((r) => r.id).sort()).toEqual([a1, a2].sort());
    for (const r of pageA2.rows) expect(r.countsInBalance).toBe(true);
    // Exactly Phase 1's figures: the copies never counted.
    expect(pageA2.totals.moneyOut).toBe(pageA.totals.moneyOut);
    expect(pageA2.balanceStart).toBe(pageA.balanceStart);
    expect(pageA2.balanceEnd).toBe(pageA.balanceEnd);
    await expect(page.locator('[data-testid^="row-tx-"]')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('[data-testid^="label-not-counted-"]')).toHaveCount(0);
    await expectSnapshotFigures(page, pageA2, { grocerDay, pharmacyDay });

    await context.close();
  });
});
