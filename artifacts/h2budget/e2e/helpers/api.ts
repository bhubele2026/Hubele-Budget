import type { Page } from "@playwright/test";

/**
 * Tiny seed helpers used by the e2e specs to put deterministic fixture data
 * on a freshly-provisioned test user before asserting UI behavior. Each
 * helper drives the same JSON API the React client uses, so the assertions
 * exercise the real server pipeline (debts → bills schedule, recurring
 * items → forecast plan rows). Auth piggy-backs on the page's Clerk session
 * cookie via `page.request`.
 */

export type SeededDebt = {
  id: string;
  name: string;
};

export type SeededRecurringItem = {
  id: string;
  name: string;
  dayOfMonth: number;
};

async function postJson<T>(
  page: Page,
  path: string,
  data: Record<string, unknown>,
): Promise<T> {
  const resp = await page.request.post(path, { data });
  if (!resp.ok()) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `POST ${path} failed: ${resp.status()} ${resp.statusText()} ${body}`,
    );
  }
  return (await resp.json()) as T;
}

/**
 * Create a manual debt the Bills page will surface as a debt-min row. We
 * include a balance, APR, minPayment, and a dueDay so `buildDebtMinSchedule`
 * emits a row with a real next-occurrence date.
 */
export async function seedDebt(
  page: Page,
  overrides: Partial<{
    name: string;
    balance: string;
    apr: string;
    minPayment: string;
    dueDay: number;
  }> = {},
): Promise<SeededDebt> {
  const today = new Date();
  const dueDay = overrides.dueDay ?? Math.min(today.getDate() + 5, 28);
  const body = {
    name: overrides.name ?? `E2E Debt ${Math.random().toString(36).slice(2, 7)}`,
    balance: overrides.balance ?? "1500.00",
    apr: overrides.apr ?? "0.1999",
    minPayment: overrides.minPayment ?? "75.00",
    dueDay,
    status: "active",
  };
  const row = await postJson<{ id: string; name: string }>(
    page,
    "/api/debts",
    body,
  );
  return { id: row.id, name: row.name };
}

/**
 * Create an active monthly recurring bill that will produce a future plan
 * row in the forecast register, which is what makes the per-row "Move to…"
 * button appear (only `pending_plan` and `future` rows are movable).
 */
export async function seedRecurringBill(
  page: Page,
  overrides: Partial<{
    name: string;
    amount: string;
    dayOfMonth: number;
  }> = {},
): Promise<SeededRecurringItem> {
  const today = new Date();
  // Pick a day that is comfortably in the future but still inside the
  // default forecast horizon. Cap at 28 so it lands every month.
  const dayOfMonth =
    overrides.dayOfMonth ?? Math.min(today.getDate() + 5, 28);
  const body = {
    name:
      overrides.name ?? `E2E Bill ${Math.random().toString(36).slice(2, 7)}`,
    kind: "bill",
    amount: overrides.amount ?? "120.00",
    frequency: "monthly",
    dayOfMonth,
    active: "true",
  };
  const row = await postJson<{ id: string; name: string }>(
    page,
    "/api/recurring-items",
    body,
  );
  return { id: row.id, name: row.name, dayOfMonth };
}
