import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * Regression coverage for task #774 — the Chase analogue of the
 * /amex bottom-of-the-month regression locked in by #773 (and the
 * long tail #761/#767/#768/#772 that all manifested the same way).
 *
 * The Chase Transactions page (`/transactions`) renders its month
 * register with the same DayGroup pattern as /amex, and has its own
 * per-account picker (`select-chase-account`). It is therefore
 * vulnerable to the same class of optimization regression — anyone
 * re-introducing a virtualizer, height-cache, or "skip rendering
 * off-screen groups" optimization could silently start clipping the
 * earliest day-group of the month for some picker option without
 * the rest of the page noticing.
 *
 * Strategy mirrors `amex-month-bottom-renders.spec.ts`: seed ~22
 * day-groups per month across two Chase checking accounts plus a
 * manual (no plaidAccountId) account so the picker has three real
 * options, mount the page on a deterministic past month, and for
 * each picker option assert BOTH the earliest and latest day-group
 * of the month are present in the DOM via `data-day-group-key`.
 * Also exercises the `button-prev-month` navigation arm.
 *
 * If the Chase DayGroup wrapper ever loses the
 * `data-day-group-key="YYYY-MM-DD"` attribute, or any future
 * optimization causes a group to be omitted from the DOM, this
 * spec fails immediately instead of the bug shipping to prod.
 *
 * Seeding strategy: same mock-the-payload approach as
 * `chase-relink-duplicate-no-double-balance.spec.ts`. The Chase
 * page reads transactions via `useListTransactions({ limit: 5000 })`
 * (no server-side month scope — the client filters by
 * `compareMonth(monthKeyFromISO(t.occurredOn), selectedMonth)`), so
 * a single mocked payload covers both the initial-paint and the
 * post-`<` navigation arms. `/api/forecast` provides the
 * `plaidCheckingAccounts` the picker enumerates and the
 * `bankSnapshot` anchor used by the ending-balance tile.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const CHASE_ITEM_ROW_ID = "chase-item-row-774";
const CHASE_ITEM_EXTERNAL_ID = "item-chase-774";

const ACCT_ROW_IDS = [
  "chase-acct-row-A-774",
  "chase-acct-row-B-774",
] as const;
const ACCT_NAMES = ["Total Checking", "Joint Checking"] as const;
const ACCT_MASKS = ["1111", "2222"] as const;
const ACCT_EXTERNAL_IDS = ACCT_ROW_IDS.map(
  (_, i) => `${CHASE_ITEM_EXTERNAL_ID}-acct-${ACCT_MASKS[i]}`,
);

// 22 day-groups per month per account comfortably clears the
// task's ~20-groups threshold and stays well below any plausible
// month length.
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
  source: "plaid:chase" | "manual";
  member: null;
  owedBy: null;
  plaidTransactionId: string | null;
  plaidAccountId: string | null;
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
    // One row per Plaid checking account so each picker option has
    // a populated day-group on this day.
    for (let i = 0; i < ACCT_ROW_IDS.length; i += 1) {
      out.push({
        id: `txn-${tag}-a${i}-d${pad2(day)}`,
        occurredOn: iso,
        occurredAt: `${iso}T${pad2(9 + i)}:00:00.000Z`,
        description: `E2E-774 ${ACCT_NAMES[i]} ${tag} D${pad2(day)}`,
        amount: `${day + i}.00`,
        account: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
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
        source: "plaid:chase",
        member: null,
        owedBy: null,
        plaidTransactionId: `txn-${tag}-a${i}-d${pad2(day)}-ext`,
        plaidAccountId: ACCT_EXTERNAL_IDS[i],
        debtId: null,
        matchedRuleId: null,
      });
    }
    // One Manual-entry row (no plaidAccountId, chase-fallback source)
    // so the "Manual entries" picker option qualifies under
    // `shouldShowManualPickerOption` AND has its own per-day row.
    out.push({
      id: `txn-${tag}-manual-d${pad2(day)}`,
      occurredOn: iso,
      occurredAt: `${iso}T11:00:00.000Z`,
      description: `E2E-774 Manual ${tag} D${pad2(day)}`,
      amount: `${day}.50`,
      account: "Manual",
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
      source: "manual",
      member: null,
      owedBy: null,
      plaidTransactionId: null,
      plaidAccountId: null,
      debtId: null,
      matchedRuleId: null,
    });
  }
  return out;
}

