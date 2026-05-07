import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the brief mid-re-link window on the Chase
 * Transactions page (task #450, Chase analogue of #442 / amex-relink-
 * duplicate-no-double-balance.spec.ts).
 *
 * Scenario: the user already has three Chase checking accounts under
 * one Plaid item (three `plaid_accounts` rows, one per-account snapshot
 * each, plus the primary `bankSnapshot` anchored at account A). They
 * re-link the same Chase login. For a brief window before
 * `dedupePlaidAccountsForUser` collapses the new rows onto the existing
 * survivors, the server can return *four* rows for that login: the
 * three original survivors plus one duplicate row for account A (same
 * institution + mask, different `id`). If a per-account snapshot entry
 * happens to land keyed by the duplicate row id, `/api/forecast`
 * temporarily returns four `plaidCheckingAccounts` plus a four-entry
 * `accountSnapshots` map: three real + one duplicate-mask.
 *
 * Regression class we lock in: the page's Ending Balance tile must NOT
 * inflate when the duplicate row is present. The snapshot account (A)
 * resolves through `deriveEffectiveSnapshot` path #1 — `bankSnapshot`
 * — and must show A's anchored balance ($1,000), not $2,000 (which it
 * would show if the duplicate's per-account entry were summed in).
 * Each of the three real accounts continues to show its own snapshot
 * value across both phases (sum across the three real accounts is
 * preserved at $1,800 = $1,000 + $500 + $300, never inflated to
 * $2,800 by the duplicate-A entry).
 *
 * Seeding strategy: same mock-the-payload approach as the Amex spec.
 * We mutate the mocked `/api/forecast` response between the duplicate
 * phase and the post-dedupe phase via a flip flag, and force a refetch
 * by reloading the page (the same React Query invalidation pattern the
 * Amex spec uses).
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const CHASE_ITEM_ROW_ID = "chase-item-row-relink";
const CHASE_ITEM_EXTERNAL_ID = "item-chase-relink";

const ACCT_ROW_IDS = [
  "chase-acct-row-A",
  "chase-acct-row-B",
  "chase-acct-row-C",
] as const;

const ACCT_NAMES = ["Total Checking", "Joint Checking", "Savings"] as const;
const ACCT_MASKS = ["1111", "2222", "3333"] as const;
const ACCT_BALANCES = [1000, 500, 300] as const; // sum: 1800

