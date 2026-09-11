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
 * End-to-end coverage for the Chase page's per-row "bal $X" running balance
 * (#393), rewritten for PR14: the Chase page (`/transactions`) now reads the
 * server's paginated ledger (GET /api/transactions/ledger, 50 rows a page,
 * "Load more") instead of pulling a capped client-side list and computing
 * running balances in the browser.
 *
 * Why more than 100 rows: the old page asked GET /transactions for at most
 * 1,000 rows, newest first, so past the cap the OLDEST rows fell off silently
 * and every running balance, the money in/out and the ending balance moved
 * without a word. The server now pages the whole register, so this spec seeds
 * 120 rows: three pages (50 + 50 + 20), which puts two page boundaries (rows
 * 50/51 and 100/101) under the running-balance chain. A chain that only held
 * inside one page, or a "Load more" that dropped or repeated a row, fails here.
 *
 * Strategy (no network mocks for transactions: the rows go through the real
 * ledger code):
 *   1. Provision a fresh user + household; seed one Chase Plaid item and one
 *      checking account, 120 posted Plaid rows on that account (distinct
 *      `occurredAt`, a mix of debits and a few credits, unique Plaid ids), all
 *      dated inside the household's current month and never after the
 *      household's today (America/Chicago), then a manual bank snapshot of
 *      $5,000.00 pointing at the account, read "now". Every row happened
 *      before the read, so the snapshot holds all of them and today's balance
 *      is the snapshot's $5,000.00.
 *   2. Open `/transactions?month=<first of this month>` so the range is the
 *      month, and capture the register's first ledger response (`from` = the
 *      month start, no `pending`, no `cursor`).
 *   3. Wait for "Showing 50 of 120 · 120 to review", then assert the 50 rendered
 *      rows are the server's rows in the server's order, each
 *      `text-running-balance-<id>` equals that row's `runningBalance` to the
 *      cent, the newest equals `balanceToday`, and in DOM order
 *        next = prev − prevRow.balanceAmount   (integer cents).
 *   4. Click "Load more" twice (capturing each page by the previous page's
 *      `nextCursor`): 100 then 120 unique rows, the same checks across all of
 *      them (so the chain holds across both page boundaries), and no
 *      "Load more" once the last page is in.
 *   5. Re-run the checks at desktop (1280×800) and mobile (390×844). The Chase
 *      row is one DOM node that re-flows (`flex-col md:flex-row`), so the dual
 *      layout coverage is a viewport sweep over the same chips, plus a geometry
 *      check that no chip collapses or hides at either width.
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
const SEED_COUNT = 120;
const PAGE_SIZE = 50;
const ANCHOR_CENTS = 500_000; // $5,000.00
// Rows step back 5 hours apiece from just before now. 120 rows span 25 days;
// any that would land before the 1st are pinned to the 1st (their
// `occurredAt` still steps back, so the order stays strict). On the 1st of a
// month every row is dated today.
const STEP_MS = 5 * 60 * 60 * 1000;

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

/** A money string from integer cents. -1234 → "-12.34". */
function centsString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Integer cents from a server money string ("5000.00", "-12.34") or a chip's
 * text ("bal $1,234.56", "bal -$1,234.56"). No floats: money is compared to
 * the cent.
 */