test.describe("/transactions renders every day-group of the month for every account picker option (#774)", () => {
  test("top and bottom day-groups are present in the DOM for each picker option, in the selected month AND after clicking < to the prior month", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "chase-month-bottom-renders-774",
      provisionedUserIds,
    );

    // Pin to a deterministic past month so the day count is fixed and
    // we never collide with auto-jump-to-most-recent behaviour.
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const targetYear = target.getFullYear();
    const targetMonth0 = target.getMonth();
    const targetMonthIso = monthIso(targetYear, targetMonth0);

    const prior = new Date(targetYear, targetMonth0 - 1, 1);
    const priorYear = prior.getFullYear();
    const priorMonth0 = prior.getMonth();

    const snapshotAt = `${targetYear}-${pad2(targetMonth0 + 1)}-28T12:00:00.000Z`;

    const txns = [
      ...buildTxnsForMonth(targetYear, targetMonth0, "target"),
      ...buildTxnsForMonth(priorYear, priorMonth0, "prior"),
    ];

    // --- /api/plaid/items: one Chase item, two checking accounts. ---
    await page.route("**/api/plaid/items", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: CHASE_ITEM_ROW_ID,
            itemId: CHASE_ITEM_EXTERNAL_ID,
            institutionId: "ins_chase",
            institutionName: "Chase",
            institutionSlug: "chase",
            lastSyncedAt: snapshotAt,
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparing: false,
            accounts: ACCT_ROW_IDS.map((id, i) => ({
              id,
              accountId: ACCT_EXTERNAL_IDS[i],
              name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
              mask: ACCT_MASKS[i],
              type: "depository",
              subtype: "checking",
            })),
          },
        ]),
      });
    });

    // --- /api/forecast: bundle the picker enumerates over plus the
    //     bankSnapshot anchor used by the Starting/Ending tiles.
    await page.route("**/api/forecast**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") return route.fallback();
      if (!/\/api\/forecast(?:\?|$)/.test(url.pathname + url.search)) {
        return route.fallback();
      }
      const plaidCheckingAccounts = ACCT_ROW_IDS.map((id, i) => ({
        id,
        accountId: ACCT_EXTERNAL_IDS[i],
        name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
        mask: ACCT_MASKS[i],
        subtype: "checking",
        institutionName: "Chase",
      }));
      const accountSnapshots: Record<
        string,
        {
          balance: string;
          at: string;
          source: "plaid" | "manual";
          name: string | null;
          mask: string | null;
        }
      > = {};
      ACCT_ROW_IDS.forEach((id, i) => {
        accountSnapshots[id] = {
          balance: (1000 + i * 100).toFixed(2),
          at: snapshotAt,
          source: "plaid",
          name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
          mask: ACCT_MASKS[i],
        };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          fromDate: targetMonthIso,
          toDate: targetMonthIso,
          events: [],
          transactions: [],
          resolutions: [],
          closedMonths: [],
          settings: {},
          bankSnapshot: {
            balance: "1000.00",
            at: snapshotAt,
            source: "plaid",
            accountId: ACCT_ROW_IDS[0],
            name: `${ACCT_NAMES[0]} ··${ACCT_MASKS[0]}`,
            mask: ACCT_MASKS[0],
          },
          cashSignal: null,
          plaidCheckingAccounts,
          monthSnapshots: {},
          accountSnapshots,
        }),
      });
    });

    // Chase page issues `useListTransactions({ limit: 5000 })` with no
    // server-side month scope — return the combined two-month payload
    // for every GET so both the initial-paint and post-`<` navigation
    // arms see the same activity set.
    await page.route("**/api/transactions**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(txns),
      });
    });

    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${targetMonthIso}`,
    );

    // Wait for the picker to render — proves both Plaid checking
    // accounts (and Manual, since we seeded a manual row) showed up
    // so the per-option assertions below have something to bite on.
    const trigger = page.getByTestId("select-chase-account");
    await expect(trigger).toBeVisible({ timeout: 20_000 });

    type PickerOption = { label: string; value: string };
    const options: PickerOption[] = [
      ...ACCT_ROW_IDS.map((id, i) => ({
        label: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
        value: id,
      })),
      { label: "Manual entries", value: "manual" },
    ];

    async function selectPickerOption(value: string) {
      await trigger.click();
      const opt = page.getByTestId(`option-chase-account-${value}`);
      await expect(opt).toBeVisible({ timeout: 10_000 });
      await opt.click();
    }

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
      for (const opt of options) {
        await selectPickerOption(opt.value);
        // Wait until the page has settled on this picker option: at
        // least one seeded day-group from the selected month is
        // present. Guards against asserting the attribute checks
        // before the client-side month/account filter has re-run.
        await expect(
          page.locator(`[data-day-group-key="${lastKey}"]`),
        ).toHaveCount(1, { timeout: 10_000 });
        // The earliest day-group of the month is the one that used
        // to disappear on the Amex page under #761/#767/#768. The
        // Chase DayGroup list must always render it.
        await expect(
          page.locator(`[data-day-group-key="${firstKey}"]`),
          `earliest day-group ${firstKey} should be in the DOM for picker option "${opt.label}" in ${monthLabel}`,
        ).toHaveCount(1, { timeout: 10_000 });
        await expect(
          page.locator(`[data-day-group-key="${lastKey}"]`),
          `latest day-group ${lastKey} should be in the DOM for picker option "${opt.label}" in ${monthLabel}`,
        ).toHaveCount(1);
      }
    }

    // --- Arm 1: the initially-selected target month. ---
    await assertTopAndBottomGroupsPresent(
      targetYear,
      targetMonth0,
      "target month",
    );

    // Reset to the first real Plaid account before navigating so the
    // prior-month arm starts from a known picker state.
    await selectPickerOption(ACCT_ROW_IDS[0]);

    // --- Arm 2: click `<` to the prior month and re-assert. ---
    await page.getByTestId("button-prev-month").click();
    await assertTopAndBottomGroupsPresent(
      priorYear,
      priorMonth0,
      "prior month",
    );
  });
});