// The duplicate's plaid_accounts row id — a *different* uuid for the
// *same physical account A* (mask 1111). This is the shape the brief
// mid-re-link window produces before `dedupePlaidAccountsForUser`
// collapses (institutionName, mask) groups onto a single survivor.
const DUP_ACCT_ROW_ID = "chase-acct-row-A-DUP";
const DUP_ACCT_BALANCE = 1000; // would inflate A's tile to 2000 if summed

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function thisMonthStart(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

test.describe("Chase page — re-link duplicate window doesn't double Ending Balance (#450)", () => {
  test("with a duplicate-mask Chase account landing during re-link, the Ending Balance tile equals the snapshot account's anchored balance (not double), and each of the three real accounts shows its own snapshot value in both phases", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "chase-relink-dup",
      provisionedUserIds,
    );

    const today = todayIso();
    const monthStart = thisMonthStart();
    // Anchor the snapshot at noon today so anchorMonth == selectedMonth
    // (current month) and end-of-month equals the snapshot value
    // exactly — no transactions are seeded so there is no post-anchor
    // net change to factor in.
    const snapshotAt = `${today}T12:00:00.000Z`;

    // Phase flag: when true, `/api/forecast` returns four
    // plaidCheckingAccounts (three real + one duplicate-mask) and a
    // four-entry accountSnapshots map. When false, three accounts
    // and a three-entry map (post-dedupe steady state).
    let duplicatePhase = true;
    // Track every served `/api/forecast` GET so Phase 2 can prove a
    // second fetch actually happened against the now-three-account
    // mock (otherwise an "unchanged tile" assertion could pass
    // vacuously if React Query never refetched).
    let forecastRequestCount = 0;

    // --- /api/plaid/items: one Chase item, three or four checking
    //     accounts depending on the phase. The Chase page reads this
    //     via useListPlaidItems to scope sync errors to the viewed
    //     account, so it must reflect the same shape as
    //     plaidCheckingAccounts for the relevant-item lookup to land.
    await page.route("**/api/plaid/items", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const realAccounts = ACCT_ROW_IDS.map((id, i) => ({
        id,
        accountId: `${CHASE_ITEM_EXTERNAL_ID}-acct-${ACCT_MASKS[i]}`,
        name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
        mask: ACCT_MASKS[i],
        type: "depository",
        subtype: i === 2 ? "savings" : "checking",
      }));
      const duplicateAccount = {
        id: DUP_ACCT_ROW_ID,
        accountId: `${CHASE_ITEM_EXTERNAL_ID}-acct-${ACCT_MASKS[0]}-DUP`,
        name: `${ACCT_NAMES[0]} ··${ACCT_MASKS[0]}`,
        mask: ACCT_MASKS[0],
        type: "depository",
        subtype: "checking",
      };
      const accounts = duplicatePhase
        ? [...realAccounts, duplicateAccount]
        : realAccounts;
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
            accounts,
          },
        ]),
      });
    });

    // --- /api/forecast: bundle with bankSnapshot anchored at A,
    //     plaidCheckingAccounts (3 or 4), and accountSnapshots map
    //     (3 or 4 entries). The duplicate entry is keyed by
    //     DUP_ACCT_ROW_ID with the same balance as A — exactly the
    //     mid-re-link shape that would inflate A's tile to $2,000
    //     if any aggregation summed both A and A_dup snapshot
    //     entries.
    await page.route("**/api/forecast**", async (route) => {
      // Sub-paths like /forecast/refresh-bank, /forecast/cash-signal,
      // /forecast/settings have their own handlers — only intercept
      // the main GET /api/forecast (with optional ?days=) here.
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") return route.fallback();
      if (!/\/api\/forecast(?:\?|$)/.test(url.pathname + url.search)) {
        return route.fallback();
      }
      forecastRequestCount += 1;

      const realCheckingAccounts = ACCT_ROW_IDS.map((id, i) => ({
        id,
        accountId: `${CHASE_ITEM_EXTERNAL_ID}-acct-${ACCT_MASKS[i]}`,
        name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
        mask: ACCT_MASKS[i],
        subtype: i === 2 ? "savings" : "checking",
        institutionName: "Chase",
      }));
      const duplicateChecking = {
        id: DUP_ACCT_ROW_ID,
        accountId: `${CHASE_ITEM_EXTERNAL_ID}-acct-${ACCT_MASKS[0]}-DUP`,
        name: `${ACCT_NAMES[0]} ··${ACCT_MASKS[0]}`,
        mask: ACCT_MASKS[0],
        subtype: "checking",
        institutionName: "Chase",
      };
      const plaidCheckingAccounts = duplicatePhase
        ? [...realCheckingAccounts, duplicateChecking]
        : realCheckingAccounts;

      const realSnapshots: Record<
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
        realSnapshots[id] = {
          balance: ACCT_BALANCES[i].toFixed(2),
          at: snapshotAt,
          source: "plaid",
          name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
          mask: ACCT_MASKS[i],
        };
      });
      const accountSnapshots = duplicatePhase
        ? {
            ...realSnapshots,
            [DUP_ACCT_ROW_ID]: {
              balance: DUP_ACCT_BALANCE.toFixed(2),
              at: snapshotAt,
              source: "plaid" as const,
              name: `${ACCT_NAMES[0]} ··${ACCT_MASKS[0]}`,
              mask: ACCT_MASKS[0],
            },
          }
        : realSnapshots;

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          fromDate: today,
          toDate: today,
          events: [],
          transactions: [],
          resolutions: [],
          closedMonths: [],
          settings: {},
          bankSnapshot: {
            balance: ACCT_BALANCES[0].toFixed(2),
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

    // --- /api/transactions: empty. With no post-anchor activity in
    //     the current month, end-of-month equals the snapshot
    //     balance exactly, so the tile assertions can use precise
    //     currency strings.
    await page.route("**/api/transactions**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    });

    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const trigger = page.getByTestId("select-chase-account");
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    const endingBal = page.getByTestId("stat-ending-balance");

    // --- Phase 1: duplicate window. The default-selected account is
    //     the snapshot account (A) since selectedAccountKey starts
    //     unset and falls back to bankSnapshot.accountId. Tile must
    //     equal A's anchored balance ($1,000), NOT $2,000 (which it
    //     would show if A's snapshot were summed with the duplicate
    //     A entry).
    await expect(endingBal).toContainText(fmtCurrency(ACCT_BALANCES[0]), {
      timeout: 15_000,
    });
    await expect(endingBal).not.toContainText(
      fmtCurrency(ACCT_BALANCES[0] + DUP_ACCT_BALANCE),
    );

    // Switch picker to B → tile shows B's snapshot ($500), not the
    // sum of B + duplicate.
    await trigger.click();
    const optionB = page.getByTestId(`option-chase-account-${ACCT_ROW_IDS[1]}`);
    await expect(optionB).toBeVisible({ timeout: 10_000 });
    await optionB.click();
    await expect(endingBal).toContainText(fmtCurrency(ACCT_BALANCES[1]), {
      timeout: 10_000,
    });

    // Switch picker to C → tile shows C's snapshot ($300).
    await trigger.click();
    const optionC = page.getByTestId(`option-chase-account-${ACCT_ROW_IDS[2]}`);
    await expect(optionC).toBeVisible({ timeout: 10_000 });
    await optionC.click();
    await expect(endingBal).toContainText(fmtCurrency(ACCT_BALANCES[2]), {
      timeout: 10_000,
    });

    // Sum across the three real accounts is preserved: 1000 + 500
    // + 300 = $1,800. Inflated total (with the duplicate counted)
    // would be $2,800 — we never observed that on any of the three
    // real-account chips above.

    // --- Phase 2: dedupe lands. Flip the mock so `/api/forecast`
    //     now returns the three real accounts only (and a three-
    //     entry accountSnapshots map), then force the page to
    //     refetch by reloading. A reload is the most deterministic
    //     way to guarantee a fresh `/api/forecast` GET against the
    //     mocked route — same approach as the Amex spec.
    duplicatePhase = false;
    const requestsBeforeReload = forecastRequestCount;
    // Match the Amex spec's exact refetch trigger: page.reload()
    // keeps the auth context and forces React Query to re-execute
    // the /api/forecast and /api/transactions queries against the
    // now-flipped mocks. (page.goto would drop the session and
    // bounce us to the sign-in page.)
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    // Prove a second `/api/forecast` fetch actually happened
    // against the now-three-account mock so the "unchanged tile"
    // assertions below aren't vacuous.
    await expect
      .poll(() => forecastRequestCount, { timeout: 15_000 })
      .toBeGreaterThan(requestsBeforeReload);

    // The picker selection (last set to C in Phase 1) persists via
    // `?account=` URL + localStorage across the reload, so the
    // default selection here is C, not A. Verify C's tile still
    // reads $300 (sum across the three real accounts unchanged at
    // $1,800), then explicitly switch back to A and assert its
    // tile is unchanged at $1,000 — the duplicate never
    // contributed in the first place.
    await expect(endingBal).toContainText(fmtCurrency(ACCT_BALANCES[2]), {
      timeout: 15_000,
    });

    // The duplicate option is gone from the picker. Assert the
    // duplicate row id no longer renders an option (we don't
    // check an exact picker count since Manual is also an option).
    await trigger.click();
    await expect(
      page.getByTestId(`option-chase-account-${ACCT_ROW_IDS[0]}`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId(`option-chase-account-${DUP_ACCT_ROW_ID}`),
    ).toHaveCount(0);

    // Switch to A → its tile shows $1,000 (NOT $2,000), proving
    // the duplicate's removal didn't disturb the real snapshot.
    await page
      .getByTestId(`option-chase-account-${ACCT_ROW_IDS[0]}`)
      .click();
    await expect(endingBal).toContainText(fmtCurrency(ACCT_BALANCES[0]), {
      timeout: 10_000,
    });
    await expect(endingBal).not.toContainText(
      fmtCurrency(ACCT_BALANCES[0] + DUP_ACCT_BALANCE),
    );

    // Re-verify B still shows its own snapshot value after dedupe.
    await trigger.click();
    await page
      .getByTestId(`option-chase-account-${ACCT_ROW_IDS[1]}`)
      .click();
    await expect(endingBal).toContainText(fmtCurrency(ACCT_BALANCES[1]), {
      timeout: 10_000,
    });
  });
});
