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
 * End-to-end coverage for task #342 (the per-account snapshot path added
 * by task #296).
 *
 * The Chase Transactions page lets the user pick any linked checking
 * account in the picker (#103). Pressing "Refresh from Plaid" while a
 * non-primary account is selected hits POST /api/forecast/refresh-bank
 * with `{ plaidAccountId }`, which writes a per-account entry into
 * `forecast_settings.account_snapshots` so the page's Starting / Ending
 * balance chips can render real currency for that account instead of
 * the "Unavailable" placeholder.
 *
 * Without this spec, a regression that dropped the per-account snapshot
 * write — or stopped reading it on the client — would silently flip
 * non-primary accounts back to the placeholder and only the primary
 * snapshot account would render real balances.
 *
 * The real /forecast/refresh-bank handler reaches out to the live Plaid
 * `accountsBalanceGet` API, which we can't call in CI. We intercept the
 * request via `page.route` and, in the route handler, write the
 * per-account snapshot directly to the DB before fulfilling — exactly
 * the side-effect the production handler would have produced — so that
 * the client's `onSuccess` invalidation triggers a real GET /forecast
 * which now returns the populated `accountSnapshots[acctB.id]` entry.
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

test.describe("Chase per-account balance refresh (#342, covers #296)", () => {
  test("refreshing a non-primary account renders real Starting/Ending balance chips, and switching back keeps the primary snapshot", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-acct-balance-refresh",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // --- Seed: two linked checking accounts under the same Plaid item.
    // A is the primary snapshot account (anchored balance $1234.56),
    // B has no per-account snapshot yet so its balance chips start out
    // in the "Unavailable" branch until refresh-bank populates one.
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
        mask: "1111",
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
        mask: "2222",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor the bank snapshot at account A using a balance + date that
    // do NOT match seedAprilChase's repair triggers, so the on-mount
    // seed leaves our snapshot intact. The snapshot timestamp lives in
    // the current month so anchorMonth == selectedMonth and Starting /
    // Ending balance render real numbers for account A right away.
    const today = todayISO();
    await db.insert(forecastSettingsTable).values({
      userId,
      bankSnapshotBalance: "1234.56",
      bankSnapshotAt: new Date(`${today}T12:00:00Z`),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acctA.id,
      bankSnapshotName: acctA.name,
      bankSnapshotMask: acctA.mask,
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

    // Intercept POST /api/forecast/refresh-bank. The real handler hits
    // Plaid's accountsBalanceGet for live balances; we can't call that
    // in CI, so we replicate its DB side-effect (write a per-account
    // snapshot into forecast_settings.account_snapshots) and then
    // fulfill with the same response shape the production handler
    // returns for a non-primary account refresh. The client's
    // onSuccess invalidates getForecast, which will now refetch and
    // see the populated snapshot.
    const REFRESHED_BALANCE = "987.65";
    let refreshCalls = 0;
    let lastRefreshAccountId: string | null = null;
    await page.route("**/api/forecast/refresh-bank", async (route) => {
      refreshCalls++;
      const body = JSON.parse(route.request().postData() ?? "{}");
      lastRefreshAccountId = body?.plaidAccountId ?? null;
      const at = new Date().toISOString();

      const [settings] = await db
        .select()
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, userId));
      const nextMap = {
        ...(settings?.accountSnapshots ?? {}),
        [acctB.id]: {
          balance: REFRESHED_BALANCE,
          at,
          source: "plaid" as const,
          name: acctB.name,
          mask: acctB.mask,
        },
      };
      await db
        .update(forecastSettingsTable)
        .set({ accountSnapshots: nextMap, updatedAt: new Date() })
        .where(eq(forecastSettingsTable.userId, userId));

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          balance: REFRESHED_BALANCE,
          at,
          source: "plaid",
          accountId: acctB.id,
          name: acctB.name,
          mask: acctB.mask,
        }),
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

    // --- Wait for the snapshot account (A) to render so we know the
    // forecast bundle has loaded before we open the picker.
    await expect(page.getByTestId(`row-tx-${a1.id}`)).toBeVisible({
      timeout: 15_000,
    });

    // --- Switch to account B. Without a per-account snapshot, the
    // Starting / Ending balance chips render the "Unavailable"
    // placeholder.
    const trigger = page.getByTestId("select-chase-account");
    await trigger.click();
    const optionB = page.getByTestId(`option-chase-account-${acctB.id}`);
    await expect(optionB).toBeVisible({ timeout: 10_000 });
    await optionB.click();

    await expect(page.getByTestId(`row-tx-${b1.id}`)).toBeVisible({
      timeout: 5_000,
    });
    const startingBal = page.getByTestId("stat-starting-balance");
    const endingBal = page.getByTestId("stat-ending-balance");
    await expect(startingBal).toContainText("Unavailable");
    await expect(endingBal).toContainText("Unavailable");

    // --- Press "Refresh from Plaid". The mocked route writes a
    // per-account snapshot for B; the client's onSuccess invalidation
    // refetches GET /forecast and the chips flip to real currency.
    const refreshBtn = page.getByTestId("button-refresh-bank");
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();

    await expect.poll(() => refreshCalls).toBeGreaterThanOrEqual(1);
    expect(lastRefreshAccountId).toBe(acctB.id);

    await expect(startingBal).not.toContainText("Unavailable", {
      timeout: 10_000,
    });
    await expect(endingBal).not.toContainText("Unavailable");
    // The refreshed B anchor `at` falls on the same calendar day as
    // B's seeded txns, so computeBalanceAtEndOf treats them as
    // already reflected in the snapshot (day > anchorDay is false).
    // End-of-current-month for B therefore equals the freshly written
    // $987.65 anchor exactly, and start-of-month equals 987.65 minus
    // B's full current-month net change of +$77 - $33 = +$44.
    await expect(endingBal).toContainText("$987.65");
    await expect(startingBal).toContainText("$943.65");

    // --- Switch back to account A. The primary bankSnapshot was
    // never touched by the refresh (it only wrote into
    // accountSnapshots[acctB.id]), so A's chips must still render
    // *exactly* the seeded primary snapshot — not the refreshed B
    // value, and not the placeholder. A regression that clobbered
    // the primary snapshot, or read accountSnapshots[acctB.id] on
    // the wrong account key, would flunk these exact-amount checks.
    await trigger.click();
    const optionA = page.getByTestId(`option-chase-account-${acctA.id}`);
    await expect(optionA).toBeVisible({ timeout: 10_000 });
    await optionA.click();

    await expect(page.getByTestId(`row-tx-${a1.id}`)).toBeVisible({
      timeout: 5_000,
    });
    await expect(startingBal).not.toContainText("Unavailable");
    await expect(endingBal).not.toContainText("Unavailable");
    // Same anchor-day reasoning as B above: A's seeded snapshot is
    // anchored at noon today, A's txns are also dated today, so
    // end-of-current-month = anchor = $1,234.56, and start-of-month
    // = 1234.56 - (200 - 50) = $1,084.56.
    await expect(endingBal).toContainText("$1,234.56");
    await expect(startingBal).toContainText("$1,084.56");
    // Negative guard: the refreshed B amount must not bleed into
    // either of A's chips.
    await expect(startingBal).not.toContainText("987.65");
    await expect(endingBal).not.toContainText("987.65");

    await context.close();
  });
});