function parseCents(raw: string): number {
  const s = raw.replace(/^\s*bal\s*/i, "").replace(/[$,\s]/g, "");
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`could not parse money: "${raw}"`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

type SeedRow = {
  occurredOn: string;
  occurredAt: string;
  amountCents: number;
  ptx: string;
  description: string;
};

/** A register ledger response for this month: first page, or the page after `cursor`. */
function isRegisterLedger(monthStart: string, cursor: string | null) {
  return (res: Response): boolean => {
    if (res.request().method() !== "GET") return false;
    const u = new URL(res.url());
    if (!u.pathname.endsWith("/api/transactions/ledger")) return false;
    if (u.searchParams.get("from") !== monthStart) return false;
    if (u.searchParams.has("pending")) return false;
    return cursor === null
      ? !u.searchParams.has("cursor")
      : u.searchParams.get("cursor") === cursor;
  };
}

async function readLedger(res: Response): Promise<LedgerPage> {
  expect(res.status(), `ledger request failed: ${res.url()}`).toBe(200);
  return (await res.json()) as LedgerPage;
}

/**
 * The rendered register against the server's rows, in DOM order: the same ids
 * in the same order, each chip equal to the row's `runningBalance`, the newest
 * equal to `balanceToday`, and the chain next = prev − prevRow.balanceAmount.
 */
async function assertRegisterMatches(
  page: Page,
  serverRows: ReadonlyArray<LedgerRow>,
  balanceTodayCents: number,
): Promise<void> {
  const rowLocator = page.locator('[data-testid^="row-tx-"]');
  const chipLocator = page.locator('[data-testid^="text-running-balance-"]');
  await expect(rowLocator).toHaveCount(serverRows.length, { timeout: 20_000 });
  await expect(chipLocator).toHaveCount(serverRows.length, { timeout: 20_000 });

  const serverIds = serverRows.map((r) => r.id);
  const renderedRowIds = await rowLocator.evaluateAll((els) =>
    els.map((el) => (el.getAttribute("data-testid") ?? "").slice("row-tx-".length)),
  );
  expect(new Set(renderedRowIds).size, "every rendered row is unique").toBe(
    renderedRowIds.length,
  );
  expect(renderedRowIds, "rows render in the server's order").toEqual(serverIds);

  const chips = await chipLocator.evaluateAll((els) =>
    els.map((el) => ({
      id: (el.getAttribute("data-testid") ?? "").slice("text-running-balance-".length),
      text: el.textContent ?? "",
    })),
  );
  expect(
    chips.map((c) => c.id),
    "running-balance chips render in the server's order",
  ).toEqual(serverIds);

  for (let k = 0; k < chips.length; k += 1) {
    const row = serverRows[k]!;
    const chipCents = parseCents(chips[k]!.text);
    expect(
      row.runningBalance,
      `server gave no runningBalance for row ${k + 1} (${row.id})`,
    ).not.toBeNull();
    expect(
      chipCents,
      `row ${k + 1} (${row.id}) chip "${chips[k]!.text}" vs server ${row.runningBalance}`,
    ).toBe(parseCents(row.runningBalance!));
    if (k === 0) {
      expect(chipCents, "newest row's balance is today's bank balance").toBe(
        balanceTodayCents,
      );
    } else {
      const prevCents = parseCents(chips[k - 1]!.text);
      const prevMove = parseCents(serverRows[k - 1]!.balanceAmount);
      expect(
        chipCents,
        `chain breaks between rows ${k} and ${k + 1}: ${centsString(prevCents)} − ${centsString(prevMove)}`,
      ).toBe(prevCents - prevMove);
    }
  }
}

/** Every chip has a real box and is not hidden at the current viewport. */
async function assertChipsLaidOut(
  page: Page,
  serverRows: ReadonlyArray<LedgerRow>,
): Promise<void> {
  const collapsed = await page
    .locator('[data-testid^="text-running-balance-"]')
    .evaluateAll((els) =>
      els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return (
            r.width <= 0 ||
            r.height <= 0 ||
            cs.visibility === "hidden" ||
            cs.display === "none"
          );
        })
        .map((el) => el.getAttribute("data-testid")),
    );
  expect(collapsed, "running-balance chips with no visible box").toEqual([]);

  // Scroll to the newest row, both page boundaries and the oldest row.
  const sample = [0, PAGE_SIZE - 1, PAGE_SIZE, 2 * PAGE_SIZE - 1, 2 * PAGE_SIZE, serverRows.length - 1];
  for (const k of sample) {
    const row = serverRows[k];
    if (!row) continue;
    const chip = page.getByTestId(`text-running-balance-${row.id}`);
    await chip.scrollIntoViewIfNeeded();
    await expect(chip).toBeVisible({ timeout: 15_000 });
  }
}

