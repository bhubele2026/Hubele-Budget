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
 * End-to-end coverage for task #297 (per-account picker added in task #103),
 * rewritten for PR14 (H1): the Chase page (`/transactions`) reads the server's
 * paginated ledger (GET /api/transactions/ledger), so switching accounts asks
 * the server for that account's ledger rather than re-filtering rows in the
 * browser.
 *
 * The page renders `chase-account-picker` when the household has 2+ Chase
 * depository accounts. Guarded here:
 *   - Default: the bank-snapshot account A (··1111). Its rows and the manual
 *     rows are listed; Money in / out / net are its figures; the balance card
 *     shows the ledger's balances; every row carries its server running
 *     balance.
 *   - Picking B (··2222, a second Chase checking account, not A's twin): B's
 *     rows only (A's rows and the manual row are gone); Money in / out / net
 *     are B's; "Balance unavailable" instead of balances; no running-balance
 *     chips. The server says why: `balanceUnavailableReason`
 *     "not_snapshot_account", every balance null.
 *   - The pick persists: `?account=<id>` and localStorage
 *     `h2budget:chase-account`, across a reload and from localStorage alone.
 *   - Switching back to A brings its balances and running balances back.
 *
 * All rows are seeded in last month (before the household's today) and opened
 * with `?month=` (Month mode), through the real ledger code.
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
const STORAGE_KEY = "h2budget:chase-account";

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

async function getStorageValue(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

type Figures = { inCents: number; outCents: number; day: string };

async function expectInOut(page: Page, f: Figures): Promise<void> {
  const inOut = page.getByTestId("chase-stats-in-out");
  await expect(legendRow(inOut, "In")).toContainText(usd(f.inCents), { timeout: 15_000 });
  await expect(legendRow(inOut, "Out")).toContainText(usd(f.outCents));
  await expect(legendRow(inOut, "Net")).toContainText(signedUsd(f.inCents - f.outCents));
  await expect(page.getByTestId(`day-net-${f.day}`)).toHaveText(
    signedUsd(f.inCents - f.outCents),
  );
}

/** A (the snapshot account): listed rows, its figures, balances and running balances. */
async function expectAccountA(
  page: Page,
  ledger: H1LedgerPage,
  listed: string[],
  absent: string[],
  f: Figures,
): Promise<void> {
  expect(ledger.balanceUnavailableReason ?? null).toBeNull();
  expect(new Set(ledger.rows.map((r) => r.id))).toEqual(new Set(listed));
  expect(parseCents(ledger.totals.moneyIn)).toBe(f.inCents);
  expect(parseCents(ledger.totals.moneyOut)).toBe(f.outCents);
  expect(ledger.balanceEnd, "no balanceEnd on the snapshot account").not.toBeNull();
  const endCents = parseCents(ledger.balanceEnd);
  expect(parseCents(ledger.balanceStart)).toBe(endCents - (f.inCents - f.outCents));

  for (const id of listed) {
    await expect(page.getByTestId(`row-tx-${id}`)).toBeVisible({ timeout: 15_000 });
  }
  for (const id of absent) {
    await expect(page.getByTestId(`row-tx-${id}`)).toHaveCount(0);
  }
  await expectInOut(page, f);
  const balanceCard = page.getByTestId("chase-stats-balance");
  await expect(balanceCard).toContainText(usd(endCents), { timeout: 15_000 });
  await expect(balanceCard).toContainText(usd(endCents - (f.inCents - f.outCents)));
  await expect(page.getByTestId("chase-balance-unavailable")).toHaveCount(0);
  await expect(page.locator('[data-testid^="text-running-balance-"]')).toHaveCount(
    listed.length,
  );
  for (const r of ledger.rows) {
    await expect(page.getByTestId(`text-running-balance-${r.id}`)).toHaveText(
      `bal ${usd(parseCents(r.runningBalance))}`,
    );
  }
}

/** B (not the snapshot account): its rows, its figures, no balance of any kind. */
async function expectAccountB(
  page: Page,
  ledger: H1LedgerPage,
  listed: string[],
  absent: string[],
  f: Figures,
): Promise<void> {
  expect(ledger.balanceUnavailableReason).toBe("not_snapshot_account");
  expect(ledger.balanceStart).toBeNull();
  expect(ledger.balanceEnd).toBeNull();
  expect(ledger.balanceToday).toBeNull();
  expect(new Set(ledger.rows.map((r) => r.id))).toEqual(new Set(listed));
  for (const r of ledger.rows) {
    expect(r.runningBalance).toBeNull();
    expect(r.balanceAmount as string | null).toBeNull();
  }
  expect(parseCents(ledger.totals.moneyIn)).toBe(f.inCents);
  expect(parseCents(ledger.totals.moneyOut)).toBe(f.outCents);

  for (const id of listed) {
    await expect(page.getByTestId(`row-tx-${id}`)).toBeVisible({ timeout: 15_000 });
  }
  for (const id of absent) {
    await expect(page.getByTestId(`row-tx-${id}`)).toHaveCount(0);
  }
  await expectInOut(page, f);
  await expect(page.getByTestId("chase-balance-unavailable")).toHaveText(
    "Balance unavailable",
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-testid^="text-running-balance-"]')).toHaveCount(0);
}

test.describe("Chase per-account picker (#297, covers #103, PR14 ledger H1)", () => {
  test("picking a second Chase checking account lists its rows and figures with Balance unavailable, persists across reload + localStorage, and switching back restores balances", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { userId, email, password } = await createTestUser(
      "txn-chase-account-picker",
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
    const [acctA] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: item!.id,
        accountId: `e2e-acct-A-${suffix}`,
        name: "Total Checking",
        mask: "1111",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    const [acctB] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: item!.id,
        accountId: `e2e-acct-B-${suffix}`,
        name: "Joint Checking",
        mask: "2222",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    const today = householdDateOf(new Date());
    const monthStart = previousMonthStart(today);
    const day = `${monthStart.slice(0, 8)}15`;
    const seedRow = async (
      acct: typeof acctA | null,
      tag: string,
      hour: number,
      amount: string,
    ) => {
      const [row] = await db
        .insert(transactionsTable)
        .values({
          userId,
          householdId,
          occurredOn: day,
          occurredAt: `${day}T${hour}:00:00.000Z`,
          description: `E2E-${suffix} ${tag}`,
          amount,
          account: acct ? acct.name : "Cash",
          source: acct ? "plaid:chase" : "manual",
          plaidTransactionId: acct ? `e2e-${suffix}-${tag}` : null,
          plaidAccountId: acct ? acct.accountId : null,
        })
        .returning({ id: transactionsTable.id });
      return row!.id;
    };
    const a1 = await seedRow(acctA!, "A1", 14, "200.00");
    const a2 = await seedRow(acctA!, "A2", 15, "-50.00");
    // A manual row: on the snapshot account's ledger, never on B's.
    const m1 = await seedRow(null, "MANUAL", 16, "-9.00");
    const b1 = await seedRow(acctB!, "B1", 17, "77.00");
    const b2 = await seedRow(acctB!, "B2", 18, "-33.00");

    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1234.56",
      bankSnapshotAt: new Date(),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acctA!.id,
      bankSnapshotName: acctA!.name,
      bankSnapshotMask: acctA!.mask,
    });

    const aListed = [a1, a2, m1];
    const bListed = [b1, b2];
    const aFigures: Figures = { inCents: 20_000, outCents: 5_900, day };
    const bFigures: Figures = { inCents: 7_700, outCents: 3_300, day };

    const context = await browser.newContext();
    const page = await context.newPage();

    // --- Default: the snapshot account (the page names no account).
    const firstA = page.waitForResponse(isRegisterLedger(monthStart, null), {
      timeout: 90_000,
    });
    await signInAndOpen(page, email, password, `/transactions?month=${monthStart}`);
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    const pageA = await readLedger(await firstA);
    expect(parseCents(pageA.balanceToday)).toBe(123_456);

    const picker = page.getByTestId("chase-account-picker");
    const trigger = page.getByTestId("select-chase-account");
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(trigger).toBeVisible();
    await expectAccountA(page, pageA, aListed, bListed, aFigures);

    // No initial-load assertion on `?account=` / localStorage: persistence is
    // written only once the user picks (the default is left alone so the
    // stale-selection self-heal can clear them).

    // --- Pick B.
    await trigger.click();
    const optionB = page.getByTestId(`option-chase-account-${acctB!.id}`);
    await expect(optionB).toBeVisible({ timeout: 10_000 });
    const pageBPromise = page.waitForResponse(isRegisterLedger(monthStart, acctB!.id), {
      timeout: 30_000,
    });
    await optionB.click();
    const pageB = await readLedger(await pageBPromise);
    expect(pageB.account.plaidAccountIds).toContain(acctB!.accountId);
    expect(pageB.account.plaidAccountIds).not.toContain(acctA!.accountId);
    await expectAccountB(page, pageB, bListed, aListed, bFigures);

    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBe(acctB!.id);
    await expect.poll(() => getStorageValue(page, STORAGE_KEY)).toBe(acctB!.id);

    // --- A reload keeps B, from `?account=`.
    const reloadB = page.waitForResponse(isRegisterLedger(monthStart, acctB!.id), {
      timeout: 60_000,
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expectAccountB(page, await readLedger(await reloadB), bListed, aListed, bFigures);

    // --- And from localStorage alone: drop `?account=` (keep `?month=`).
    const storedB = page.waitForResponse(isRegisterLedger(monthStart, acctB!.id), {
      timeout: 60_000,
    });
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expectAccountB(page, await readLedger(await storedB), bListed, aListed, bFigures);
    // The persistence effect writes the restored pick back into the URL.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBe(acctB!.id);

    // --- Switch back to A: its balances and running balances return.
    await page.getByTestId("select-chase-account").click();
    const optionA = page.getByTestId(`option-chase-account-${acctA!.id}`);
    await expect(optionA).toBeVisible({ timeout: 10_000 });
    const pageA2Promise = page.waitForResponse(isRegisterLedger(monthStart, acctA!.id), {
      timeout: 30_000,
    });
    await optionA.click();
    const pageA2 = await readLedger(await pageA2Promise);
    expect(pageA2.balanceEnd).toBe(pageA.balanceEnd);
    expect(pageA2.balanceStart).toBe(pageA.balanceStart);
    expect(pageA2.totals).toEqual(pageA.totals);
    await expectAccountA(page, pageA2, aListed, bListed, aFigures);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBe(acctA!.id);
    await expect.poll(() => getStorageValue(page, STORAGE_KEY)).toBe(acctA!.id);

    await context.close();
  });
});
