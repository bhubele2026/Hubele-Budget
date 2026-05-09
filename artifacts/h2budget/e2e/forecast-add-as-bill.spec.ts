import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #526:
 *
 * The Forecast inbox's "Add as bill" dialog (#522) promotes a bank txn
 * into a recurring item without leaving Review. It has client-side
 * validation:
 *   - Name is required.
 *   - Amount must be a non-negative number.
 *   - When `frequency === "onetime"`, an anchor date is required.
 * After a successful submit the new recurring item must show up in the
 * Planned forecast items (`plan-row-{itemId}-{date}`) and on the Bills
 * page (`row-bill-{itemId}`).
 *
 * The spec drives the dialog end-to-end:
 *   1. Seed a single bank inbox txn so the "Add as bill" button renders.
 *   2. Open the dialog via `inbox-add-as-bill-{txnId}`, switch frequency
 *      to "onetime", clear the seeded date, and assert that submit is
 *      blocked (toast + dialog stays open + no recurring item created).
 *   3. Refill the date, submit, assert the success toast, and verify the
 *      new recurring item lands in Planned forecast items and on /bills.
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
 * A current-month day a few days ahead but capped at 28 so it's always a
 * valid calendar day. Used as the bank txn date (and therefore the
 * dialog's seeded anchorDate).
 */
function pickAnchorDate(): { iso: string } {
  const d = new Date();
  const target = Math.min(Math.max(d.getDate() + 3, 5), 28);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return { iso: `${year}-${month}-${String(target).padStart(2, "0")}` };
}

test.describe("Forecast inbox 'Add as bill' dialog (#526)", () => {
  test("blocks one-time submit without a date, then creates a recurring item that surfaces in Planned forecast items and on Bills", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-add-as-bill-526",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });

    const { iso: anchorIso } = pickAnchorDate();
    const suffix = Math.random().toString(36).slice(2, 8);
    const billName = `AddAsBill-${suffix}`;

    // Seed a single bank inbox txn (no matching plan → it stays in
    // the inbox and exposes the "Add as bill" affordance).
    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: anchorIso,
        description: `INBOX-${suffix} ADD-AS-BILL`,
        amount: "-87.65",
        forecastFlag: true,
      },
    );

    await page.goto("/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });

    const addBtn = page.getByTestId(`inbox-add-as-bill-${txn.id}`);
    await expect(addBtn).toBeVisible({ timeout: 15_000 });
    await addBtn.click();

    const dialog = page.getByTestId("dialog-add-as-bill");
    await expect(dialog).toBeVisible();

    // Override the seeded "Untitled"/raw-description name with a
    // deterministic one we can look up later on the Bills page.
    const nameInput = dialog.getByTestId("input-add-bill-name");
    await nameInput.fill(billName);
    // The amount was seeded from the bank txn (87.65); leave it as-is
    // so we also assert the seeded value flows through end-to-end.
    await expect(dialog.getByTestId("input-add-bill-amount")).toHaveValue(
      "87.65",
    );

    // Switch frequency to one-time. The Radix Select fires its
    // onValueChange synchronously, after which the date field is shown.
    await dialog.getByTestId("select-add-bill-frequency").click();
    await page.getByRole("option", { name: "One-time" }).click();

    // The dialog reuses the seeded anchorDate when switching frequency,
    // so explicitly clear it to exercise the "onetime requires date"
    // validation branch. `fill("")` on type="date" inputs doesn't always
    // round-trip through React's onChange in WebKit/Chromium, so we use
    // the native value setter and dispatch a real input/change event so
    // the controlled component's state is actually emptied.
    const anchorInput = dialog.getByTestId("input-add-bill-anchor");
    await expect(anchorInput).toBeVisible();
    await anchorInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(anchorInput).toHaveValue("");

    // Snapshot the recurring-items count so we can prove the blocked
    // submit didn't accidentally persist anything.
    const beforeBlocked = await apiCall<Array<{ id: string; name: string }>>(
      page,
      "GET",
      "/api/recurring-items",
    );
    const matchesBlocked = beforeBlocked.filter((r) => r.name === billName);
    expect(matchesBlocked.length).toBe(0);

    await dialog.getByTestId("button-add-bill-save").click();

    await expect(
      page.getByText(/Pick a date for the one-time item/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // The dialog must stay open (submit was blocked) …
    await expect(dialog).toBeVisible();
    // … and no recurring item should have been created server-side.
    const afterBlocked = await apiCall<Array<{ id: string; name: string }>>(
      page,
      "GET",
      "/api/recurring-items",
    );
    expect(afterBlocked.filter((r) => r.name === billName).length).toBe(0);

    // Now fill the date and submit for real.
    await anchorInput.fill(anchorIso);
    await expect(anchorInput).toHaveValue(anchorIso);

    await dialog.getByTestId("button-add-bill-save").click();

    await expect(
      page
        .getByText(new RegExp(`Added "${billName}" as a recurring bill`))
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });

    // Server-side: a single recurring item with the right shape exists.
    const afterCreate = await apiCall<
      Array<{
        id: string;
        name: string;
        kind: string;
        amount: string;
        frequency: string;
        anchorDate: string | null;
      }>
    >(page, "GET", "/api/recurring-items");
    const created = afterCreate.filter((r) => r.name === billName);
    expect(created.length).toBe(1);
    const recurring = created[0];
    expect(recurring.kind).toBe("bill");
    expect(recurring.frequency).toBe("onetime");
    // Amount is stored as a string; just compare numerically to avoid
    // bikeshedding on trailing zeros.
    expect(parseFloat(recurring.amount)).toBeCloseTo(87.65, 2);
    expect(recurring.anchorDate).toBe(anchorIso);

    // Planned forecast items: the one-time item lands as a plan row at
    // its anchor date (testid `plan-row-{itemId}-{date}`).
    const planRow = page.getByTestId(
      `plan-row-${recurring.id}-${anchorIso}`,
    );
    await expect(planRow).toBeVisible({ timeout: 15_000 });
    await expect(planRow).toContainText(billName);

    // Bills page: the new recurring item shows as a row keyed by its id.
    await page.goto("/bills");
    const billRow = page.getByTestId(`row-bill-${recurring.id}`);
    await expect(billRow).toBeVisible({ timeout: 15_000 });
    await expect(billRow).toContainText(billName);
  });
});
