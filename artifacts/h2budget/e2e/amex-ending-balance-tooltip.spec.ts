import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";
// (#884/#888) Single source of truth for the copy that distinguishes the
// /amex projected end-of-month balance from the /reports live current
// balance. Imported (not duplicated as a literal) so this spec can never
// drift from the app copy. `reportsBalances.ts` is a pure, import-free
// module, so pulling it into the Playwright spec is safe.
import { AMEX_BALANCE_DISTINCTION } from "../src/lib/reportsBalances";

/**
 * End-to-end coverage for the reciprocal half of the #884 "these two
 * numbers are different on purpose" distinction.
 *
 * Task #884 appended a shared explanatory note to BOTH balance surfaces:
 *   - the /reports Amex tile (covered by #887 in reports-amex-tile.spec.ts), and
 *   - the /amex page's Ending balance tile tooltip
 *     (`AMEX_BALANCE_DISTINCTION.amexTooltipNote`).
 *
 * The /amex side had no browser coverage, so a regression that dropped or
 * changed the Amex page's explanatory note would go unnoticed. This spec
 * seeds an Amex anchor so the Ending balance StatChip renders, then hovers
 * the tile to surface its Radix tooltip and asserts the tooltip carries the
 * shared `amexTooltipNote` copy verbatim.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: unknown };

async function apiCall<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await page.evaluate(
    async (args): Promise<ApiResult<T>> => {
      const res = await fetch(args.path, {
        method: args.method,
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: args.body == null ? undefined : JSON.stringify(args.body),
      });
      let parsed: unknown = null;
      const text = await res.text();
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        return { ok: false, status: res.status, body: parsed };
      }
      return { ok: true, status: res.status, body: parsed as T };
    },
    { method, path, body },
  );
  if (!result.ok) {
    throw new Error(
      `API ${method} ${path} failed (${result.status}): ${JSON.stringify(result.body)}`,
    );
  }
  return result.body;
}

test.describe("Amex page — Ending balance tooltip distinction (#888)", () => {
  test("the Ending balance tile tooltip carries the shared end-of-month vs live note", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-ending-balance-tooltip",
      provisionedUserIds,
    );

    // Sign in first so the page has a Clerk session cookie before the
    // /api/* seeding call. We land on /amex only to mount an authenticated
    // origin — we reload after seeding.
    await signInAndOpen(page, email, password, "/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Save an Amex anchor with asOf=now so the selected (current) month
    // matches the anchor month and the Ending balance == anchor value with
    // no roll-forward. This guarantees the Ending balance StatChip renders
    // (instead of the empty / loading branches) so its tooltip is wired up.
    const anchorBalance = 1234.56;
    await apiCall(page, "POST", "/api/amex/anchor", {
      balance: anchorBalance,
      asOf: new Date().toISOString(),
    });

    // Reload so the page picks up the saved anchor.
    await page.goto("/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The Ending balance tile populates to the anchor value.
    const tile = page.getByTestId("stat-ending-balance");
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await expect(tile).toContainText("From saved anchor", { timeout: 15_000 });

    // The explanatory note lives in the tile's Radix tooltip, which only
    // mounts on hover/focus. Hover the tile to surface it, then assert the
    // tooltip carries the shared copy from the single source of truth.
    await tile.hover();
    const tooltip = page.getByRole("tooltip").filter({
      hasText: AMEX_BALANCE_DISTINCTION.amexTooltipNote,
    });
    await expect(tooltip.first()).toContainText(
      AMEX_BALANCE_DISTINCTION.amexTooltipNote,
      { timeout: 15_000 },
    );
  });
});
