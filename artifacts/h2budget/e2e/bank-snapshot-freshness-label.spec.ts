import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";
import { seedManualBankSnapshot } from "./helpers/api";

/**
 * End-to-end coverage for the bank-balance freshness label on the pages that
 * show it:
 *   - Banking (`/banking`), in the spending card's head beside Sync. It reads
 *     the spine's freshness verdict (PR3a/PR3b1): `text-bank-snapshot-freshness`
 *     when fresh, `text-bank-freshness-stale` when the server says stale.
 *   - Forecast (`/forecast`), in the bank card's snapshot meta line.
 *
 * (PR3b1) This spec used to target a Dashboard "Chase ending balance" tile and a
 * Transactions snapshot meta line. Neither shows the label any more, so it could
 * not pass. CI runs Playwright only when `E2E_ENABLED` is set, which is why that
 * went unnoticed.
 *
 * A manual snapshot seeded through `/api/forecast/bank-snapshot` (the same
 * endpoint the in-app "Set manually" dialog uses) is fresh, so both pages read
 * "Set manually …".
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Bank balance freshness label — Banking + Forecast", () => {
  test("renders 'Set manually …' on Banking beside Sync, at desktop and phone width", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "banking-bank-freshness",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/banking");
    await seedManualBankSnapshot(page);
    // Reload so the spine picks up the newly seeded snapshot.
    await page.reload();

    const freshness = page.getByTestId("text-bank-snapshot-freshness");
    await expect(freshness).toBeVisible({ timeout: 15_000 });
    await expect(freshness).toContainText("Set manually");
    await expect(freshness).not.toContainText("Last auto-updated");
    await expect(page.getByTestId("text-bank-freshness-stale")).toHaveCount(0);

    // The label used to be hidden below the `sm` breakpoint. At 390px it must
    // be on screen and whole: visible alone would pass for a label squeezed or
    // clipped by the card head.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(freshness).toBeVisible();
    const box = await freshness.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    const textWidth = await freshness.evaluate((el) => el.scrollWidth);
    expect(box!.width).toBeGreaterThanOrEqual(textWidth - 1);
  });

  test("renders 'Set manually …' in the Forecast bank card's meta line", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-bank-freshness",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");
    await seedManualBankSnapshot(page);
    await page.reload();

    const meta = page.getByTestId("text-bank-snapshot-meta");
    await expect(meta).toBeVisible({ timeout: 15_000 });
    await expect(meta).toContainText("Manual");

    const freshness = meta.getByTestId("text-bank-snapshot-freshness");
    await expect(freshness).toBeVisible();
    await expect(freshness).toContainText("Set manually");
    await expect(freshness).not.toContainText("Last auto-updated");
  });
});
