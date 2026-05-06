import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #386:
 *
 * Power users can confirm a one-click bank match by focusing the inbox
 * card wrapper (`data-testid="inbox-card-<txnId>"`, made keyboard-focusable
 * with `tabIndex={0}` only when a one-click suggestion exists) and pressing
 * Enter. The keydown handler in `InboxCardView` (forecast.tsx) calls the
 * same `onMatchPick` path the dropdown / Match button use, so this spec
 * locks in:
 *   - Case 1 (qualifies): seed exactly one bank card + one matching plan
 *     for the same amount/day → the wrapper exposes
 *     `inbox-card-<txnId>`, focusing it and pressing Enter resolves the
 *     bank line via POST /api/forecast/resolutions (status="matched") and
 *     moves the card into the "Resolved this month" list.
 *   - Case 2 (no one-click): a bank card with no plan to match against
 *     does NOT receive the `inbox-card-<txnId>` testid (i.e. no
 *     `tabIndex`) and pressing Enter on the card area does not silently
 *     match — the card stays in the inbox and no matched resolution is
 *     persisted.
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

/**
 * Mirrors the helper in forecast-one-click-match.spec.ts: a current-month
 * day a few days out (capped at 28) so the same day powers a 0-day delta
 * inside the picker's high-confidence ≤5-day window.
 */
function pickAnchorDay(): { iso: string; day: number } {
  const d = new Date();
  const target = Math.min(Math.max(d.getDate() + 3, 5), 28);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return {
    iso: `${year}-${month}-${String(target).padStart(2, "0")}`,
    day: target,
  };
}

