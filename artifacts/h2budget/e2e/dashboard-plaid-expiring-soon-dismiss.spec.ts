import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, plaidItemsTable } from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (#325) End-to-end coverage for the dashboard "bank consent expiring
 * soon" banner + persistent dismissal flow added in #257 / #274.
 *
 * Existing tests prove the API route (integration) and the pure
 * presentation component (unit) each behave correctly in isolation,
 * but neither walks the wiring the user actually exercises:
 *   dashboard render → click dismiss → reload → banner stays hidden →
 *   cutoff moves → banner comes back.
 *
 * That wiring (query keys, optimistic cache stamping, the new POST
 * route) is exactly the kind of thing pure unit tests can't catch
 * regressions in, so this spec drives it through real navigation.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(plaidItemsTable)
        .where(eq(plaidItemsTable.userId, userId));
    } catch {
      // best-effort
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

test.describe("Dashboard Plaid expiring-soon banner — dismiss + return (#325)", () => {
  test("shows banner, persists dismissal across reload, returns when cutoff moves", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "dash-plaid-expiring-dismiss",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // Seed a single Plaid item with a near-future consent cutoff that
    // falls inside the 7-day alert window. No `lastSyncErrorCode` so
    // it is NOT in a re-auth state — those are intentionally excluded
    // from the expiring-soon list (covered by PlaidReauthBanner instead).
    const initialCutoff = daysFromNow(3);
    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        itemId: `e2e-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
        consentExpirationAt: initialCutoff,
      })
      .returning();

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/dashboard");

    const banner = page.getByTestId("alerts-plaid-expiring-soon");
    const row = page.getByTestId(`row-plaid-expiring-${item.id}`);
    const dismissBtn = page.getByTestId("button-plaid-expiring-soon-dismiss");

    // --- 1. Banner is visible on the dashboard for the seeded item.
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(row).toBeVisible();

    // --- 2. Dismiss → optimistic disappearance, then a reload to
    // prove the dismissal was actually persisted server-side (and
    // not just stripped from the in-memory cache).
    await dismissBtn.click();
    await expect(banner).toHaveCount(0, { timeout: 10_000 });

    // Reload — the in-memory react-query cache is wiped, so the
    // banner re-render must come purely from what the server now
    // serializes (i.e. the persisted dismissal stamp).
    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/plaid\/items(\?|$)/.test(r.url()) && r.ok(),
        { timeout: 30_000 },
      ),
      page.reload(),
    ]);
    // "Life spending" is a stable post-load body heading that proves
    // the dashboard hydrated (the h1 "Dashboard" only renders during
    // the initial loading skeleton).
    await expect(
      page.getByRole("heading", { name: "Life spending", level: 2 }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(banner).toHaveCount(0);

    // Sanity-check the persistence wrote through to the row the API
    // serializes — the dashboard read this and decided to stay quiet.
    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, item.id));
    expect(persisted.consentWarningDismissedForCutoff?.toISOString()).toBe(
      initialCutoff.toISOString(),
    );

    // --- 3. Move the cutoff (simulating Plaid rolling the consent
    // window forward, e.g. after a partial re-consent that didn't
    // push it out past the 7-day window). The previously-stamped
    // dismissal no longer matches the live cutoff, so the banner
    // must come back automatically without any explicit "clear
    // dismissal" call.
    const movedCutoff = daysFromNow(5);
    await db
      .update(plaidItemsTable)
      .set({ consentExpirationAt: movedCutoff })
      .where(eq(plaidItemsTable.id, item.id));

    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/plaid\/items(\?|$)/.test(r.url()) && r.ok(),
        { timeout: 30_000 },
      ),
      page.reload(),
    ]);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(row).toBeVisible();

    await context.close();
  });
});
