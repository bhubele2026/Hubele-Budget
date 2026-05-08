import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #471:
 *
 * Task #454 added inline amount + date editors but intentionally
 * preserved the row's existing sign (an expense stayed an expense).
 * #471 closes the last common quick-edit gap with a small "expense ↔
 * income" toggle inside the inline amount popover. Clicking it
 * re-runs `normalizeAmount` against the *opposite* kind so the
 * persisted amount and the visible color/sign update together via
 * the same `updateTx` PATCH flow as the Edit dialog.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

type ApiResult<T> = { ok: true; status: number; body: T } | {
  ok: false;
  status: number;
  body: unknown;
};

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

function thisMonthStart(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Inline expense ↔ income flip on transaction rows (#471)", () => {
  test("flipping an expense to income (and back) PATCHes the row's sign through updateTx and updates the visible amount", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-inline-flip-kind-471",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    const monthStart = thisMonthStart();
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Seed one expense transaction we can flip.
    const suffix = Math.random().toString(36).slice(2, 8);
    const description = `INLINE-FLIP-${suffix.toUpperCase()} STORE`;
    const occurredOn = isoDay(-1);

    const seeded = await apiCall<{
      id: string;
      amount: string;
      occurredOn: string;
    }>(page, "POST", "/api/transactions", {
      occurredOn,
      description,
      amount: "-42.10",
    });
    expect(seeded.amount).toBe("-42.10");

    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId(`row-tx-${seeded.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // ----- Flip expense -> income -----
    const amountTrigger = page.getByTestId(`amount-${seeded.id}`);
    await expect(amountTrigger).toBeVisible();
    await expect(amountTrigger).toContainText("42.10");
    await amountTrigger.click();

    const flipButton = page.getByTestId(`button-flip-kind-${seeded.id}`);
    await expect(flipButton).toBeVisible();
    // Currently an expense, so the button offers "Mark as income".
    await expect(flipButton).toHaveText(/mark as income/i);

    const flipPatchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    const flipResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    await flipButton.click();

    const flipReq = await flipPatchPromise;
    const flipRes = await flipResPromise;
    expect(flipRes.status()).toBe(200);
    const flipBody = JSON.parse(flipReq.postData() ?? "{}");
    // Magnitude preserved, sign flipped from -42.10 to 42.10.
    expect(flipBody.amount).toBe("42.10");

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(notifications.getByText(/^Marked as income$/)).toBeVisible({
      timeout: 5_000,
    });

    // Server-side persistence — the row really is income now.
    const afterFlip = await apiCall<
      Array<{ id: string; amount: string }>
    >(page, "GET", "/api/transactions");
    const persistedFlip = afterFlip.find((t) => t.id === seeded.id);
    expect(persistedFlip?.amount).toBe("42.10");

    // The visible amount label still shows the magnitude (no longer
    // prefixed as a debit) and reflects the flipped value.
    await expect(amountTrigger).toContainText("42.10");

    // ----- Flip back income -> expense -----
    await amountTrigger.click();
    const flipBackButton = page.getByTestId(`button-flip-kind-${seeded.id}`);
    await expect(flipBackButton).toBeVisible();
    // Now currently income, so the button offers "Mark as expense".
    await expect(flipBackButton).toHaveText(/mark as expense/i);

    const flipBackPatchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    const flipBackResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    await flipBackButton.click();

    const flipBackReq = await flipBackPatchPromise;
    const flipBackRes = await flipBackResPromise;
    expect(flipBackRes.status()).toBe(200);
    const flipBackBody = JSON.parse(flipBackReq.postData() ?? "{}");
    expect(flipBackBody.amount).toBe("-42.10");

    await expect(notifications.getByText(/^Marked as expense$/)).toBeVisible({
      timeout: 5_000,
    });

    const afterFlipBack = await apiCall<
      Array<{ id: string; amount: string }>
    >(page, "GET", "/api/transactions");
    const persistedFlipBack = afterFlipBack.find((t) => t.id === seeded.id);
    expect(persistedFlipBack?.amount).toBe("-42.10");

    await expect(amountTrigger).toContainText("42.10");

    await context.close();
  });
});