test.describe("Chase Transactions page — per-row running balance on the paged ledger (#393, PR14)", () => {
  test("120 rows over three ledger pages render in the server's order with a running balance chain that ties to today's balance, at desktop and mobile widths", async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    const { userId, email, password } = await createTestUser(
      "chase-running-balance",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // --- One Chase checking account. A single linked account keeps the
    // account picker hidden, so the ledger resolves the snapshot's account.
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
        mask: "1111",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // --- 120 posted rows, newest first (seed index 0 is the newest). Never
    // after the household's today; never before the 1st of its month.
    const nowMs = Date.now();
    const today = householdDateOf(new Date(nowMs));
    const monthStart = `${today.slice(0, 8)}01`;
    const seeds: SeedRow[] = Array.from({ length: SEED_COUNT }, (_, i) => {
      const at = new Date(nowMs - 60_000 - i * STEP_MS);
      const day = householdDateOf(at);
      // Every 10th row (from the 4th) is a deposit; the rest are debits of
      // distinct odd-cent sizes so a swapped pair changes the chain.
      const amountCents = i % 10 === 3 ? 25_000 + i : -(1_234 + i * 107);
      return {
        occurredOn: day < monthStart ? monthStart : day,
        occurredAt: at.toISOString(),
        amountCents,
        ptx: `e2e-${suffix}-ptx-${String(i + 1).padStart(3, "0")}`,
        description: `CHASE BAL TEST ${suffix} #${String(i + 1).padStart(3, "0")}`,
      };
    });
    for (const s of seeds) {
      expect(s.occurredOn >= monthStart && s.occurredOn <= today).toBe(true);
    }
    const inserted = await db
      .insert(transactionsTable)
      .values(
        seeds.map((s) => ({
          userId,
          householdId,
          occurredOn: s.occurredOn,
          occurredAt: s.occurredAt,
          description: s.description,
          amount: centsString(s.amountCents),
          account: acct!.name,
          source: "plaid",
          plaidTransactionId: s.ptx,
          plaidAccountId: acct!.accountId,
        })),
      )
      .returning({
        id: transactionsTable.id,
        plaidTransactionId: transactionsTable.plaidTransactionId,
      });
    expect(inserted).toHaveLength(SEED_COUNT);
    const idByPtx = new Map(inserted.map((r) => [r.plaidTransactionId, r.id]));
    const seededIdsNewestFirst = seeds.map((s) => idByPtx.get(s.ptx)!);
    const seededCentsById = new Map(
      seeds.map((s) => [idByPtx.get(s.ptx)!, s.amountCents]),
    );

    // --- The bank snapshot, read now: after every seeded row happened, so it
    // holds them all and today's balance is exactly the snapshot's.
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: centsString(ANCHOR_CENTS),
      bankSnapshotAt: new Date(),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acct!.id,
      bankSnapshotName: acct!.name,
      bankSnapshotMask: acct!.mask,
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // Listen before navigating: the first register page is asked for on mount.
    const firstPagePromise = page.waitForResponse(
      isRegisterLedger(monthStart, null),
      { timeout: 90_000 },
    );
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const page1 = await readLedger(await firstPagePromise);

    const showing = page.getByTestId("chase-showing");
    await expect(showing).toHaveText(
      `Showing ${PAGE_SIZE} of ${SEED_COUNT} · ${SEED_COUNT} to review`,
      { timeout: 20_000 },
    );

    // --- The server's first page, before any DOM check.
    expect(page1.matchingCount).toBe(SEED_COUNT);
    expect(page1.review.unreviewed).toBe(SEED_COUNT);
    expect(page1.rows).toHaveLength(PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.balanceToday, "no balanceToday: the snapshot did not resolve").not.toBeNull();
    const balanceTodayCents = parseCents(page1.balanceToday!);
    expect(
      balanceTodayCents,
      "today's balance is the snapshot's (every seeded row happened before the read)",
    ).toBe(ANCHOR_CENTS);

    // The ledger's End figure for a range through today is today's balance.
    await expect(page.getByTestId("chase-stats-balance")).toContainText(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
        balanceTodayCents / 100,
      ),
      { timeout: 15_000 },
    );

    // --- Page 1: 50 rows.
    await assertRegisterMatches(page, page1.rows, balanceTodayCents);

    // --- Page 2: 100 rows, boundary 50/51.
    const loadMore = page.getByTestId("chase-load-more");
    await expect(loadMore).toBeEnabled({ timeout: 15_000 });
    const page2Promise = page.waitForResponse(
      isRegisterLedger(monthStart, page1.nextCursor),
      { timeout: 30_000 },
    );
    await loadMore.click();
    const page2 = await readLedger(await page2Promise);
    await expect(showing).toHaveText(
      `Showing ${2 * PAGE_SIZE} of ${SEED_COUNT} · ${SEED_COUNT} to review`,
      { timeout: 20_000 },
    );
    expect(page2.rows).toHaveLength(PAGE_SIZE);
    expect(page2.nextCursor).not.toBeNull();
    await assertRegisterMatches(
      page,
      [...page1.rows, ...page2.rows],
      balanceTodayCents,
    );

    // --- Page 3: all 120 rows, boundary 100/101, and no more pages.
    await expect(loadMore).toBeEnabled({ timeout: 15_000 });
    const page3Promise = page.waitForResponse(
      isRegisterLedger(monthStart, page2.nextCursor),
      { timeout: 30_000 },
    );
    await loadMore.click();
    const page3 = await readLedger(await page3Promise);
    await expect(showing).toHaveText(
      `Showing ${SEED_COUNT} of ${SEED_COUNT} · ${SEED_COUNT} to review`,
      { timeout: 20_000 },
    );
    expect(page3.rows).toHaveLength(SEED_COUNT - 2 * PAGE_SIZE);
    expect(page3.nextCursor).toBeNull();
    await expect(loadMore).toHaveCount(0);

    const allRows = [...page1.rows, ...page2.rows, ...page3.rows];

    // The server's pages tie to the seed: every seeded row once, newest first
    // (occurredOn desc, occurredAt desc), each counted at its seeded amount.
    expect(allRows.map((r) => r.id)).toEqual(seededIdsNewestFirst);
    for (const r of allRows) {
      expect(r.countsInBalance, `row ${r.id} does not count`).toBe(true);
      expect(r.balanceReason).toBe("counted");
      expect(parseCents(r.balanceAmount)).toBe(seededCentsById.get(r.id));
    }

    // --- Desktop (1280×800): every row, the chain across both page boundaries.
    await assertRegisterMatches(page, allRows, balanceTodayCents);
    await assertChipsLaidOut(page, allRows);

    // --- Mobile (390×844): same DOM nodes, stacked. A chip hidden or collapsed
    // at narrow widths, or a re-render that reorders rows, fails here.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByTestId(`text-running-balance-${allRows[0]!.id}`),
    ).toBeVisible({ timeout: 15_000 });
    await assertRegisterMatches(page, allRows, balanceTodayCents);
    await assertChipsLaidOut(page, allRows);

    await context.close();
  });
});
