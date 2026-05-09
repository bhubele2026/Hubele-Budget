import { test, expect } from "@playwright/test";
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
 * End-to-end coverage for task #435 (covers the #429 fix end-to-end).
 *
 * Scenario the #429 fix is supposed to cover: a user whose loser id
 * was repointed onto the survivor visits the Chase Transactions page
 * and sees real Starting/Ending balance tiles instead of the
 * "Unavailable" placeholder. #429 added a unit test for the helper
 * (`deriveEffectiveSnapshot`) and an integration test for the dedupe
 * routine, but no e2e proved the page-level wiring.
 *
 * This spec seeds the production-faithful post-dedupe / post-repoint
 * state directly in the database — no `/api/forecast`,
 * `/api/transactions`, or `/api/plaid/items` mocking — and asserts
 * the Chase page's `stat-starting-balance` and `stat-ending-balance`
 * tiles render real currency. It also covers the negative case:
 * switching to a sibling Chase account with a different mask must
 * not over-match through the helper's (institutionName, mask)
 * fallback branch — both tiles flip back to "Unavailable".
 *
 * Why a single survivor on the snapshot mask:
 * `listCheckingAccounts` in `artifacts/api-server/src/routes/forecast.ts`
 * (lines 119-153) ALWAYS dedupes its response by (institutionName,
 * mask) and prefers the bank-snapshot pointer as survivor. After the
 * production auto-dedupe + `repointBankSnapshotIfPointingToLoser`
 * pass runs, the live API can never expose two surviving rows under
 * the same (institutionName, mask) — the loser row is deleted and
 * the snapshot pointer is rewritten to the survivor. The helper's
 * branch #3 (the (institutionName, mask) fallback) is therefore
 * unreachable through a real API response and is exercised at the
 * unit level by `effectiveSnapshot.test.ts` only. What this spec
 * locks in end-to-end is the production-observable consequence of
 * the #429 fix: with `accountSnapshots` empty after the repoint,
 * the page must render real currency for the snapshot account
 * (helper branch #1) and "Unavailable" for siblings whose mask
 * does not match.
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function thisMonthStart(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

test.describe("Chase Starting/Ending balance — effective snapshot wiring (#435, covers #429)", () => {
  test("renders real currency on the snapshot account when accountSnapshots is empty, and shows Unavailable on a sibling whose mask does not match", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-effective-snapshot",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // --- Seed: two linked Chase checking accounts under the same
    //     Plaid item. Account A is the dedupe survivor + snapshot
    //     account (mask "5526"); account B is a sibling at the same
    //     institution with a DIFFERENT mask ("9999") so the API's
    //     in-response (institutionName, mask) dedupe leaves both
    //     visible to the picker. `accountSnapshots` is left at the
    //     default empty `{}` (the post-repoint, pre-per-account-write
    //     state #429 was about). Pre-stamp `autoDedupeRanAt` so the
    //     auto-dedupe pass on first /api/forecast doesn't rewrite
    //     anything we just seeded.
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
    const [acctA] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        itemId: item.id,
        accountId: `e2e-acct-A-${suffix}`,
        name: "Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    const [acctB] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        itemId: item.id,
        accountId: `e2e-acct-B-${suffix}`,
        name: "Joint Checking",
        mask: "9999",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor the bank snapshot at A. Manual source + balance/date
    // that don't match seedAprilChase's repair triggers so the
    // on-mount seed leaves the snapshot intact.
    const today = todayISO();
    await db.insert(forecastSettingsTable).values({
      userId,
      bankSnapshotBalance: "1234.56",
      bankSnapshotAt: new Date(`${today}T12:00:00Z`),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acctA.id,
      bankSnapshotName: acctA.name,
      bankSnapshotMask: acctA.mask,
      // Explicitly empty — this is the regression scenario the
      // #429 fix was about. A future regression that started
      // requiring a populated entry to render real currency
      // would surface in the positive assertions below.
      accountSnapshots: {},
      // Pre-stamp so `runAutoDedupeIfNeeded` no-ops on first
      // /api/forecast — no concurrent rewrites.
      autoDedupeRanAt: new Date(),
    });

    const seedRow = async (
      plaidAccountId: string,
      tag: "A" | "B",
      idx: number,
      amount: string,
    ) => {
      const [row] = await db
        .insert(transactionsTable)
        .values({
          userId,
          occurredOn: today,
          occurredAt: new Date(`${today}T15:00:00Z`).toISOString(),
          description: `E2E-${suffix} ${tag}${idx}`,
          amount,
          account: tag === "A" ? "Total Checking" : "Joint Checking",
          source: "plaid",
          plaidTransactionId: `e2e-${suffix}-${tag}-${idx}`,
          plaidAccountId,
        })
        .returning();
      return row;
    };
    const a1 = await seedRow(acctA.accountId, "A", 1, "200.00");
    await seedRow(acctA.accountId, "A", 2, "-50.00");
    const b1 = await seedRow(acctB.accountId, "B", 1, "77.00");
    await seedRow(acctB.accountId, "B", 2, "-33.00");

    const monthStart = thisMonthStart();
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for A's rows so we know /api/forecast and /api/transactions
    // have resolved against the seeded DB state.
    await expect(page.getByTestId(`row-tx-${a1.id}`)).toBeVisible({
      timeout: 15_000,
    });

    const startingBal = page.getByTestId("stat-starting-balance");
    const endingBal = page.getByTestId("stat-ending-balance");

    // --- Positive case: the page defaults to A (the snapshot
    //     account). With `accountSnapshots` empty, the page must
    //     still render real currency for A — the production
    //     post-repoint behavior the #429 fix locked in. The
    //     anchor sits at noon today and seeded txns at 3pm today,
    //     so end-of-month equals the anchor exactly ($1,234.56)
    //     and start-of-month equals anchor − net change
    //     (200 − 50 = 150) → $1,084.56. A regression that broke
    //     the page wiring of `deriveEffectiveSnapshot` (e.g.
    //     stopped feeding `forecastData.bankSnapshot` /
    //     `accountSnapshots` / `plaidCheckingAccounts` into the
    //     helper) would fail these exact-amount assertions.
    await expect(startingBal).not.toContainText("Unavailable");
    await expect(endingBal).not.toContainText("Unavailable");
    await expect(endingBal).toContainText("$1,234.56");
    await expect(startingBal).toContainText("$1,084.56");

    // --- Negative case: switch to B (mask "9999"). The page-side
    //     `deriveEffectiveSnapshot` is now in branch #3 territory —
    //     `selectedAccountInternalId !== bankSnapshot.accountId`,
    //     `accountSnapshots[B.id]` is missing, and the helper has
    //     to compare A's mask against B's mask via the
    //     `plaidCheckingAccounts` array the API returned. They
    //     differ ("5526" vs "9999"), so the fallback must NOT
    //     fire and both tiles flip to "Unavailable". A regression
    //     where the API stopped returning `mask` (or
    //     `institutionName`) on `plaidCheckingAccounts` would
    //     also fail this — branch #3 would either over-match or
    //     misbehave depending on which field was missing.
    const trigger = page.getByTestId("select-chase-account");
    await trigger.click();
    const optionB = page.getByTestId(`option-chase-account-${acctB.id}`);
    await expect(optionB).toBeVisible({ timeout: 10_000 });
    await optionB.click();

    await expect(page.getByTestId(`row-tx-${b1.id}`)).toBeVisible({
      timeout: 5_000,
    });
    await expect(startingBal).toContainText("Unavailable");
    await expect(endingBal).toContainText("Unavailable");
    // Negative guard: A's snapshot value must not bleed into B's
    // tiles (would happen if branch #3 over-matched).
    await expect(startingBal).not.toContainText("1,234.56");
    await expect(endingBal).not.toContainText("1,234.56");

    await context.close();
  });
});
