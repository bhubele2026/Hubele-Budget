// (PR8r, owner decision 7) PUT /settings validates `preferences.everydayHooks`:
// an id the request sets or changes must be one of THIS household's active
// recurring items; null unlinks; an id already stored is not re-checked, so a web
// save of an unrelated preference never fails because a linked bill was paused.
// Through the real route, the way the web saves (GET, then PUT {...prev, ...patch}).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const RUN = `${process.pid}-${randomUUID().slice(0, 8)}`;
const TEST_USER = `pr8r-hooks-settings-${RUN}`;
const OTHER_USER = `pr8r-hooks-settings-other-${RUN}`;
let TEST_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import { db, recurringItemsTable, settingsTable } from "@workspace/db";
import settingsRouter from "../routes/settings";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const { request } = createTestApp(settingsRouter);

let WEEKLY: string;
let MONTHLY: string;
let PAUSED: string;
let OTHERS: string;

async function storedPrefs(): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, TEST_USER));
  return (row?.preferences as Record<string, unknown> | null) ?? null;
}

async function webPatch(patch: Record<string, unknown>) {
  const got = await request("GET", "/settings");
  const prev = ((got.json as { preferences?: Record<string, unknown> | null }).preferences ?? {}) as Record<string, unknown>;
  return request("PUT", "/settings", { preferences: { ...prev, ...patch } });
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  OTHER_HOUSEHOLD_ID = (await createTestHousehold(OTHER_USER)).householdId;
  const items = await db
    .insert(recurringItemsTable)
    .values([
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Weekly Spend", kind: "bill", amount: "450", frequency: "weekly", active: "true" },
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Monthly Spend", kind: "bill", amount: "400", frequency: "monthly", active: "true" },
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Old Spend", kind: "bill", amount: "300", frequency: "weekly", active: "false" },
      { userId: OTHER_USER, householdId: OTHER_HOUSEHOLD_ID, name: "Weekly Spend", kind: "bill", amount: "450", frequency: "weekly", active: "true" },
    ])
    .returning({ id: recurringItemsTable.id });
  [WEEKLY, MONTHLY, PAUSED, OTHERS] = items.map((i) => i.id) as [string, string, string, string];
});

beforeEach(async () => {
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
  await db.insert(settingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    preferences: { weeklyAllowanceOverrides: { "2026-09-06": "175.00" } },
  });
});

afterAll(async () => {
  await db.delete(settingsTable).where(inArray(settingsTable.userId, [TEST_USER, OTHER_USER]));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, [TEST_USER, OTHER_USER]));
});

describe("PUT /settings — everydayHooks", () => {
  it("links this household's own active items, and GET reads them back", async () => {
    const res = await webPatch({ everydayHooks: { weeklyItemId: WEEKLY, monthlyItemId: MONTHLY } });
    expect(res.status).toBe(200);
    expect((await storedPrefs())?.everydayHooks).toEqual({ weeklyItemId: WEEKLY, monthlyItemId: MONTHLY });
    expect((await storedPrefs())?.weeklyAllowanceOverrides).toEqual({ "2026-09-06": "175.00" });
    const got = await request("GET", "/settings");
    expect((got.json as { preferences: Record<string, unknown> }).preferences.everydayHooks).toEqual({
      weeklyItemId: WEEKLY,
      monthlyItemId: MONTHLY,
    });
  });

  it("another household's item, a paused item, an unknown id or a non-id: 400, and nothing changes", async () => {
    const before = await storedPrefs();
    for (const [key, id] of [
      ["weeklyItemId", OTHERS],
      ["weeklyItemId", PAUSED],
      ["monthlyItemId", randomUUID()],
      ["monthlyItemId", "not-an-id"],
    ] as const) {
      const res = await webPatch({ everydayHooks: { weeklyItemId: null, monthlyItemId: null, [key]: id } });
      expect(res.status, `${key}=${id}`).toBe(400);
      expect((res.json as { error: string }).error).toBe(`everydayHooks.${key} must be one of this household's active recurring items`);
      expect(await storedPrefs()).toEqual(before);
    }
  });

  it("null unlinks", async () => {
    expect((await webPatch({ everydayHooks: { weeklyItemId: WEEKLY, monthlyItemId: null } })).status).toBe(200);
    expect((await webPatch({ everydayHooks: { weeklyItemId: null, monthlyItemId: null } })).status).toBe(200);
    expect((await storedPrefs())?.everydayHooks).toEqual({ weeklyItemId: null, monthlyItemId: null });
  });

  it("an id already stored is not re-checked: a bill paused after linking never fails an unrelated save", async () => {
    await db
      .update(settingsTable)
      .set({ preferences: { everydayHooks: { weeklyItemId: PAUSED, monthlyItemId: null } } })
      .where(eq(settingsTable.userId, TEST_USER));
    const res = await webPatch({ weeklyAllowanceOverrides: { "2026-09-13": "200.00" } });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual({
      everydayHooks: { weeklyItemId: PAUSED, monthlyItemId: null },
      weeklyAllowanceOverrides: { "2026-09-13": "200.00" },
    });
    // Changing it to another paused id is checked.
    const [second] = await db
      .insert(recurringItemsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Older Spend", kind: "bill", amount: "250", frequency: "weekly", active: "false" })
      .returning({ id: recurringItemsTable.id });
    expect((await webPatch({ everydayHooks: { weeklyItemId: second!.id, monthlyItemId: null } })).status).toBe(400);
  });

  it("a malformed everydayHooks value is refused by the schema (400)", async () => {
    const res = await request("PUT", "/settings", { preferences: { everydayHooks: { weeklyItemId: 42 } } });
    expect(res.status).toBe(400);
  });
});
