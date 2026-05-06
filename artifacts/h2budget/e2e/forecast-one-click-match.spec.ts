import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #318:
 *
 * The Forecast inbox renders a primary "Match" button (testid
 * `one-click-match-<txnId>`) on bank cards whose top suggestion is the
 * single uncontested high-confidence pick (driven by
 * `pickOneClickBankMatches` in `src/lib/forecastMatch.ts`). Until now only
 * the picker had unit coverage; this spec locks in the full wiring:
 *   - Case 1 (obvious match): one bank card + one matching planned bill
 *     for the same amount/day surfaces the Match button, a click resolves
 *     the card via POST /api/forecast/resolutions (status="matched"), the
 *     "Matched to <plan>" toast fires, the card moves into the
 *     "Resolved this month" list, and the Undo button there returns it
 *     to the inbox so the one-click button reappears.
 *   - Case 2 (contested): two bank cards both targeting the same plan
 *     have it as their only high-confidence suggestion → the picker
 *     drops both, so neither card shows the Match button (the dropdown
 *     stays as the disambiguation path).
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
 * Pick a current-month day that's a few days from today but still in the
 * month — gives the suggester a 0-day delta (we use the same day for the
 * bank txn) which is well inside the high-confidence ≤5-day window. We
 * cap at 28 so the date is always valid regardless of month length.
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

test.describe("Forecast inbox one-click Match button (#318)", () => {
  test("an obvious uncontested high-confidence card shows the Match button, resolves on click, and undo restores it", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-one-click-318",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    const { iso: anchorIso, day: anchorDay } = pickAnchorDay();
    const suffix = Math.random().toString(36).slice(2, 8);
    const billName = `OneClickBill-${suffix}`;

    // Seed a single monthly recurring bill anchored to `anchorDay`. Plan
    // rows for the current month land on `anchorIso` with amount -120.00.
    await apiCall<{ id: string }>(page, "POST", "/api/recurring-items", {
      name: billName,
      kind: "bill",
      amount: "120.00",
      frequency: "monthly",
      dayOfMonth: anchorDay,
      active: "true",
    });

    // Seed a single manual bank inbox card with the exact same amount and
    // date as the plan row. Same-day + exact amount = high-confidence top
    // suggestion, and there's no other plan competing for it → the picker
    // emits a one-click match for this txn.
    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: anchorIso,
        description: `INBOX-${suffix} OBVIOUS`,
        amount: "-120.00",
        forecastFlag: true,
      },
    );

    await page.goto("/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    const matchBtn = page.getByTestId(`one-click-match-${txn.id}`);
    await expect(matchBtn).toBeVisible({ timeout: 15_000 });
    await expect(matchBtn).toHaveText(/Match/);
    // Title/aria-label encode the chosen plan so a regression that picks
    // the wrong plan would surface here.
    await expect(matchBtn).toHaveAttribute(
      "aria-label",
      new RegExp(`Match to ${billName}`),
    );

    // Watch for the matched-resolution POST so we can confirm the click
    // hits the same endpoint and payload shape as the dropdown path.
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

    await matchBtn.click();

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(
      notifications.getByText(new RegExp(`Matched to ${billName}`)),
    ).toBeVisible({ timeout: 10_000 });

    // The card leaves the inbox …
    await expect(page.getByTestId(`one-click-match-${txn.id}`)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByTestId(`select-bank-${txn.id}`)).toHaveCount(0);

    // … and shows up under "Resolved this month" with an Undo button.
    const resolvedList = page.getByTestId("bank-resolved-list");
    await expect(resolvedList).toBeVisible();
    await expect(resolvedList).toContainText(`INBOX-${suffix} OBVIOUS`);
    await expect(resolvedList).toContainText(/matched/i);
    const undoBtn = resolvedList.getByRole("button", { name: /undo/i }).first();
    await expect(undoBtn).toBeVisible();

    // The POST must mirror what the dropdown path sends: matched status,
    // the bank txn id, and the plan's recurring item id.
    const matched = matchedPosts.find(
      (p) => p.status === "matched" && p.matchedTxnId === txn.id,
    );
    expect(matched, "expected a matched resolution POST for the txn").toBeTruthy();
    expect(matched?.recurringItemId).toBeTruthy();

    // Server-side: the resolution is persisted as matched and tied to
    // both the bank txn and the recurring item.
    const fc1 = await apiCall<{
      resolutions: Array<{
        matchedTxnId: string | null;
        recurringItemId: string | null;
        status: string;
      }>;
    }>(page, "GET", "/api/forecast");
    const persisted = (fc1.resolutions ?? []).find(
      (r) => r.matchedTxnId === txn.id && r.status === "matched",
    );
    expect(persisted, "expected persisted matched resolution").toBeTruthy();
    expect(persisted?.recurringItemId).toBeTruthy();

    // Undo → card returns to the inbox and the one-click button comes back.
    await undoBtn.click();
    await expect(notifications.getByText(/Undone/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId(`one-click-match-${txn.id}`)).toBeVisible({
      timeout: 10_000,
    });

    // And the resolution is gone server-side.
    const fc2 = await apiCall<{
      resolutions: Array<{ matchedTxnId: string | null; status: string }>;
    }>(page, "GET", "/api/forecast");
    const stillMatched = (fc2.resolutions ?? []).find(
      (r) => r.matchedTxnId === txn.id && r.status === "matched",
    );
    expect(stillMatched).toBeFalsy();
  });

  test("two bank cards contesting the same single plan both hide the Match button", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-one-click-318-contested",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    const { iso: anchorIso, day: anchorDay } = pickAnchorDay();
    const suffix = Math.random().toString(36).slice(2, 8);
    const billName = `OneClickBill-${suffix}`;

    // ONE planned bill — both bank cards below will pick it as their
    // only high-confidence suggestion (same amount, same day → 0 delta,
    // 0 days away).
    await apiCall<{ id: string }>(page, "POST", "/api/recurring-items", {
      name: billName,
      kind: "bill",
      amount: "120.00",
      frequency: "monthly",
      dayOfMonth: anchorDay,
      active: "true",
    });

    const a = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
      occurredOn: anchorIso,
      description: `INBOX-${suffix} TIE A`,
      amount: "-120.00",
      forecastFlag: true,
    });
    const b = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
      occurredOn: anchorIso,
      description: `INBOX-${suffix} TIE B`,
      amount: "-120.00",
      forecastFlag: true,
    });

    await page.goto("/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    // Both cards must be present in the inbox so we know we're not just
    // measuring "card not rendered yet".
    await expect(page.getByTestId(`select-bank-${a.id}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId(`select-bank-${b.id}`)).toBeVisible();

    // Neither card should expose the one-click Match button — the picker
    // drops both because the only high-confidence plan is contested.
    await expect(page.getByTestId(`one-click-match-${a.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`one-click-match-${b.id}`)).toHaveCount(0);
  });
});
