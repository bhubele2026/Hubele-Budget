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
 * End-to-end coverage for the brief mid-re-link window on the Chase
 * Transactions page (task #450, Chase analogue of #442), rewritten for PR14:
 * the page reads the server's paginated ledger (GET /api/transactions/ledger)
 * and its balances, not a client-side roll-forward of `/api/forecast`
 * snapshots, so the scenario is seeded in the database and read through the
 * real ledger code (no network mocks).
 *
 * Scenario: three Chase depository accounts (A checking ··1111, which owns the
 * bank snapshot at $1,000.00; B checking ··2222; C savings ··3333), and the
 * user re-links Chase. For a window before `dedupePlaidAccountsForUser`
 * collapses it, a fourth `plaid_accounts` row exists for A (same institution,
 * mask, type and subtype: A's mask twin), with its own per-account snapshot
 * entry of $1,000.00 and, in this variant, no transactions. (#462's variant,
 * with rows on the twin, is chase-relink-duplicate-with-transactions-….)
 * The twin carries a different account name and `autoDedupeRanAt` is stamped,
 * so no dedupe hook collapses it during the page load; the server's twin rule
 * ignores the name.
 *
 * Regression class locked in: the duplicate never inflates a balance.
 *   Phase 1 (twin present): A's ledger names both A and its twin, and its
 *   balance card reads End $1,000.00 and Start $1,025.00 (one -$25.00 row in
 *   last month), equal to the ledger's `balanceToday` / `balanceEnd`, never
 *   the doubled $2,000.00 / $2,025.00. Each running balance is the server's.
 *   B and C (H1: accounts other than the snapshot's) list their own rows and
 *   money in/out with "Balance unavailable" and no running balances; no
 *   per-account snapshot is presented as a ledger balance.
 *   Phase 2 (dedupe lands: the twin row and its snapshot entry are removed):
 *   after a reload the persisted pick (C) is kept, the twin is not an option,
 *   and A's figures are unchanged.
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

/** The register's first page for a month; `account` null = the page named no account. */
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
const A_OUT_CENTS = 2_500;

/** A's view: balances from the snapshot's register, never doubled by the twin. */
async function expectSnapshotAccount(
  page: Page,
  ledger: H1LedgerPage,
  aRowId: string,
): Promise<void> {
  expect(ledger.balanceUnavailableReason ?? null).toBeNull();
  expect(parseCents(ledger.balanceToday)).toBe(SNAPSHOT_CENTS);
  expect(parseCents(ledger.balanceEnd)).toBe(SNAPSHOT_CENTS);
  expect(parseCents(ledger.balanceStart)).toBe(SNAPSHOT_CENTS + A_OUT_CENTS);
  expect(parseCents(ledger.totals.moneyOut)).toBe(A_OUT_CENTS);
  expect(ledger.rows.map((r) => r.id)).toEqual([aRowId]);

  await expect(page.getByTestId(`row-tx-${aRowId}`)).toBeVisible({ timeout: 15_000 });
  const balanceCard = page.getByTestId("chase-stats-balance");
  await expect(balanceCard).toContainText(usd(SNAPSHOT_CENTS), { timeout: 15_000 });
  await expect(balanceCard).toContainText(usd(SNAPSHOT_CENTS + A_OUT_CENTS));
  await expect(balanceCard).not.toContainText(usd(2 * SNAPSHOT_CENTS));
  await expect(balanceCard).not.toContainText(usd(2 * SNAPSHOT_CENTS + A_OUT_CENTS));
  await expect(page.getByTestId("chase-balance-unavailable")).toHaveCount(0);
  await expect(page.getByTestId(`text-running-balance-${aRowId}`)).toHaveText(
    `bal ${usd(parseCents(ledger.rows[0]!.runningBalance))}`,
  );
  await expect(page.getByTestId(`text-running-balance-${aRowId}`)).toHaveText(
    `bal ${usd(SNAPSHOT_CENTS)}`,
  );
  await expect(legendRow(page.getByTestId("chase-stats-in-out"), "Out")).toContainText(
    usd(A_OUT_CENTS),
  );
}

/** B's or C's view (H1): its own rows and money, no balance of any kind. */
async function expectNonSnapshotAccount(
  page: Page,
  ledger: H1LedgerPage,
  own: { rowId: string; outCents: number; externalId: string },
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
  expect(ledger.account.plaidAccountIds).toContain(own.externalId);

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

test.describe("Chase page — re-link duplicate window doesn't double the balance (#450, PR14 ledger)", () => {
  test("with a mask twin of the snapshot account landing during re-link, A's balance card equals the ledger's balance (not double), B and C show their own money with no balance, and nothing moves once dedupe removes the twin", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { userId, email, password } = await createTestUser(
      "chase-relink-dup",
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
    // The re-link: a second Chase item carrying a second row for A.
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
    const day = `${monthStart.slice(0, 8)}12`;
    const seedRow = async (acct: typeof acctA, amount: string, hour: number) => {
      const [row] = await db
        .insert(transactionsTable)
        .values({
          userId,
          householdId,
          occurredOn: day,
          occurredAt: `${day}T${hour}:00:00.000Z`,
          description: `E2E-${suffix} RELINK ${acct.mask} ACTIVITY`,
          amount,
          account: acct.name,
          source: "plaid:chase",
          plaidTransactionId: `e2e-${suffix}-${acct.accountId}`,
          plaidAccountId: acct.accountId,
        })
        .returning({ id: transactionsTable.id });
      return row!.id;
    };
    const aRow = await seedRow(acctA, "-25.00", 15);
    const bRow = await seedRow(acctB, "-50.00", 16);
    const cRow = await seedRow(acctC, "-75.00", 17);

    // Per-account snapshots, including the twin's own $1,000.00 entry: the
    // mid-re-link shape that would read $2,000.00 if anything summed A and its twin.
    const snapAt = new Date().toISOString();
    const snap = (acct: typeof acctA, balance: string) => ({
      balance,
      at: snapAt,
      source: "plaid" as const,
      name: acct.name,
      mask: acct.mask,
    });
    const realSnapshots = {
      [acctA.id]: snap(acctA, "1000.00"),
      [acctB.id]: snap(acctB, "500.00"),
      [acctC.id]: snap(acctC, "300.00"),
    };
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1000.00",
      bankSnapshotAt: new Date(),
      bankSnapshotSource: "plaid",
      bankSnapshotAccountId: acctA.id,
      bankSnapshotName: acctA.name,
      bankSnapshotMask: acctA.mask,
      accountSnapshots: { ...realSnapshots, [acctADup.id]: snap(acctADup, "1000.00") },
      autoDedupeRanAt: new Date(),
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // --- Phase 1: the twin is present. Default view = the snapshot account.
    const firstA = page.waitForResponse(isRegisterLedger(monthStart, null), {
      timeout: 90_000,
    });
    await signInAndOpen(page, email, password, `/transactions?month=${monthStart}`);
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    const pageA = await readLedger(await firstA);
    // The ledger recognises the twin as A (its rows would be listed, not counted)…
    expect(pageA.account.plaidAccountIds).toEqual(
      expect.arrayContaining([acctA.accountId, acctADup.accountId]),
    );
    expect(pageA.account.plaidAccountIds).not.toContain(acctB.accountId);
    // …and the balance is A's register, not doubled.
    await expectSnapshotAccount(page, pageA, aRow);

    await expect(page.getByTestId("select-chase-account")).toBeVisible({ timeout: 15_000 });

    const pageBPromise = page.waitForResponse(isRegisterLedger(monthStart, acctB.id), {
      timeout: 30_000,
    });
    await pickAccount(page, acctB.id);
    await expectNonSnapshotAccount(
      page,
      await readLedger(await pageBPromise),
      { rowId: bRow, outCents: 5_000, externalId: acctB.accountId },
      [aRow, cRow],
    );

    const pageCPromise = page.waitForResponse(isRegisterLedger(monthStart, acctC.id), {
      timeout: 30_000,
    });
    await pickAccount(page, acctC.id);
    await expectNonSnapshotAccount(
      page,
      await readLedger(await pageCPromise),
      { rowId: cRow, outCents: 7_500, externalId: acctC.accountId },
      [aRow, bRow],
    );

    // --- Phase 2: dedupe lands. The twin row and its snapshot entry go.
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.id, acctADup.id));
    await db
      .update(forecastSettingsTable)
      .set({ accountSnapshots: realSnapshots })
      .where(eq(forecastSettingsTable.userId, userId));

    // The pick (C) persists across the reload via `?account=` + localStorage.
    const reloadC = page.waitForResponse(isRegisterLedger(monthStart, acctC.id), {
      timeout: 60_000,
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expectNonSnapshotAccount(
      page,
      await readLedger(await reloadC),
      { rowId: cRow, outCents: 7_500, externalId: acctC.accountId },
      [aRow, bRow],
    );

    // The twin is not an option; A is.
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
    // A's figures did not move: the twin never contributed.
    expect(pageA2.account.plaidAccountIds).toEqual([acctA.accountId]);
    expect(pageA2.balanceEnd).toBe(pageA.balanceEnd);
    expect(pageA2.balanceStart).toBe(pageA.balanceStart);
    expect(pageA2.totals).toEqual(pageA.totals);
    await expectSnapshotAccount(page, pageA2, aRow);

    // B still shows its own money and no balance after dedupe.
    const pageB2Promise = page.waitForResponse(isRegisterLedger(monthStart, acctB.id), {
      timeout: 30_000,
    });
    await pickAccount(page, acctB.id);
    await expectNonSnapshotAccount(
      page,
      await readLedger(await pageB2Promise),
      { rowId: bRow, outCents: 5_000, externalId: acctB.accountId },
      [aRow, cRow],
    );

    await context.close();
  });
});
