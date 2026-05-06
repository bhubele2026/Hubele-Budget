import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";
import { seedManualBankSnapshot } from "./helpers/api";

/**
 * End-to-end coverage for the shared bank-snapshot freshness label
 * (`text-bank-snapshot-freshness`) on the two surfaces task #333 added it
 * to:
 *   - Dashboard's Chase ending-balance tile (`tile-chase-ending-balance`)
 *   - Transactions page's snapshot meta line (`text-snapshot-meta`)
 *
 * The Forecast page already has its own coverage for the same component
 * (#285), so this spec only locks the prop wiring on the two newer
 * locations — a regression that drops the `<BankSnapshotFreshness …/>`
 * call from either page would no longer slip through.
 *
 * We seed a manual bank snapshot via the same `/api/forecast/bank-snapshot`
 * endpoint the in-app "Set manually" dialog hits, so both pages render
 * with `source: "manual"` and the label reads "Set manually …".
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("BankSnapshotFreshness label — Dashboard + Transactions wiring (#333)", () => {
  test("renders 'Set manually …' on the Dashboard's Chase ending-balance tile when a manual snapshot exists", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "dash-bank-freshness",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/");
    await seedManualBankSnapshot(page);
    // Reload so the dashboard's `useGetForecast` query picks up the newly
    // seeded snapshot before we assert the populated branch.
    await page.reload();

    const tile = page.getByTestId("tile-chase-ending-balance");
    await expect(tile).toBeVisible({ timeout: 15_000 });
    // Wait for the populated branch to render (vs. the missing-state
    // dash) so we know `chaseEndingBalance` resolved against the snapshot.
    await expect(
      tile.getByTestId("text-chase-ending-balance"),
    ).toBeVisible({ timeout: 15_000 });

    const freshness = tile.getByTestId("text-bank-snapshot-freshness");
    await expect(freshness).toBeVisible();
    await expect(freshness).toContainText("Set manually");
    await expect(freshness).not.toContainText("Last auto-updated");
  });

  test("renders 'Set manually …' on the Transactions snapshot meta line when viewing the snapshot account", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "txn-bank-freshness",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/transactions");
    await seedManualBankSnapshot(page);
    await page.reload();

    const meta = page.getByTestId("text-snapshot-meta");
    await expect(meta).toBeVisible({ timeout: 15_000 });
    await expect(meta).toContainText("Manual");

    const freshness = meta.getByTestId("text-bank-snapshot-freshness");
    await expect(freshness).toBeVisible();
    await expect(freshness).toContainText("Set manually");
    await expect(freshness).not.toContainText("Last auto-updated");
  });
});
