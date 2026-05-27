import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * Regression coverage for task #761.
 *
 * On /amex, selecting a single card chip (e.g. Delta Gold or Platinum)
 * used to clip the bottom of the transaction list — the oldest
 * day-groups of the selected month were silently unreachable no matter
 * how far the user scrolled. This is the same class of
 * `@tanstack/react-virtual` height-undershoot bug fixed under #744, but
 * the card-chip filter path was still affected because the
 * virtualizer's per-row measurement cache was not being invalidated
 * when the chip filter swapped one card's group set for another with a
 * matching `groups.length` and total row count.
 *
 * The fix threads a stable `measureKey` (composed of the card chip and
 * the selected month) into `VirtualizedDayGroups` and includes it in
 * the `virtualizer.measure()` dependency tuple, so switching chips
 * always resets the cached heights even when the upstream counts
 * coincide. This spec exercises every chip in turn and asserts the
 * oldest day-group of the selected month is reachable.
 *
 * Seeding strategy mirrors `amex-three-cards-aggregation.spec.ts`:
 * `/api/transactions` doesn't accept `plaidAccountId` directly, so we
 * mock the four API surfaces the page reads on first paint with two
 * Amex cards × many day-groups each. To reproduce the stale-cache
 * clip we deliberately make the two cards' rows shaped differently
 * (long description + notes vs short, one with `owedBy` set) so the
 * pre-fix cache would carry tall heights from one chip into a chip
 * with shorter rows (and vice-versa) and undershoot `getTotalSize()`.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const AMEX_ITEM_ROW_ID = "amex-item-row-761";
const AMEX_ITEM_EXTERNAL_ID = "item-amex-761";

const CARD_ROW_IDS = [
  "amex-acct-row-card-gold-761",
  "amex-acct-row-card-plat-761",
] as const;

const CARD_MASKS = ["1001", "2002"] as const;
const CARD_NAMES = ["Delta Gold", "Platinum"] as const;

const DEBT_ROW_IDS = [
  "debt-amex-gold-761",
  "debt-amex-plat-761",
] as const;

const DEBT_BALANCES = [500, 750] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatDayHeader(isoDate: string): string {
  // Matches `formatDayHeader` in
  // artifacts/h2budget/src/components/account-page/day-group.tsx so the
  // assertion below matches the exact text rendered in the DOM.
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function scrollToBottomUntil(page: Page, locator: ReturnType<Page["getByText"]>) {
  // Loop a few times because each scroll triggers `measureElement` on
  // newly rendered items, which updates `getTotalSize()` and unlocks
  // the next batch.
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" }),
    );
    await page.waitForTimeout(150);
    if (await locator.count()) return;
  }
}

