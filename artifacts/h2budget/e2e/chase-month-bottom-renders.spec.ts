import { test, expect, type Page, type Response } from "@playwright/test";
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
 * Regression coverage for task #774 — the Chase analogue of the /amex
 * bottom-of-the-month regression locked in by #773 (and the long tail
 * #761/#767/#768/#772), rewritten for PR14: the Chase page (`/transactions`)
 * reads the server's paginated ledger (GET /api/transactions/ledger, 50 rows a
 * request, "Load more") instead of pulling every row and filtering the month
 * in the browser.
 *
 * The guarantee is unchanged: every day-group of the month renders, the
 * earliest one included, for every account picker option, in the month opened
 * by `?month=` AND after `button-prev-month`. A virtualizer, height cache or
 * "skip off-screen groups" optimization, or now a "Load more" that stops short,
 * would clip the bottom of the month; this spec fails instead.
 *
 * Strategy (no network mocks: the rows go through the real ledger code):
 *   - Two Chase checking accounts: A (··1111, owns the bank snapshot) and B
 *     (··2222, not a twin). Two past months (two and three months back), 22
 *     day-groups each: three Plaid rows a day on A, three on B, and one manual
 *     row a day. A's ledger is its rows plus the manual rows (88 a month); B's
 *     is its rows only (66 a month, manual rows are not on B).
 *   - For each picker option (A, B) in each month: the first 50 rows render
 *     (`Showing 50 of N`), the newest day-group is there, the oldest loaded
 *     day's total reads "—", and the month's earliest day-group is not yet
 *     loaded; "Load more" until the button goes (`Showing N of N`); then the
 *     earliest day-group of the month renders with exactly its rows and its
 *     day total, and the newest is still there. A carries running balances;
 *     B (H1) has none and shows "Balance unavailable".
 *   - Every group is addressed by its `data-day-group-key="YYYY-MM-DD"`
 *     wrapper; losing that attribute fails the spec too.
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
const PAGE_SIZE = 50;
// 22 day-groups per month clears the task's ~20-groups threshold and stays
// below any month's length.
const SEEDED_DAYS = Array.from({ length: 22 }, (_, i) => i + 1);
const ROWS_PER_ACCOUNT_PER_DAY = 3;

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

/** The first day of the month `back` months before the household's current month. */
function monthStartBack(today: string, back: number): string {
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7)) - 1;
  return new Date(Date.UTC(y, m0 - back, 1)).toISOString().slice(0, 10);
}

