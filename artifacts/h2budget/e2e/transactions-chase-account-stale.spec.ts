import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import { randomUUID } from "node:crypto";
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
 * End-to-end coverage for task #316, rewritten for PR14 (H1): the Chase page
 * (`/transactions`) reads the server's paginated ledger
 * (GET /api/transactions/ledger), and a persisted account pick is sent to the
 * server as `?account=<plaid_accounts.id>`.
 *
 * Guarded: a persisted pick (`?account=` / localStorage `h2budget:chase-account`)
 * that no longer names a ledger account never strands the page on an empty or
 * zeroed view. It resets to the default (bank-snapshot) account A: both
 * persistence channels are cleared, A's rows, figures and balances show.
 *
 *   1. Deleted account (the old spec's path): pick B, then delete B's rows and
 *      its `plaid_accounts` row. On reload the server refuses `account=B`
 *      (400 `account_not_ledger`) and the page falls back to A.
 *   2. An account that is not a Chase ledger account at all: an Ally savings
 *      account in the same household, and a random uuid. The server's 400
 *      alone resets the pick: `/api/forecast` is held back until the reset is
 *      observed, so the older self-heal effect (which needs the forecast
 *      bundle's account list) cannot be what clears it.
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

/** The server refused the persisted account. */
async function expectRefused(res: Response): Promise<void> {
  expect(res.status(), `expected a 400 for ${res.url()}`).toBe(400);
  const body = (await res.json()) as { code?: unknown };
  expect(body.code).toBe("account_not_ledger");
}

function legendRow(card: Locator, label: "In" | "Out" | "Net"): Locator {
  return card.getByText(label, { exact: true }).locator("xpath=..");
}

async function getStorageValue(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

async function expectPersistenceCleared(page: Page): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).searchParams.get("account"), { timeout: 20_000 })
    .toBeNull();
  await expect.poll(() => getStorageValue(page, STORAGE_KEY), { timeout: 20_000 }).toBeNull();
}

const A_IN_CENTS = 20_000;
const A_OUT_CENTS = 5_000;

/** A's rows only (the ledger the page fell back to). */
async function expectAccountARows(
  page: Page,
  ledger: H1LedgerPage,
  aIds: string[],
  bIds: string[],
): Promise<void> {
  expect(new Set(ledger.rows.map((r) => r.id))).toEqual(new Set(aIds));
  expect(parseCents(ledger.totals.moneyIn)).toBe(A_IN_CENTS);
  expect(parseCents(ledger.totals.moneyOut)).toBe(A_OUT_CENTS);
  expect(ledger.balanceUnavailableReason ?? null).toBeNull();
  expect(ledger.balanceEnd, "no balanceEnd on the snapshot account").not.toBeNull();
  for (const id of aIds) {
    await expect(page.getByTestId(`row-tx-${id}`)).toBeVisible({ timeout: 20_000 });
  }
  for (const id of bIds) {
    await expect(page.getByTestId(`row-tx-${id}`)).toHaveCount(0);
  }
}

/** A's figures and balances (needs the forecast bundle for the cards). */
async function expectAccountAFigures(page: Page, ledger: H1LedgerPage): Promise<void> {
  const inOut = page.getByTestId("chase-stats-in-out");
  await expect(legendRow(inOut, "In")).toContainText(usd(A_IN_CENTS), { timeout: 20_000 });
  await expect(legendRow(inOut, "Out")).toContainText(usd(A_OUT_CENTS));
  await expect(legendRow(inOut, "Net")).toContainText(signedUsd(A_IN_CENTS - A_OUT_CENTS));
  const endCents = parseCents(ledger.balanceEnd);
  await expect(page.getByTestId("chase-stats-balance")).toContainText(usd(endCents), {
    timeout: 15_000,
  });
  await expect(page.getByTestId("chase-balance-unavailable")).toHaveCount(0);
  await expect(page.locator('[data-testid^="text-running-balance-"]')).toHaveCount(
    ledger.rows.length,
  );
  for (const r of ledger.rows) {
    await expect(page.getByTestId(`text-running-balance-${r.id}`)).toHaveText(
      `bal ${usd(parseCents(r.runningBalance))}`,
    );
  }
}

