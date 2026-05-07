import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #454:
 *
 * Task #451 made the row's category badge a one-click inline picker;
 * #454 closes the same gap for the other two fields users tweak most
 * often: amount and occurredOn. Clicking the amount opens an inline
 * editor that PATCHes through the same `updateTx` flow as the Edit
 * dialog (sign / currency formatting preserved by `normalizeAmount`).
 * Clicking the per-row calendar affordance opens an inline date input
 * that PATCHes `occurredOn` through the same flow, visibly hopping
 * the row to its new day group. The pencil/edit dialog stays as a
 * secondary path for the less-common fields.
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

test.describe("Inline amount + date edits on transaction rows (#454)", () => {
  test("clicking the amount opens an inline editor that PATCHes (sign preserved); clicking the calendar moves the row to a different day", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-inline-amount-date-454",
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

    // Seed one expense transaction we can poke inline.
    const suffix = Math.random().toString(36).slice(2, 8);
    const description = `INLINE-AMT-DATE-${suffix.toUpperCase()} STORE`;
    const originalDate = isoDay(-1);
    const targetDate = isoDay(-3);

    const seeded = await apiCall<{
      id: string;
      amount: string;
      occurredOn: string;
    }>(page, "POST", "/api/transactions", {
      occurredOn: originalDate,
      description,
      amount: "-12.34",
    });
    expect(seeded.amount).toBe("-12.34");
    expect(seeded.occurredOn.slice(0, 10)).toBe(originalDate);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId(`row-tx-${seeded.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // ----- Inline AMOUNT edit -----
    const amountTrigger = page.getByTestId(`amount-${seeded.id}`);
    await expect(amountTrigger).toBeVisible();
    // Existing label uses the row's signed amount, so it renders as a
    // negative currency string.
    await expect(amountTrigger).toContainText("12.34");

    await amountTrigger.click();

    const amountInput = page.getByTestId(`input-inline-amount-${seeded.id}`);
    await expect(amountInput).toBeVisible();
    // Initial draft is the absolute value (sign comes from the row's
    // current sign and is preserved by `normalizeAmount`).
    await expect(amountInput).toHaveValue("12.34");

    await amountInput.fill("19.50");

    const amountPatchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    const amountResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    await page
      .getByTestId(`button-save-inline-amount-${seeded.id}`)
      .click();

    const amountReq = await amountPatchPromise;
    const amountRes = await amountResPromise;
    expect(amountRes.status()).toBe(200);
    const amountBody = JSON.parse(amountReq.postData() ?? "{}");
    // Sign-preserved: original was an expense (-12.34), so the new
    // amount must be sent as -19.50.
    expect(amountBody.amount).toBe("-19.50");

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(notifications.getByText(/^Amount updated$/)).toBeVisible({
      timeout: 5_000,
    });

    // Server-side persistence — the amount really moved.
    const afterAmount = await apiCall<
      Array<{ id: string; amount: string; occurredOn: string }>
    >(page, "GET", "/api/transactions");
    const persistedAmount = afterAmount.find((t) => t.id === seeded.id);
    expect(persistedAmount?.amount).toBe("-19.50");

    // The visible amount label updates to reflect the new value.
    await expect(amountTrigger).toContainText("19.50");

    // ----- Inline DATE move -----
    const dateTrigger = page.getByTestId(`button-inline-date-${seeded.id}`);
    await expect(dateTrigger).toBeVisible();
    await dateTrigger.click();

    const dateInput = page.getByTestId(`input-inline-date-${seeded.id}`);
    await expect(dateInput).toBeVisible();
    await expect(dateInput).toHaveValue(originalDate);

    await dateInput.fill(targetDate);

    const datePatchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    const dateResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    await page
      .getByTestId(`button-save-inline-date-${seeded.id}`)
      .click();

    const dateReq = await datePatchPromise;
    const dateRes = await dateResPromise;
    expect(dateRes.status()).toBe(200);
    const dateBody = JSON.parse(dateReq.postData() ?? "{}");
    expect(dateBody.occurredOn).toBe(targetDate);

    await expect(notifications.getByText(/^Date updated$/)).toBeVisible({
      timeout: 5_000,
    });

    // Server-side persistence — the date really moved.
    const afterDate = await apiCall<
      Array<{ id: string; amount: string; occurredOn: string }>
    >(page, "GET", "/api/transactions");
    const persistedDate = afterDate.find((t) => t.id === seeded.id);
    expect(persistedDate?.occurredOn.slice(0, 10)).toBe(targetDate);

    // The row now lives under the new day group. The day-group container
    // around it should use the targetDate as its key — the row should
    // still be the same testid, just under a different day header. We
    // assert by checking that the row is visible and the editor's
    // initial value reflects the new date the next time it opens.
    await expect(row).toBeVisible();
    await dateTrigger.click();
    await expect(
      page.getByTestId(`input-inline-date-${seeded.id}`),
    ).toHaveValue(targetDate);

    await context.close();
  });
});
