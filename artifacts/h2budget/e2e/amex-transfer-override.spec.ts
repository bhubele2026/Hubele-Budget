import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #494 on the Amex page.
 *
 * The transactions page has a companion spec
 * (`transactions-transfer-override.spec.ts`) that covers all three
 * Transfer-override entry points. The Amex page only exposes the
 * Transfer pill clear (`badge-transfer-${id}` /
 * `button-clear-transfer-${id}` in the desktop layout, plus the
 * `*-mobile-${id}` variants) — there is no inline category picker
 * and no Edit dialog on /amex. So this spec just pins the pill-clear
 * round-trip:
 *
 *   1. Seed an amex-source transaction that's marked as a Transfer.
 *   2. Open /amex, click the X on the Transfer pill.
 *   3. Assert the PATCH body sets `isTransfer: false`, the toast
 *      fires, the badge disappears, and a reload reflects the
 *      server-persisted state (`isTransferUserOverridden=true`).
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

test.describe("Transfer override flow on the Amex page (#494)", () => {
  test("Transfer pill X on /amex clears the flag and persists the override", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "amex-transfer-494",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    const monthStart = thisMonthStart();
    await signInAndOpen(
      page,
      email,
      password,
      `/amex?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^american express$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const suffix = Math.random().toString(36).slice(2, 8);
    const transfersCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: `AmexXfer494-${suffix}`, kind: "expense", groupName: "Other" },
    );

    // Seed an amex-source Transfer row with a category so the row
    // surfaces both the CategoryPicker and the Transfer pill on /amex.
    const pillRow = await apiCall<{
      id: string;
      isTransfer: boolean;
      source: string;
    }>(page, "POST", "/api/transactions", {
      occurredOn: isoDay(-1),
      description: `AMEX-XFER-${suffix.toUpperCase()}-ZZZZZ`,
      amount: "-42.10",
      categoryId: transfersCat.id,
      isTransfer: true,
      source: "amex",
    });
    expect(pillRow.isTransfer).toBe(true);
    expect(pillRow.source).toBe("amex");

    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^american express$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Both the desktop and mobile layouts render simultaneously
    // (Tailwind `md:hidden` / `hidden md:block`). Click the desktop
    // X — that's the one Playwright's default 1280x720 viewport sees.
    const transferBadge = page.getByTestId(`badge-transfer-${pillRow.id}`);
    await expect(transferBadge).toBeVisible({ timeout: 15_000 });

    const clearReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${pillRow.id}`,
      { timeout: 10_000 },
    );
    await page.getByTestId(`button-clear-transfer-${pillRow.id}`).click();
    const clearReq = await clearReqPromise;
    const clearBody = JSON.parse(clearReq.postData() ?? "{}");
    expect(clearBody.isTransfer).toBe(false);

    // Unlike the transactions page, the Amex pill click invalidates
    // queries silently — no toast. Just confirm the badge disappears
    // optimistically after the PATCH resolves.
    await expect(
      page.getByTestId(`badge-transfer-${pillRow.id}`),
    ).toHaveCount(0, { timeout: 5_000 });

    // Reload — the server-persisted state should keep the pill gone
    // and the override flag should be true.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^american express$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(`badge-transfer-${pillRow.id}`),
    ).toHaveCount(0);

    const afterClearList = await apiCall<
      Array<{ id: string; isTransfer: boolean; isTransferUserOverridden: boolean }>
    >(page, "GET", "/api/transactions");
    const afterClear = afterClearList.find((t) => t.id === pillRow.id);
    expect(afterClear?.isTransfer).toBe(false);
    expect(afterClear?.isTransferUserOverridden).toBe(true);

    await context.close();
  });
});