test.describe("/amex card chip does not clip the bottom of the month (#761)", () => {
  test("every card chip (including all-cards and chip-to-chip transitions) reveals the oldest day-group of the selected month", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "amex-card-chip-not-clipped-761",
      provisionedUserIds,
    );

    // Fixed past month so the day count is deterministic and so we
    // never collide with auto-scroll-to-today behaviour.
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const year = target.getFullYear();
    const month0 = target.getMonth();
    const monthIso = `${year}-${pad2(month0 + 1)}-01`;
    const debtUpdatedIso = `${year}-${pad2(month0 + 1)}-28T23:00:00.000Z`;

    // Each card has a txn on every day from the 1st to the 25th. With
    // both cards present we get 25 day-groups each containing two
    // rows; per-chip we get 25 day-groups with one row each. The
    // pre-fix bug surfaced most reliably when the cached per-row
    // heights from a denser/taller chip leaked into a shorter chip.
    const SEEDED_DAYS = Array.from({ length: 25 }, (_, i) => i + 1);
    const oldestIso = `${year}-${pad2(month0 + 1)}-${pad2(SEEDED_DAYS[0])}`;
    const newestIso = `${year}-${pad2(month0 + 1)}-${pad2(
      SEEDED_DAYS[SEEDED_DAYS.length - 1],
    )}`;

    type MockTxn = {
      id: string;
      occurredOn: string;
      occurredAt: string;
      description: string;
      amount: string;
      account: string;
      categoryId: null;
      forecastFlag: false;
      weeklyAllowance: false;
      weeklyBucket: null;
      monthlyAllowance: false;
      unplannedAllowance: false;
      reimbursable: false;
      reimbursed: false;
      isTransfer: false;
      notes: string | null;
      source: "plaid:amex";
      member: string | null;
      owedBy: string | null;
      plaidTransactionId: string;
      plaidAccountId: string;
      debtId: null;
      matchedRuleId: null;
    };

    const txns: MockTxn[] = [];
    for (const day of SEEDED_DAYS) {
      const iso = `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
      // Card 0 (Delta Gold) — taller rows: long description, notes,
      // owedBy badge. These render bigger DOM heights.
      txns.push({
        id: `txn-gold-761-d${pad2(day)}`,
        occurredOn: iso,
        occurredAt: `${iso}T09:00:00.000Z`,
        description: `E2E-761 GOLD VERY LONG MERCHANT NAME WITH EXTRA TRAILING TEXT D${pad2(day)}`,
        amount: `${day}.00`,
        account: `Amex ··${CARD_MASKS[0]}`,
        categoryId: null,
        forecastFlag: false,
        weeklyAllowance: false,
        weeklyBucket: null,
        monthlyAllowance: false,
        unplannedAllowance: false,
        reimbursable: false,
        reimbursed: false,
        isTransfer: false,
        notes: `Note for D${pad2(day)} — second line that adds height`,
        source: "plaid:amex",
        member: null,
        owedBy: "Spouse",
        plaidTransactionId: `txn-gold-761-d${pad2(day)}-ext`,
        plaidAccountId: CARD_ROW_IDS[0],
        debtId: null,
        matchedRuleId: null,
      });
      // Card 1 (Platinum) — shorter rows: short description, no notes,
      // no owedBy. Pre-fix, switching from Gold's taller cached
      // heights into Platinum (or vice-versa) would undershoot.
      txns.push({
        id: `txn-plat-761-d${pad2(day)}`,
        occurredOn: iso,
        occurredAt: `${iso}T10:00:00.000Z`,
        description: `E2E-761 PLAT D${pad2(day)}`,
        amount: `${day + 1}.00`,
        account: `Amex ··${CARD_MASKS[1]}`,
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
        source: "plaid:amex",
        member: null,
        owedBy: null,
        plaidTransactionId: `txn-plat-761-d${pad2(day)}-ext`,
        plaidAccountId: CARD_ROW_IDS[1],
        debtId: null,
        matchedRuleId: null,
      });
    }

    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
    });
    const page = await context.newPage();

    // --- /api/plaid/items: one Amex item, two card accounts. ---
    await page.route("**/api/plaid/items", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: AMEX_ITEM_ROW_ID,
            itemId: AMEX_ITEM_EXTERNAL_ID,
            institutionId: "ins_amex",
            institutionName: "American Express",
            institutionSlug: "amex",
            lastSyncedAt: debtUpdatedIso,
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparing: false,
            accounts: CARD_ROW_IDS.map((id, i) => ({
              id,
              accountId: id, // chip values key off this; reuse the row id
              name: CARD_NAMES[i],
              mask: CARD_MASKS[i],
              type: "credit",
              subtype: "credit card",
            })),
          },
        ]),
      });
    });

    await page.route("**/api/debts", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          DEBT_ROW_IDS.map((id, i) => ({
            id,
            name: `${CARD_NAMES[i]} ··${CARD_MASKS[i]}`,
            balance: DEBT_BALANCES[i].toFixed(2),
            apr: "0.1999",
            minPayment: "25.00",
            dueDay: 15,
            status: "active",
            sortOrder: i + 1,
            originalBalance: DEBT_BALANCES[i].toFixed(2),
            balanceSource: "plaid",
            minPaymentSource: "plaid",
            plaidAccountId: CARD_ROW_IDS[i],
            plaidLastSyncedAt: debtUpdatedIso,
            lastBalanceUpdate: debtUpdatedIso,
            plaidLastSyncError: null,
            plaidLastSyncErrorCode: null,
            consentExpirationAt: null,
            consentExpirationLastRefreshError: null,
            pendingPayment: null,
          })),
        ),
      });
    });

    await page.route("**/api/transactions**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(txns),
      });
    });

    await page.route("**/api/amex/anchor**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          amexEndingBalance: null,
          asOf: new Date(0).toISOString(),
          source: "missing",
        }),
      });
    });

    await signInAndOpen(page, email, password, `/amex?month=${monthIso}`);

    // Wait for the chip rail to render (proves two cards were picked
    // up from the seeded plaidAccountId distribution).
    await expect(page.getByTestId("amex-card-pills")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("button-card-filter-all")).toBeVisible();
    await expect(
      page.getByTestId(`button-card-filter-${CARD_ROW_IDS[0]}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`button-card-filter-${CARD_ROW_IDS[1]}`),
    ).toBeVisible();

    const oldestHeader = page
      .getByText(formatDayHeader(oldestIso), { exact: false })
      .first();
    const newestHeader = page
      .getByText(formatDayHeader(newestIso), { exact: false })
      .first();

    // Exercise an order that covers all-cards → each chip AND every
    // chip-to-chip transition. The pre-fix bug surfaced asymmetrically
    // depending on which chip's taller cache leaked into the next.
    const visitOrder: string[] = [
      "all",
      CARD_ROW_IDS[0],
      CARD_ROW_IDS[1],
      CARD_ROW_IDS[0],
      "all",
      CARD_ROW_IDS[1],
      "all",
    ];

    for (const chip of visitOrder) {
      const testId =
        chip === "all" ? "button-card-filter-all" : `button-card-filter-${chip}`;
      await page.getByTestId(testId).click();
      // The newest day's header should always be reachable first.
      await expect(newestHeader).toBeVisible({ timeout: 10_000 });
      // Scroll all the way down so the virtualizer is asked to reveal
      // the oldest day-groups of the selected month.
      await scrollToBottomUntil(page, oldestHeader);
      // The oldest seeded day-group must be present in the DOM after
      // scrolling. Pre-fix, switching chips left stale per-row heights
      // in the virtualizer's cache and `getTotalSize()` undershot the
      // real scroll height, silently trimming the bottom of the month.
      await expect(
        oldestHeader,
        `oldest day-group should be reachable after selecting chip "${chip}"`,
      ).toBeVisible({ timeout: 10_000 });
      // Scroll back to top before switching chips so the next chip
      // starts from a comparable initial scroll position.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
      await page.waitForTimeout(100);
    }

    await context.close();
  });
});
