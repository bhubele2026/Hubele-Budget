import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  recurringItemsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  debtsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #690 — the two user-facing pieces that
 * shipped without dedicated specs:
 *
 *   1. Picking a category on a bill (via the Bills modal) must make the
 *      bill's monthly amount flow into that envelope on /budget — i.e.
 *      planned_source = "bills". A silent regression here would leave
 *      the user staring at a $0 planned column even though their bill
 *      is clearly linked.
 *
 *   2. Adding a line under the "My budget" card must create a manual
 *      category in that group (and that line must survive a reload —
 *      i.e. actually persisted, not just a transient list mutation).
 *
 *   3. A debt-linked bill must hide / disable the Category picker and
 *      show the "managed by the Debt Tracker" hint — otherwise users
 *      could accidentally re-route a debt-min into the wrong envelope,
 *      double-counting it with the Debts-derived row.
 *
 * Each test provisions a fresh Clerk user + household so the data is
 * fully isolated. The afterAll teardown removes every seeded row before
 * deleting the Clerk users so the next run starts clean.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
      await db
        .delete(budgetLinesTable)
        .where(eq(budgetLinesTable.userId, userId));
      await db
        .delete(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.userId, userId));
      await db.delete(debtsTable).where(eq(debtsTable.userId, userId));
    } catch {
      // best-effort — Clerk teardown below still runs
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Category picker + My budget bucket (#690)", () => {
  test("picking a category in the Bills modal flows the bill's amount into that envelope on /budget", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "bills-cat-picker-rollup",
      provisionedUserIds,
    );
    await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const context = await browser.newContext();
    const page = await context.newPage();

    // First /budget GET seeds the default category list. We land there
    // so the household has groups in place, then pre-create one extra
    // manual category we'll pick from the Bills modal picker (so the
    // assertion below isn't coupled to the names of the seeded defaults).
    await signInAndOpen(page, email, password, "/budget?month=2026-05-01");
    await expect(
      page.getByRole("heading", { name: /^budget$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const catName = `E2E Picker Cat ${Math.random().toString(36).slice(2, 7)}`;
    const createCatResp = await page.request.post("/api/budget/categories", {
      data: {
        name: catName,
        kind: "expense",
        groupName: "Bills",
        sourceKind: "manual",
      },
    });
    expect(createCatResp.ok()).toBeTruthy();
    const category = (await createCatResp.json()) as { id: string; name: string };

    // --- Drive the picker through the actual UI ----------------------
    // Open the Bills page, click "Add bill", fill the form, expand the
    // select-category dropdown, and pick the category by its testid.
    // This is the regression risk the task explicitly calls out: we want
    // to lock in the picker → save → rollup path, not just the API.
    await page.goto("/bills?month=2026-05-01");
    await expect(
      page.getByRole("heading", { name: /^bills$/i }),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("button-add-bill").click();
    await expect(page.getByTestId("input-name")).toBeVisible();

    const billName = `E2E Linked Bill ${Math.random().toString(36).slice(2, 7)}`;
    await page.getByTestId("input-name").fill(billName);
    await page.getByTestId("input-amount").fill("120");
    // Default frequency is monthly; ensure the day-of-month input is the
    // one rendered (it is for monthly/semimonthly) and pick a stable day.
    await page.getByTestId("input-day-of-month").fill("15");

    // Open the Radix Select trigger, then click the option whose testid
    // is keyed by our just-created category id. The Radix SelectContent
    // is a scrollable popover, and with all the seeded defaults our new
    // entry can land below the popover's visible area — so scroll it
    // into view first before clicking.
    await page.getByTestId("select-category").click();
    const option = page.getByTestId(`select-category-option-${category.id}`);
    await option.waitFor({ state: "attached", timeout: 10_000 });
    // Radix SelectContent is a portalled, internally-scrollable popover
    // that sits outside the page viewport; Playwright's normal
    // visibility / scroll checks can't reach into it. Scrolling the
    // option into view inside the popover via the DOM and then
    // force-clicking is the reliable way to pick it.
    await option.evaluate((el) =>
      (el as HTMLElement).scrollIntoView({ block: "center" }),
    );
    await option.click({ force: true });

    await page.getByTestId("button-save").click();
    // The dialog closes on a successful save; assert that before moving
    // on so a silent error toast doesn't get masked by the navigation.
    await expect(page.getByTestId("input-name")).toHaveCount(0, {
      timeout: 10_000,
    });

    // --- Verify the rollup on /budget --------------------------------
    await page.goto("/budget?month=2026-05-01");
    await expect(
      page.getByRole("heading", { name: /^budget$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const plannedInput = page.getByTestId(`input-planned-${category.id}`);
    await expect(plannedInput).toBeVisible({ timeout: 15_000 });
    await expect(plannedInput).toHaveValue("120", { timeout: 15_000 });

    // Strong provenance check: open the "where did this come from?"
    // popover and assert that the bill we just created is listed as a
    // contributing bill (planned_source = "bills"). Without this, the
    // input could be at 120 from any source (manual override, pin, etc).
    await page.getByTestId(`button-planned-source-${category.id}`).click();
    const billList = page.getByTestId("planned-source-bill-list");
    await expect(billList).toBeVisible({ timeout: 10_000 });
    await expect(billList.getByText(billName, { exact: false })).toBeVisible();

    await context.close();
  });

  test('clicking "Add line" under My budget creates a new envelope that survives reload', async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "budget-my-budget-add",
      provisionedUserIds,
    );
    await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/budget?month=2026-05-01");

    await expect(
      page.getByRole("heading", { name: /^budget$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const group = page.getByTestId("group-My budget");
    await expect(group).toBeVisible({ timeout: 15_000 });

    const lineName = `E2E Envelope ${Math.random().toString(36).slice(2, 7)}`;

    await page.getByTestId("button-add-line-My budget").click();
    const input = page.getByTestId("input-new-line-My budget");
    await expect(input).toBeVisible();
    await input.fill(lineName);
    await page.getByTestId("button-confirm-add-My budget").click();

    // The new envelope should render inside the My budget card.
    await expect(group.getByText(lineName, { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Persistence check — a hard reload must keep the envelope inside
    // the My budget group (not migrate to "Other" or vanish entirely).
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^budget$/i }),
    ).toBeVisible({ timeout: 15_000 });
    const groupAfterReload = page.getByTestId("group-My budget");
    await expect(
      groupAfterReload.getByText(lineName, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // And it landed in the correct group on the server side.
    const catsResp = await page.request.get("/api/budget/categories");
    expect(catsResp.ok()).toBeTruthy();
    const cats = (await catsResp.json()) as Array<{
      name: string;
      groupName: string;
      sourceKind: string;
    }>;
    const created = cats.find((c) => c.name === lineName);
    expect(created).toBeDefined();
    expect(created!.groupName).toBe("My budget");
    expect(created!.sourceKind).toBe("manual");

    await context.close();
  });

  test("a debt-linked bill disables the Category picker and shows the debt-managed hint", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "bills-cat-picker-debt-linked",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/budget?month=2026-05-01");
    await expect(
      page.getByRole("heading", { name: /^budget$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Seed a debt directly so the recurring item we attach can pass
    // householdOwnsDebt on POST /api/recurring-items. Start it active +
    // with a positive minPayment so the POST validation passes, then
    // quiesce it below.
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "E2E Debt Card",
        balance: "1500",
        apr: "0.1999",
        minPayment: "50",
        dueDay: 15,
        status: "active",
      })
      .returning();

    // A recurring "bill" item linked to that debt — this is what makes
    // `editing.debtId` truthy in the Bills modal, which is the condition
    // that disables the picker and replaces its caption with the
    // "managed by Debts" hint.
    const billResp = await page.request.post("/api/recurring-items", {
      data: {
        name: "E2E Debt Min Bill",
        kind: "bill",
        amount: "50",
        frequency: "monthly",
        dayOfMonth: 15,
        active: "true",
        debtId: debt.id,
      },
    });
    expect(billResp.ok()).toBeTruthy();
    const bill = (await billResp.json()) as { id: string };

    // buildDebtMinSchedule suppresses any recurring item whose debtId
    // points at an *active* (or just-paid-off) debt — it folds them into
    // the locked Debt minimums card instead. We want the recurring item
    // to render as a regular bill row (so we can click into the modal
    // and assert the picker hint), so neutralize the debt by zeroing its
    // balance + minPayment. The recurring item still carries the debtId
    // FK, which is all the modal needs to flip into "managed by Debts"
    // mode.
    await db
      .update(debtsTable)
      .set({ balance: "0", minPayment: "0", status: "paidoff" })
      .where(eq(debtsTable.id, debt.id));

    await page.goto("/bills?month=2026-05-01");
    await expect(
      page.getByRole("heading", { name: /^bills$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId(`row-bill-${bill.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // The edit modal opens; for debt-linked bills the picker stays
    // visible (so the user can see the wiring) but is disabled and the
    // caption flips to the debt-managed hint.
    const picker = page.getByTestId("select-category");
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await expect(picker).toBeDisabled();
    await expect(
      page.getByText(/Linked to a debt[\s\S]*Debt — Minimum Payments/i),
    ).toBeVisible();
    // Negative assertion: the non-debt caption ("Pick an envelope…") must
    // not also be present, otherwise both hints would render at once.
    await expect(
      page.getByText(/Pick an envelope to roll this item into/i),
    ).toHaveCount(0);

    await context.close();
  });
});