function dayIso(monthStart: string, day: number): string {
  return `${monthStart.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

function centsString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
}

function signedUsd(cents: number): string {
  return cents > 0 ? `+${usd(cents)}` : usd(cents);
}

/** A register ledger page for a month and account: the first, or the one after `cursor`. */
function isRegisterLedger(from: string, account: string | null, cursor: string | null) {
  return (res: Response): boolean => {
    if (res.request().method() !== "GET") return false;
    const u = new URL(res.url());
    if (!u.pathname.endsWith("/api/transactions/ledger")) return false;
    if (u.searchParams.get("from") !== from) return false;
    if (u.searchParams.has("pending")) return false;
    if ((u.searchParams.get("account") ?? null) !== account) return false;
    return cursor === null
      ? !u.searchParams.has("cursor")
      : u.searchParams.get("cursor") === cursor;
  };
}

async function readLedger(res: Response): Promise<H1LedgerPage> {
  expect(res.status(), `ledger request failed: ${res.url()}`).toBe(200);
  return (await res.json()) as H1LedgerPage;
}

async function pickAccount(page: Page, id: string): Promise<void> {
  await page.getByTestId("select-chase-account").click();
  const option = page.getByTestId(`option-chase-account-${id}`);
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
}

type MonthView = {
  label: string;
  from: string;
  /** The `account` query parameter the page sends; null when it names none. */
  account: string | null;
  /** Every row this option's ledger lists for the month. */
  ids: ReadonlySet<string>;
  firstDayKey: string;
  lastDayKey: string;
  firstDayIds: ReadonlySet<string>;
  firstDayCents: number;
  balances: boolean;
};

/**
 * One option in one month: first page, "Load more" to the end, and the
 * earliest day-group of the month rendered with its rows.
 */
async function assertWholeMonthRenders(
  page: Page,
  firstPagePromise: Promise<Response>,
  v: MonthView,
): Promise<void> {
  const total = v.ids.size;
  const first = await readLedger(await firstPagePromise);
  expect(first.matchingCount, `${v.label}: matching rows`).toBe(total);
  expect(first.rows).toHaveLength(PAGE_SIZE);
  if (v.balances) {
    expect(first.balanceUnavailableReason ?? null).toBeNull();
    expect(first.balanceEnd, `${v.label}: no balance on the snapshot account`).not.toBeNull();
  } else {
    expect(first.balanceUnavailableReason).toBe("not_snapshot_account");
    expect(first.balanceEnd).toBeNull();
  }

  // This month's newest group first: it tells this view from the last one.
  const lastGroup = page.locator(`[data-day-group-key="${v.lastDayKey}"]`);
  const firstGroup = page.locator(`[data-day-group-key="${v.firstDayKey}"]`);
  await expect(lastGroup, `${v.label}: newest day-group`).toHaveCount(1, { timeout: 20_000 });
  const showing = page.getByTestId("chase-showing");
  await expect(showing).toHaveText(`Showing ${PAGE_SIZE} of ${total} · ${total} to review`, {
    timeout: 20_000,
  });

  const rowLocator = page.locator('[data-testid^="row-tx-"]');
  await expect(rowLocator).toHaveCount(PAGE_SIZE, { timeout: 20_000 });
  const renderedFirst = await rowLocator.evaluateAll((els) =>
    els.map((el) => (el.getAttribute("data-testid") ?? "").slice("row-tx-".length)),
  );
  expect(new Set(renderedFirst)).toEqual(new Set(first.rows.map((r) => r.id)));

  // The oldest loaded day may continue on the next page: its total is "—".
  const partialDay = first.rows[first.rows.length - 1]!.occurredOn.slice(0, 10);
  await expect(page.getByTestId(`day-net-${partialDay}`)).toHaveText("—");
  // The bottom of the month is not on the first page: "Load more" must bring it.
  await expect(firstGroup).toHaveCount(0);

  const all: LedgerRow[] = [...first.rows];
  let last = first;
  while (last.nextCursor) {
    const loadMore = page.getByTestId("chase-load-more");
    await expect(loadMore).toBeEnabled({ timeout: 15_000 });
    const nextPromise = page.waitForResponse(
      isRegisterLedger(v.from, v.account, last.nextCursor),
      { timeout: 30_000 },
    );
    await loadMore.click();
    last = await readLedger(await nextPromise);
    all.push(...last.rows);
    await expect(showing).toHaveText(
      `Showing ${all.length} of ${total} · ${total} to review`,
      { timeout: 20_000 },
    );
  }
  await expect(page.getByTestId("chase-load-more")).toHaveCount(0);
  expect(all).toHaveLength(total);
  expect(new Set(all.map((r) => r.id))).toEqual(new Set(v.ids));
  await expect(rowLocator).toHaveCount(total, { timeout: 20_000 });

  // The earliest day-group of the month renders, with exactly its rows.
  await expect(
    firstGroup,
    `earliest day-group ${v.firstDayKey} should be in the DOM for ${v.label}`,
  ).toHaveCount(1, { timeout: 15_000 });
  const firstGroupIds = await firstGroup
    .locator('[data-testid^="row-tx-"]')
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute("data-testid") ?? "").slice("row-tx-".length)),
    );
  expect(new Set(firstGroupIds)).toEqual(new Set(v.firstDayIds));
  await expect(page.getByTestId(`day-net-${v.firstDayKey}`)).toHaveText(
    signedUsd(v.firstDayCents),
  );
  await expect(
    lastGroup,
    `latest day-group ${v.lastDayKey} should still be in the DOM for ${v.label}`,
  ).toHaveCount(1);

  if (v.balances) {
    await expect(page.locator('[data-testid^="text-running-balance-"]')).toHaveCount(total);
    await expect(page.getByTestId("chase-balance-unavailable")).toHaveCount(0);
  } else {
    await expect(page.locator('[data-testid^="text-running-balance-"]')).toHaveCount(0);
    await expect(page.getByTestId("chase-balance-unavailable")).toBeVisible();
  }
}

test.describe("/transactions renders every day-group of the month for every account picker option (#774, PR14 ledger)", () => {
  test("the first 50 rows render, Load more reaches the end, and the earliest day-group of the month renders with its rows for each picker option, in the opened month AND after clicking < to the prior month", async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const { userId, email, password } = await createTestUser(
      "chase-month-bottom-renders-774",
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

    // Deterministic past months: never the current month, so every seeded day
    // is before the household's today and no row is "after today".
    const today = householdDateOf(new Date());
    const targetStart = monthStartBack(today, 2);
    const priorStart = monthStartBack(today, 3);

    type Seed = {
      scope: "A" | "B" | "manual";
      day: number;
      description: string;
      amountCents: number;
      values: typeof transactionsTable.$inferInsert;
    };
    const seedsFor = (monthStart: string, tag: string): Seed[] => {
      const out: Seed[] = [];
      for (const day of SEEDED_DAYS) {
        const iso = dayIso(monthStart, day);
        const push = (
          scope: Seed["scope"],
          k: number,
          amountCents: number,
          hour: number,
          acct: typeof acctA | null,
        ) => {
          const description = `E2E-774 ${suffix} ${tag} ${scope} D${String(day).padStart(2, "0")} #${k}`;
          out.push({
            scope,
            day,
            description,
            amountCents,
            values: {
              userId,
              householdId,
              occurredOn: iso,
              occurredAt: `${iso}T${String(hour).padStart(2, "0")}:00:00.000Z`,
              description,
              amount: centsString(amountCents),
              account: acct ? acct.name : "Manual",
              source: acct ? "plaid:chase" : "manual",
              plaidTransactionId: acct ? `e2e-774-${suffix}-${tag}-${scope}-${day}-${k}` : null,
              plaidAccountId: acct ? acct.accountId : null,
            },
          });
        };
        for (let k = 0; k < ROWS_PER_ACCOUNT_PER_DAY; k += 1) {
          push("A", k, -(day * 100 + k * 7 + 13), 9 + k, acctA!);
          push("B", k, -(day * 100 + k * 11 + 29), 13 + k, acctB!);
        }
        push("manual", 0, day * 100 + 50, 17, null);
      }
      return out;
    };
    const seeds = [...seedsFor(targetStart, "target"), ...seedsFor(priorStart, "prior")];
    const inserted = await db
      .insert(transactionsTable)
      .values(seeds.map((s) => s.values))
      .returning({ id: transactionsTable.id, description: transactionsTable.description });
    expect(inserted).toHaveLength(seeds.length);
    const idByDescription = new Map(inserted.map((r) => [r.description, r.id]));

    const viewFor = (
      monthStart: string,
      tag: string,
      option: "A" | "B",
      account: string | null,
    ): MonthView => {
      const monthSeeds = seedsFor(monthStart, tag).filter((s) =>
        option === "A" ? s.scope !== "B" : s.scope === "B",
      );
      const firstDay = SEEDED_DAYS[0]!;
      const lastDay = SEEDED_DAYS[SEEDED_DAYS.length - 1]!;
      const firstDaySeeds = monthSeeds.filter((s) => s.day === firstDay);
      const idOf = (s: Seed) => {
        const id = idByDescription.get(s.description);
        if (!id) throw new Error(`no inserted row for ${s.description}`);
        return id;
      };
      return {
        label: `picker option ${option} in ${monthStart}`,
        from: monthStart,
        account,
        ids: new Set(monthSeeds.map(idOf)),
        firstDayKey: dayIso(monthStart, firstDay),
        lastDayKey: dayIso(monthStart, lastDay),
        firstDayIds: new Set(firstDaySeeds.map(idOf)),
        firstDayCents: firstDaySeeds.reduce((sum, s) => sum + s.amountCents, 0),
        balances: option === "A",
      };
    };

    // The bank snapshot on A, read now: after every seeded row.
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1000.00",
      bankSnapshotAt: new Date(),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acctA!.id,
      bankSnapshotName: acctA!.name,
      bankSnapshotMask: acctA!.mask,
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // --- Arm 1: the month opened by `?month=`. A is the default (no `account`).
    const targetA = page.waitForResponse(isRegisterLedger(targetStart, null, null), {
      timeout: 90_000,
    });
    await signInAndOpen(page, email, password, `/transactions?month=${targetStart}`);
    await expect(page.getByRole("heading", { name: /^chase$/i })).toBeVisible({
      timeout: 15_000,
    });
    await assertWholeMonthRenders(page, targetA, viewFor(targetStart, "target", "A", null));

    await expect(page.getByTestId("select-chase-account")).toBeVisible({ timeout: 20_000 });
    const targetB = page.waitForResponse(isRegisterLedger(targetStart, acctB!.id, null), {
      timeout: 30_000,
    });
    await pickAccount(page, acctB!.id);
    await assertWholeMonthRenders(
      page,
      targetB,
      viewFor(targetStart, "target", "B", acctB!.id),
    );

    // Back to A before navigating, so the prior-month arm starts from a known pick.
    const targetAPicked = page.waitForResponse(
      isRegisterLedger(targetStart, acctA!.id, null),
      { timeout: 30_000 },
    );
    await pickAccount(page, acctA!.id);
    await readLedger(await targetAPicked);
    await expect(
      page.locator(`[data-day-group-key="${dayIso(targetStart, SEEDED_DAYS[SEEDED_DAYS.length - 1]!)}"]`),
    ).toHaveCount(1, { timeout: 20_000 });

    // --- Arm 2: click `<` to the prior month and re-assert for each option.
    const priorA = page.waitForResponse(isRegisterLedger(priorStart, acctA!.id, null), {
      timeout: 30_000,
    });
    await page.getByTestId("button-prev-month").click();
    await assertWholeMonthRenders(
      page,
      priorA,
      viewFor(priorStart, "prior", "A", acctA!.id),
    );

    const priorB = page.waitForResponse(isRegisterLedger(priorStart, acctB!.id, null), {
      timeout: 30_000,
    });
    await pickAccount(page, acctB!.id);
    await assertWholeMonthRenders(page, priorB, viewFor(priorStart, "prior", "B", acctB!.id));

    await context.close();
  });
});