test.describe("Chase per-account picker — stale selection self-heal (#316, PR14 ledger H1)", () => {
  test("a persisted pick the server refuses (deleted account, non-Chase account, random uuid) resets to the snapshot account and clears ?account= + localStorage", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { userId, email, password } = await createTestUser(
      "txn-chase-account-stale",
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
    // Not a Chase account: a savings account at another institution.
    const [allyItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `e2e-ally-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Ally Bank",
        institutionSlug: "ally",
      })
      .returning();
    const [allySavings] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: allyItem!.id,
        accountId: `e2e-ally-acct-${suffix}`,
        name: "Online Savings",
        mask: "4444",
        type: "depository",
        subtype: "savings",
      })
      .returning();

    const today = householdDateOf(new Date());
    const monthStart = previousMonthStart(today);
    const day = `${monthStart.slice(0, 8)}15`;
    const seedRow = async (acct: typeof acctA, tag: string, hour: number, amount: string) => {
      const [row] = await db
        .insert(transactionsTable)
        .values({
          userId,
          householdId,
          occurredOn: day,
          occurredAt: `${day}T${hour}:00:00.000Z`,
          description: `E2E-${suffix} ${tag}`,
          amount,
          account: acct!.name,
          source: "plaid:chase",
          plaidTransactionId: `e2e-${suffix}-${tag}`,
          plaidAccountId: acct!.accountId,
        })
        .returning({ id: transactionsTable.id });
      return row!.id;
    };
    const a1 = await seedRow(acctA, "A1", 14, "200.00");
    const a2 = await seedRow(acctA, "A2", 15, "-50.00");
    const b1 = await seedRow(acctB, "B1", 16, "77.00");
    const b2 = await seedRow(acctB, "B2", 17, "-33.00");
    const aIds = [a1, a2];
    const bIds = [b1, b2];

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

    const context = await browser.newContext();
    const page = await context.newPage();

    // --- 1. Pick B so the selection persists into `?account=` and localStorage.
    const firstA = page.waitForResponse(isRegisterLedger(monthStart, null), {
      timeout: 90_000,
    });
    await signInAndOpen(page, email, password, `/transactions?month=${monthStart}`);
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expectAccountARows(page, await readLedger(await firstA), aIds, bIds);

    const trigger = page.getByTestId("select-chase-account");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();
    const optionB = page.getByTestId(`option-chase-account-${acctB!.id}`);
    await expect(optionB).toBeVisible({ timeout: 10_000 });
    const pageBPromise = page.waitForResponse(isRegisterLedger(monthStart, acctB!.id), {
      timeout: 30_000,
    });
    await optionB.click();
    const pageB = await readLedger(await pageBPromise);
    expect(new Set(pageB.rows.map((r) => r.id))).toEqual(new Set(bIds));
    await expect(page.getByTestId(`row-tx-${b1}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`row-tx-${a1}`)).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBe(acctB!.id);
    await expect.poll(() => getStorageValue(page, STORAGE_KEY)).toBe(acctB!.id);

    // The bank disconnected / the account closed: B's rows and B itself go.
    await db
      .delete(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, acctB!.accountId));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.id, acctB!.id));

    // Hold `/api/forecast` for the reloads below, so only the server's 400 can
    // reset a pick. (PR14 second review N2) Step 1 held nothing before: a forecast
    // bundle that answered first let the older self-heal clear the pick, React
    // Query aborted the refused request, and `refusedB` never resolved.
    let hold: Promise<void> | null = null;
    await page.route(
      (url) => url.pathname.endsWith("/api/forecast"),
      async (route) => {
        if (hold) await hold;
        try {
          await route.fallback();
        } catch {
          // The page navigated away while the request was held.
        }
      },
    );

    // Reload: the server refuses `account=B`, and the page falls back to A.
    let releaseReload: () => void = () => {};
    hold = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    try {
      const refusedB = page.waitForResponse(isRegisterLedger(monthStart, acctB!.id), {
        timeout: 60_000,
      });
      const fallbackA = page.waitForResponse(isRegisterLedger(monthStart, null), {
        timeout: 60_000,
      });
      await page.reload();
      await expectRefused(await refusedB);
      // Reset by the 400 alone: the forecast bundle is still held.
      await expectPersistenceCleared(page);
      const pageA = await readLedger(await fallbackA);
      await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
        timeout: 15_000,
      });
      await expectAccountARows(page, pageA, aIds, bIds);
      releaseReload();
      await expectAccountAFigures(page, pageA);
      await expectPersistenceCleared(page);
    } finally {
      releaseReload();
      hold = null;
    }

    // --- 2. Picks that were never a Chase ledger account, under the same hold.

    for (const [label, badId] of [
      ["an Ally savings account", allySavings!.id],
      ["a random uuid", randomUUID()],
    ] as const) {
      let release: () => void = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await page.evaluate(
          ([k, v]) => window.localStorage.setItem(k, v),
          [STORAGE_KEY, badId] as const,
        );
        const refused = page.waitForResponse(isRegisterLedger(monthStart, badId), {
          timeout: 60_000,
        });
        const fallback = page.waitForResponse(isRegisterLedger(monthStart, null), {
          timeout: 60_000,
        });
        await page.goto(`/transactions?month=${monthStart}&account=${badId}`);
        await expectRefused(await refused);

        // Reset by the 400 alone (the forecast bundle has not answered yet).
        await expectPersistenceCleared(page);
        const fellBack = await readLedger(await fallback);
        await expectAccountARows(page, fellBack, aIds, bIds);
        await expect(
          page.getByRole("heading", { name: /^chase$/i }),
          `header after refusing ${label}`,
        ).toBeVisible({ timeout: 15_000 });

        // Let the forecast bundle through: A's figures and balances, and the
        // pick stays cleared.
        release();
        await expectAccountAFigures(page, fellBack);
        await expectPersistenceCleared(page);
      } finally {
        release();
        hold = null;
      }
    }

    await context.close();
  });
});
