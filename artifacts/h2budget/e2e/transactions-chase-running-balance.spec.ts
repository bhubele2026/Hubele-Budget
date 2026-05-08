import { test, expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
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
} from "./helpers/clerk";

/**
 * End-to-end coverage for the Chase Transactions page's per-row
 * register-style "bal $X" running balance (task #393, follow-up to
 * #341 which added the parallel coverage on /amex). The Chase view
 * renders the same per-row running balance via the same canonical
 * helpers (`computeRunningBalances`, `compareNewestFirst`) as the
 * Amex view, so a refactor of those shared helpers could silently
 * break Chase's running balance even though /amex is now covered.
 *
 * Strategy mirrors `amex-running-balance.spec.ts`:
 *   1. Provision a fresh user; link a single Chase checking account
 *      via direct DB seed and anchor a manual bank snapshot to it
 *      (current month, so endingBalance == anchor with no roll).
 *   2. Mock GET /api/transactions to return four same-day Chase
 *      rows on today's date with distinct `occurredAt` timestamps
 *      so the canonical newest-first comparator orders them
 *      deterministically (no id-tiebreaker reliance). Mix debits
 *      (negative amounts) and a credit (positive amount) to
 *      exercise both walk directions.
 *   3. Stub /api/seed/april-chase so the page's on-mount April
 *      seed is a no-op against our fixture.
 *   4. Open /transactions, wait for the ending balance chip to
 *      populate to the anchor value, then walk the per-row
 *      `text-running-balance-${id}` chips and assert:
 *        - Newest row's "bal" exactly equals the ending balance chip.
 *        - Walking newest → oldest, each next row's balance equals
 *          `prev_bal − prev_row_amount` (the canonical recurrence
 *          used by `computeRunningBalances`).
 *      That single recurrence covers both monotonicity for debits
 *      (balance walks back up as we look further back) and the
 *      reverse for credits.
 *   5. Re-run the per-row read at a desktop viewport (1280×800)
 *      AND a mobile viewport (390×844). Unlike /amex which renders
 *      two physically separate DOM trees (`md:hidden` /
 *      `hidden md:block`), the Chase row uses a single DOM node
 *      that re-flows responsively (`flex-col md:flex-row`), so the
 *      "dual layout" coverage is a viewport sweep against the same
 *      rendered chips.
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

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

// Parses "bal $1,234.56" → 1234.56. Strips the leading "bal " prefix
// the chip wraps each value in, then strips currency formatting.
function parseBalText(text: string): number {
  const m = text.match(/-?\$?[\d,]+(?:\.\d+)?/);
  if (!m) throw new Error(`could not parse running-balance text: "${text}"`);
  return Number(m[0].replace(/[$,]/g, ""));
}

type Seeded = {
  id: string;
  description: string;
  // Signed amount as the running-balance recurrence sees it (matches
  // what the page stores in `t.amount` and feeds to
  // `computeRunningBalances`).
  amount: number;
};

async function readPerRowBalances(
  page: Page,
  expected: ReadonlyArray<{ id: string; bal: number }>,
  anchorBalance: number,
  amountById: ReadonlyMap<string, number>,
): Promise<void> {
  // Per-id assertion: each row's chip text matches the canonical
  // computed value to the cent.
  for (const e of expected) {
    const chip = page.getByTestId(`text-running-balance-${e.id}`);
    await expect(chip).toBeVisible({ timeout: 15_000 });
    const text = (await chip.textContent()) ?? "";
    expect(parseBalText(text)).toBeCloseTo(e.bal, 2);
  }

  // Final reconciliation: the newest row's displayed running balance
  // text contains the anchor value (== ending balance chip).
  const newestText =
    (await page
      .getByTestId(`text-running-balance-${expected[0].id}`)
      .textContent()) ?? "";
  expect(newestText).toContain(fmtCurrency(anchorBalance));

  // DOM-order monotonicity check. The per-id assertions above pin the
  // computed values, but a regression in the day-group sort
  // (`groups.map`) or the per-day `sort(compareNewestFirst)` could
  // leave the values correct in the map yet render them out of order
  // on screen. Walk the running-balance chips in their actual DOM
  // order and assert that consecutive rows obey the canonical
  // recurrence
  //   nextBal === prevBal − prevRowAmount.
  // A single failure here means the rendered list is not in
  // newest-first order even if `computeRunningBalances` is.
  const renderedBalLocators = page.locator(
    '[data-testid^="text-running-balance-"]',
  );
  await expect(renderedBalLocators).toHaveCount(expected.length, {
    timeout: 15_000,
  });
  const renderedHandles = await renderedBalLocators.elementHandles();
  let prevBal: number | null = null;
  let prevRowAmount: number | null = null;
  for (const handle of renderedHandles) {
    const testId = (await handle.getAttribute("data-testid")) ?? "";
    const id = testId.replace(/^text-running-balance-/, "");
    const text = (await handle.textContent()) ?? "";
    const bal = parseBalText(text);
    if (prevBal !== null && prevRowAmount !== null) {
      const expectedNext = Math.round((prevBal - prevRowAmount) * 100) / 100;
      expect(bal).toBeCloseTo(expectedNext, 2);
    } else {
      // First rendered row must reconcile to the anchor — pins
      // newest-first ordering of the day group itself.
      expect(bal).toBeCloseTo(anchorBalance, 2);
    }
    const amt = amountById.get(id);
    expect(amt, `unexpected row id rendered: ${id}`).not.toBeUndefined();
    prevBal = bal;
    prevRowAmount = amt!;
  }
}

test.describe("Chase Transactions page — per-row running balance (#393)", () => {
  test("running balances are monotonic newest→oldest and reconcile to the ending balance chip across desktop and mobile viewports", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "chase-running-balance",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // --- Direct DB seed: one Chase checking account that owns the
    // bank snapshot anchor. A single linked account keeps the
    // chase-account-picker hidden so the running-balance chips are
    // the only thing under test.
    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
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
        itemId: item.id,
        accountId: `e2e-acct-${suffix}`,
        name: "Total Checking",
        mask: "1111",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor balance: pick a round value so manual cross-check is
    // easy. Anchor month == current month, so endingBalance ==
    // anchor with no roll-forward / roll-backward via
    // netChangeByMonth.
    const anchorBalance = 5000;
    await db.insert(forecastSettingsTable).values({
      userId,
      bankSnapshotBalance: anchorBalance.toFixed(2),
      bankSnapshotAt: new Date(),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acct.id,
      bankSnapshotName: acct.name,
      bankSnapshotMask: acct.mask,
    });

    // Seed four same-day Chase transactions with explicit occurredAt
    // timestamps so the canonical comparator orders them
    // deterministically (newest occurredAt first, with the credit
    // last). Debits are negative (money out of checking), the credit
    // is positive (money in). Sums to zero so the post-walk balance
    // returns to the anchor.
    const today = todayIso();
    type SeedSpec = {
      description: string;
      amount: string;
      at: string;
      ptx: string;
    };
    const seedSpecs: SeedSpec[] = [
      {
        description: `CHASE BAL TEST ${suffix} — STARBUCKS NEWEST`,
        amount: "-50.00",
        at: `${today}T18:00:00.000Z`,
        ptx: `e2e-${suffix}-ptx-1`,
      },
      {
        description: `CHASE BAL TEST ${suffix} — TRADER JOES`,
        amount: "-30.00",
        at: `${today}T15:00:00.000Z`,
        ptx: `e2e-${suffix}-ptx-2`,
      },
      {
        description: `CHASE BAL TEST ${suffix} — UBER`,
        amount: "-20.00",
        at: `${today}T12:00:00.000Z`,
        ptx: `e2e-${suffix}-ptx-3`,
      },
      {
        description: `CHASE BAL TEST ${suffix} — REFUND CREDIT`,
        amount: "100.00",
        at: `${today}T09:00:00.000Z`,
        ptx: `e2e-${suffix}-ptx-4`,
      },
    ];

    // Deterministic UUID-shaped ids so the network mock and the
    // per-row testid assertions agree without needing to round-trip
    // POST /api/transactions.
    const seeded: Seeded[] = seedSpecs.map((s, i) => ({
      id: `00000000-0000-4000-8000-${suffix}0000000${i + 1}`,
      description: s.description,
      amount: Number(s.amount),
    }));

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // Mock GET /api/transactions to return our fixture rows on the
    // snapshot account. The page's `scopeChaseTransactions` filters
    // by `plaidAccountId === acct.accountId`, so we tag every row
    // with that external account id.
    await page.route("**/api/transactions**", async (route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.continue();
        return;
      }
      const rows = seedSpecs.map((s, i) => ({
        id: seeded[i].id,
        occurredOn: today,
        occurredAt: s.at,
        description: s.description,
        amount: s.amount,
        account: acct.name,
        categoryId: null,
        forecastFlag: false,
        weeklyAllowance: false,
        weeklyBucket: null,
        monthlyAllowance: false,
        unplannedAllowance: false,
        reimbursable: false,
        reimbursed: false,
        isTransfer: false,
        notes: null,
        source: "plaid",
        member: null,
        owedBy: null,
        plaidTransactionId: s.ptx,
        plaidAccountId: acct.accountId,
        debtId: null,
        matchedRuleId: null,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      });
    });

    // Suppress the on-mount April 2026 Chase seed. The page fires
    // `useSeedAprilChase` on every initial load, which would happily
    // insert ~95 real April rows into our snapshot account. The
    // listTransactions mock above already shields the page from that
    // pollution, but stubbing the seed too keeps the test a no-op
    // against the seed's repair logic.
    await page.route("**/api/seed/april-chase", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          alreadySeeded: true,
          inserted: 0,
          skipped: 0,
          categorized: 0,
          transfers: 0,
          rulesAdded: 0,
          endingBalance: anchorBalance.toFixed(2),
          syntheticAccount: false,
          accountId: acct.accountId,
          snapshotRepaired: false,
        }),
      });
    });

    await signInAndOpen(page, email, password, "/transactions");
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Ending balance chip populates to the anchor value (current
    // month's ending balance == anchor since there's no future
    // rollforward and the seeded rows all sit on today).
    const tile = page.getByTestId("stat-ending-balance");
    const expectedAnchorText = fmtCurrency(anchorBalance);
    await expect(tile).toContainText(expectedAnchorText, { timeout: 15_000 });

    // Determine newest→oldest order via the seeds' occurredAt: spec
    // is already in descending-time order, so seeded[] is exactly
    // the order the comparator should produce. Compute the expected
    // running balance for each row using the canonical recurrence:
    //   bal[0] = anchor, bal[i] = bal[i-1] - amount[i-1].
    const expected: Array<{ id: string; bal: number }> = [];
    let bal = Math.round(anchorBalance * 100) / 100;
    for (let i = 0; i < seeded.length; i += 1) {
      expected.push({ id: seeded[i].id, bal });
      bal = Math.round((bal - seeded[i].amount) * 100) / 100;
    }

    // First row's balance must reconcile to the chip.
    expect(fmtCurrency(expected[0].bal)).toBe(expectedAnchorText);

    // Sanity: monotonic-up across the three debits (each older row's
    // balance is HIGHER than the newer one's because looking further
    // back undoes the spend), then back down after the credit.
    // Locks the per-row recurrence's directionality on Chase's
    // negative-debit / positive-credit sign convention.
    expect(expected[0].bal).toBeLessThan(expected[1].bal);
    expect(expected[1].bal).toBeLessThan(expected[2].bal);
    expect(expected[2].bal).toBeLessThan(expected[3].bal);
    expect(expected[3].bal).toBeGreaterThan(expected[0].bal);
    // After applying the +$100 credit to the oldest row's incoming
    // balance, we land back at the anchor (debits 50+30+20 = 100).
    const finalBal =
      Math.round((expected[3].bal - seeded[3].amount) * 100) / 100;
    expect(finalBal).toBe(anchorBalance);

    const amountById = new Map(seeded.map((s) => [s.id, s.amount]));

    // --- Desktop viewport (1280×800) — `flex-col md:flex-row`
    // collapses to the horizontal row layout.
    await readPerRowBalances(page, expected, anchorBalance, amountById);

    // --- Mobile viewport (390×844) — same DOM node, restyled to a
    // stacked column layout. A regression in the responsive layout
    // (e.g. accidentally hiding the chip at narrow widths) would
    // surface here as a missing/invisible chip.
    await page.setViewportSize({ width: 390, height: 844 });
    // Re-query after the resize so any deferred layout reflows have
    // a chance to settle before we read the chips again.
    await expect(
      page.getByTestId(`text-running-balance-${expected[0].id}`),
    ).toBeVisible({ timeout: 15_000 });
    await readPerRowBalances(page, expected, anchorBalance, amountById);

    await context.close();
  });
});
