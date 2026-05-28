import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * Regression coverage for task #773 (and the long tail #761/#767/#768
 * /#772 that all manifested the same way): on /amex with a single card
 * chip active, the bottom day-groups of the month were silently
 * disappearing because of cumulative virtualizer height-cache drift.
 *
 * #772 ripped the virtualizer out entirely and replaced it with a plain
 * `groups.map(...)`. Each rendered wrapper now carries
 * `data-day-group-key="YYYY-MM-DD"`, which makes the "did every group
 * actually render?" check a one-liner: grab the first and last seeded
 * day for the selected month, assert both attributes exist in the DOM
 * for every card chip, then click `<` to the prior month and re-assert.
 *
 * If anyone re-introduces virtualization (or any other "skip rendering
 * some groups" optimization) on this page and the bottom of the month
 * starts dropping again, this spec fails immediately instead of the bug
 * shipping to prod and being spotted by Brad scrolling the page.
 *
 * Seeding strategy mirrors `amex-card-chip-not-clipped.spec.ts` /
 * `amex-three-cards-aggregation.spec.ts`: `/api/transactions` doesn't
 * accept `plaidAccountId` directly, so we mock the four API surfaces
 * the page reads on first paint with three Amex cards (Blue Cash,
 * Delta Gold, Platinum) × 22 day-groups each, spread across the
 * currently-selected month AND the prior month so the month-navigation
 * arm of the test exercises the same render path.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const AMEX_ITEM_ROW_ID = "amex-item-row-773";
const AMEX_ITEM_EXTERNAL_ID = "item-amex-773";

const CARD_ROW_IDS = [
  "amex-acct-row-blue-773",
  "amex-acct-row-gold-773",
  "amex-acct-row-plat-773",
] as const;

const CARD_MASKS = ["1001", "2002", "3003"] as const;
const CARD_NAMES = ["Blue Cash", "Delta Gold", "Platinum"] as const;

const DEBT_ROW_IDS = [
  "debt-amex-blue-773",
  "debt-amex-gold-773",
  "debt-amex-plat-773",
] as const;

const DEBT_BALANCES = [400, 500, 750] as const;

// 22 day-groups per month per card comfortably clears the task's
// ~20-groups threshold and stays well below any plausible month length.
const SEEDED_DAYS = Array.from({ length: 22 }, (_, i) => i + 1);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function monthIso(year: number, month0: number): string {
  return `${year}-${pad2(month0 + 1)}-01`;
}

function dayIso(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

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
  notes: null;
  source: "plaid:amex";
  member: null;
  owedBy: null;
  plaidTransactionId: string;
  plaidAccountId: string;
  debtId: null;
  matchedRuleId: null;
};

function buildTxnsForMonth(
  year: number,
  month0: number,
  tag: string,
): MockTxn[] {
  const out: MockTxn[] = [];
  for (const day of SEEDED_DAYS) {
    const iso = dayIso(year, month0, day);
    for (let i = 0; i < CARD_ROW_IDS.length; i += 1) {
      out.push({
        id: `txn-${tag}-c${i}-d${pad2(day)}`,
        occurredOn: iso,
        occurredAt: `${iso}T${pad2(9 + i)}:00:00.000Z`,
        description: `E2E-773 ${CARD_NAMES[i]} ${tag} D${pad2(day)}`,
        amount: `${day + i}.00`,
        account: `${CARD_NAMES[i]} ··${CARD_MASKS[i]}`,
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
        plaidTransactionId: `txn-${tag}-c${i}-d${pad2(day)}-ext`,
        plaidAccountId: CARD_ROW_IDS[i],
        debtId: null,
        matchedRuleId: null,
      });
    }
  }
  return out;
}

test.describe("/amex renders every day-group of the month for every card chip (#773)", () => {
  test("top and bottom day-groups are present in the DOM for All + each card chip, in the selected month AND after clicking < to the prior month", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-month-bottom-renders-773",
      provisionedUserIds,
    );

    // Pin to a deterministic past month so the day count is fixed and
    // we never collide with the auto-scroll-to-today behaviour.
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const targetYear = target.getFullYear();
    const targetMonth0 = target.getMonth();
    const targetMonthIso = monthIso(targetYear, targetMonth0);

    const prior = new Date(targetYear, targetMonth0 - 1, 1);
    const priorYear = prior.getFullYear();
    const priorMonth0 = prior.getMonth();

    const debtUpdatedIso = `${targetYear}-${pad2(targetMonth0 + 1)}-28T23:00:00.000Z`;

    const txns = [
      ...buildTxnsForMonth(targetYear, targetMonth0, "target"),
      ...buildTxnsForMonth(priorYear, priorMonth0, "prior"),
    ];

    // --- /api/plaid/items: one Amex item, three card accounts. ---
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
              // Chip values key off `accountId`; reuse the row id so
              // the chip testid is predictable.
              accountId: id,
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

    // The Amex page issues several GETs against `/api/transactions`
    // with varying from/to/source params as the user navigates months.
    // The page filters by `monthScoped` client-side, so returning the
    // combined two-month payload to every variant satisfies both the
    // initial-paint and the post-`<` navigation arms of this test.
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

    await signInAndOpen(page, email, password, `/amex?month=${targetMonthIso}`);

    // Wait for the chip rail to render — proves all three cards were
    // picked up from the seeded plaidAccountId distribution and so the
    // per-chip filter assertions below have something to bite on.
    await expect(page.getByTestId("amex-card-pills")).toBeVisible({
      timeout: 20_000,
    });
    for (const id of CARD_ROW_IDS) {
      await expect(page.getByTestId(`button-card-filter-${id}`)).toBeVisible();
    }

    const chips: Array<{ label: string; testId: string }> = [
      { label: "All cards", testId: "button-card-filter-all" },
      ...CARD_ROW_IDS.map((id, i) => ({
        label: CARD_NAMES[i],
        testId: `button-card-filter-${id}`,
      })),
    ];

    async function assertTopAndBottomGroupsPresent(
      year: number,
      month0: number,
      monthLabel: string,
    ) {
      const firstKey = dayIso(year, month0, SEEDED_DAYS[0]);
      const lastKey = dayIso(
        year,
        month0,
        SEEDED_DAYS[SEEDED_DAYS.length - 1],
      );
      for (const chip of chips) {
        await page.getByTestId(chip.testId).click();
        // Wait until the page has settled on this chip: at least one
        // seeded day-group from the selected month is present. This
        // guards against asserting the attribute checks before the
        // client-side `monthScoped` filter has re-run.
        await expect(
          page.locator(`[data-day-group-key="${lastKey}"]`),
        ).toHaveCount(1, {
          timeout: 10_000,
        });
        // The earliest day-group of the month is the one that used to
        // disappear under #761/#767/#768. With #772's plain
        // `groups.map(...)` it must always be rendered.
        await expect(
          page.locator(`[data-day-group-key="${firstKey}"]`),
          `earliest day-group ${firstKey} should be in the DOM for chip "${chip.label}" in ${monthLabel}`,
        ).toHaveCount(1, { timeout: 10_000 });
        await expect(
          page.locator(`[data-day-group-key="${lastKey}"]`),
          `latest day-group ${lastKey} should be in the DOM for chip "${chip.label}" in ${monthLabel}`,
        ).toHaveCount(1);
      }
    }

    // --- Arm 1: the initially-selected target month. ---
    await assertTopAndBottomGroupsPresent(
      targetYear,
      targetMonth0,
      "target month",
    );

    // Reset to "All cards" before navigating so the prior-month arm
    // starts from a known chip state.
    await page.getByTestId("button-card-filter-all").click();

    // --- Arm 2: click `<` to the prior month and re-assert. ---
    await page.getByTestId("button-prev-month").click();
    await assertTopAndBottomGroupsPresent(
      priorYear,
      priorMonth0,
      "prior month",
    );
  });
});