test.describe("Forecast inbox Enter-to-match keyboard shortcut (#386)", () => {
  test("focusing a one-click card and pressing Enter resolves it as matched", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-enter-match-386",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    const { iso: anchorIso, day: anchorDay } = pickAnchorDay();
    const suffix = Math.random().toString(36).slice(2, 8);
    const billName = `EnterMatchBill-${suffix}`;

    // One planned bill + one bank card with the same amount and day —
    // identical setup to the one-click obvious-match test, which is the
    // exact precondition the keyboard handler requires (canOneClick).
    await apiCall<{ id: string }>(page, "POST", "/api/recurring-items", {
      name: billName,
      kind: "bill",
      amount: "120.00",
      frequency: "monthly",
      dayOfMonth: anchorDay,
      active: "true",
    });

    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: anchorIso,
        description: `INBOX-${suffix} ENTER`,
        amount: "-120.00",
        forecastFlag: true,
      },
    );

    await page.goto("/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    // The wrapper exposes the inbox-card testid only when canOneClick is
    // true (single uncontested high-confidence suggestion). If this isn't
    // visible the keyboard path can't possibly fire.
    const cardWrapper = page.getByTestId(`inbox-card-${txn.id}`);
    await expect(cardWrapper).toBeVisible({ timeout: 15_000 });
    await expect(cardWrapper).toHaveAttribute("tabindex", "0");
    await expect(cardWrapper).toHaveAttribute("aria-keyshortcuts", "Enter");

    // Capture the matched-resolution POST so we know Enter went through
    // the same /api/forecast/resolutions path as the click handler.
    const matchedPosts: Array<{
      status: string;
      matchedTxnId: string;
      recurringItemId: string | null;
    }> = [];
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/forecast/resolutions"
      ) {
        try {
          const body = JSON.parse(req.postData() ?? "{}");
          matchedPosts.push({
            status: body.status,
            matchedTxnId: body.matchedTxnId,
            recurringItemId: body.recurringItemId ?? null,
          });
        } catch {
          /* ignore */
        }
      }
    });

    // Focus the wrapper itself (the handler bails unless e.target ===
    // e.currentTarget) and press Enter.
    await cardWrapper.focus();
    await expect(cardWrapper).toBeFocused();
    await cardWrapper.press("Enter");

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(
      notifications.getByText(new RegExp(`Matched to ${billName}`)),
    ).toBeVisible({ timeout: 10_000 });

    // Card leaves the inbox …
    await expect(page.getByTestId(`inbox-card-${txn.id}`)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByTestId(`one-click-match-${txn.id}`)).toHaveCount(0);

    // … and shows up under "Resolved this month".
    const resolvedList = page.getByTestId("bank-resolved-list");
    await expect(resolvedList).toBeVisible();
    await expect(resolvedList).toContainText(`INBOX-${suffix} ENTER`);
    await expect(resolvedList).toContainText(/matched/i);

    const matched = matchedPosts.find(
      (p) => p.status === "matched" && p.matchedTxnId === txn.id,
    );
    expect(
      matched,
      "expected a matched resolution POST triggered by Enter",
    ).toBeTruthy();
    expect(matched?.recurringItemId).toBeTruthy();

    // Server-side: the resolution is persisted as matched, same as the
    // click path.
    const fc = await apiCall<{
      resolutions: Array<{
        matchedTxnId: string | null;
        recurringItemId: string | null;
        status: string;
      }>;
    }>(page, "GET", "/api/forecast");
    const persisted = (fc.resolutions ?? []).find(
      (r) => r.matchedTxnId === txn.id && r.status === "matched",
    );
    expect(persisted, "expected persisted matched resolution").toBeTruthy();
    expect(persisted?.recurringItemId).toBeTruthy();
  });

  test("a card with no one-click suggestion has no tabIndex and pressing Enter does not silently match", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-enter-match-386-no-match",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    const { iso: anchorIso } = pickAnchorDay();
    const suffix = Math.random().toString(36).slice(2, 8);

    // No recurring bill seeded → the bank card has nothing to match
    // against, so the picker returns no one-click suggestion. The
    // wrapper should NOT receive `tabIndex` / the inbox-card testid.
    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: anchorIso,
        description: `INBOX-${suffix} NOMATCH`,
        amount: "-77.55",
        forecastFlag: true,
      },
    );

    await page.goto("/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    // The card itself is rendered (the dropdown trigger proves it) …
    const dropdown = page.getByTestId(`select-bank-${txn.id}`);
    await expect(dropdown).toBeVisible({ timeout: 15_000 });

    // … but the wrapper is not focusable: no `inbox-card-<txnId>` testid
    // and no Match button means no Enter shortcut path.
    await expect(page.getByTestId(`inbox-card-${txn.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`one-click-match-${txn.id}`)).toHaveCount(0);

    // Track resolution POSTs so we can prove Enter doesn't quietly fire one.
    const resolutionPosts: Array<{ status: string; matchedTxnId: string }> = [];
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/forecast/resolutions"
      ) {
        try {
          const body = JSON.parse(req.postData() ?? "{}");
          resolutionPosts.push({
            status: body.status,
            matchedTxnId: body.matchedTxnId,
          });
        } catch {
          /* ignore */
        }
      }
    });

    // Focus something inside the card area (the dropdown trigger is the
    // closest focusable thing this card actually exposes) and press
    // Enter. Without the wrapper handler this must not produce a match.
    await dropdown.focus();
    await page.keyboard.press("Enter");
    // The Select would open a listbox on Enter; close it so it doesn't
    // intercept further keystrokes, and give the app a beat to (not)
    // POST.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Card stays in the inbox — dropdown still visible, never moved to
    // "Resolved this month".
    await expect(page.getByTestId(`select-bank-${txn.id}`)).toBeVisible();
    const resolvedList = page.getByTestId("bank-resolved-list");
    if (await resolvedList.count()) {
      await expect(resolvedList).not.toContainText(`INBOX-${suffix} NOMATCH`);
    }

    // No matched POST was sent for this txn.
    expect(
      resolutionPosts.find(
        (p) => p.matchedTxnId === txn.id && p.status === "matched",
      ),
      "Enter must not fire a match when there is no one-click suggestion",
    ).toBeFalsy();

    // Server-side: nothing is persisted as matched for this txn.
    const fc = await apiCall<{
      resolutions: Array<{ matchedTxnId: string | null; status: string }>;
    }>(page, "GET", "/api/forecast");
    const matched = (fc.resolutions ?? []).find(
      (r) => r.matchedTxnId === txn.id && r.status === "matched",
    );
    expect(matched).toBeFalsy();
  });
});
