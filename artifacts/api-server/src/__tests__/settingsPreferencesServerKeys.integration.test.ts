import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

/**
 * PUT /settings replaces `settings.preferences` wholesale with whatever the
 * generated `UpdateSettingsBody` lets through. That zod object strips every key
 * the OpenAPI spec does not list, so the preference keys the SERVER writes
 * (the Amex anchor, the one-shot heal stamp, the budget migration gates) were
 * silently deleted by any web preferences save, even one that spread the
 * previous preferences back in (`{...prev, ...patch}`).
 *
 * These go through the real route, the way the web calls it.
 */

const TEST_USER = `settings-prefs-${process.pid}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
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

import { db, settingsTable } from "@workspace/db";
import settingsRouter from "../routes/settings";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const { request } = createTestApp(settingsRouter);

// Shaped exactly as the server writes them.
const AMEX_ANCHOR = {
  balance: 4321.09,
  asOf: "2026-09-10T15:04:05.000Z",
  lastAutoBalance: 4321.09,
};
const CLEANUP_STAMP = "2026-08-01T12:00:00.000Z";

const SEEDED_PREFS = {
  amexAnchor: AMEX_ANCHOR,
  amexCleanupDoneAt: CLEANUP_STAMP,
  budgetCategoriesV2: true,
  budgetMay2026AmountsV1: true,
  weeklyAllowanceOverrides: { "2026-08-30": "150.00", "2026-09-06": "175.00" },
  amexCardCadence: { "acct-blue": "monthly", "acct-plat": "weekly" },
  dismissedDetectedSubs: ["Hulu"],
};

async function seed(preferences: Record<string, unknown> | null): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, preferences })
    .onConflictDoUpdate({
      target: settingsTable.userId,
      set: { preferences, updatedAt: new Date() },
    });
}

async function storedPrefs(): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, TEST_USER));
  return (row?.preferences as Record<string, unknown> | null) ?? null;
}

/** GET /settings, then PUT `{...prev, ...patch}`, the way the web saves a preference. */
async function webPatch(patch: Record<string, unknown>) {
  const got = await request("GET", "/settings");
  expect(got.status).toBe(200);
  const prev =
    ((got.json as { preferences?: Record<string, unknown> | null }).preferences ??
      {}) as Record<string, unknown>;
  return request("PUT", "/settings", { preferences: { ...prev, ...patch } });
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
});

beforeEach(async () => {
  await seed(SEEDED_PREFS);
});

afterAll(async () => {
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
});

describe("PUT /settings keeps server-owned preference keys", () => {
  it("an allowance-override save keeps amexAnchor, amexCleanupDoneAt and the budget gates", async () => {
    // The GET hands the server keys to the browser, so `prev` carries them.
    const got = await request("GET", "/settings");
    const prev = (got.json as { preferences: Record<string, unknown> }).preferences;
    expect(prev.amexAnchor).toEqual(AMEX_ANCHOR);
    expect(prev.amexCleanupDoneAt).toBe(CLEANUP_STAMP);

    const res = await webPatch({
      weeklyAllowanceOverrides: {
        ...(SEEDED_PREFS.weeklyAllowanceOverrides as Record<string, string>),
        "2026-09-13": "200.00",
      },
    });
    expect(res.status).toBe(200);

    const after = await storedPrefs();
    expect(after?.amexAnchor).toEqual(AMEX_ANCHOR);
    expect(after?.amexCleanupDoneAt).toBe(CLEANUP_STAMP);
    expect(after?.budgetCategoriesV2).toBe(true);
    expect(after?.budgetMay2026AmountsV1).toBe(true);
    expect(after?.weeklyAllowanceOverrides).toEqual({
      "2026-08-30": "150.00",
      "2026-09-06": "175.00",
      "2026-09-13": "200.00",
    });
    // The route's response is the row it wrote.
    expect(
      (res.json as { preferences: Record<string, unknown> }).preferences.amexAnchor,
    ).toEqual(AMEX_ANCHOR);
  });

  it("an amexCardCadence change keeps amexAnchor", async () => {
    const res = await webPatch({
      amexCardCadence: { "acct-blue": "weekly", "acct-plat": "weekly" },
    });
    expect(res.status).toBe(200);
    const after = await storedPrefs();
    expect(after?.amexCardCadence).toEqual({
      "acct-blue": "weekly",
      "acct-plat": "weekly",
    });
    expect(after?.amexAnchor).toEqual(AMEX_ANCHOR);
    expect(after?.amexCleanupDoneAt).toBe(CLEANUP_STAMP);
  });

  it("removing a week from weeklyAllowanceOverrides still removes it (nested maps are replaced, not merged)", async () => {
    const res = await webPatch({
      weeklyAllowanceOverrides: { "2026-09-06": "175.00" },
    });
    expect(res.status).toBe(200);
    const after = await storedPrefs();
    expect(after?.weeklyAllowanceOverrides).toEqual({ "2026-09-06": "175.00" });
    expect(after?.amexAnchor).toEqual(AMEX_ANCHOR);
  });

  it("a user key left out of the body is still dropped (PUT is not a general merge)", async () => {
    const res = await request("PUT", "/settings", {
      preferences: { weeklyAllowanceOverrides: { "2026-08-30": "150.00" } },
    });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual({
      weeklyAllowanceOverrides: { "2026-08-30": "150.00" },
      amexAnchor: AMEX_ANCHOR,
      amexCleanupDoneAt: CLEANUP_STAMP,
      budgetCategoriesV2: true,
      budgetMay2026AmountsV1: true,
    });
  });

  it("a PUT without preferences leaves preferences untouched", async () => {
    const res = await request("PUT", "/settings", { weeklyAllowanceAmount: "425.00" });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual(SEEDED_PREFS);
    const [row] = await db
      .select({ weekly: settingsTable.weeklyAllowanceAmount })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(Number(row?.weekly)).toBe(425);
  });

  it("a stale amexAnchor in the body never overwrites the stored one", async () => {
    // The browser read the settings before a Plaid sync moved the anchor.
    const stale = { balance: 1000, asOf: "2026-09-01T00:00:00.000Z", lastAutoBalance: 1000 };
    const res = await request("PUT", "/settings", {
      preferences: {
        ...SEEDED_PREFS,
        amexAnchor: stale,
        amexCleanupDoneAt: "2020-01-01T00:00:00.000Z",
        weeklyAllowanceOverrides: { "2026-08-30": "150.00" },
      },
    });
    expect(res.status).toBe(200);
    const after = await storedPrefs();
    expect(after?.amexAnchor).toEqual(AMEX_ANCHOR);
    expect(after?.amexCleanupDoneAt).toBe(CLEANUP_STAMP);
  });

  it("a server key the row does not hold cannot be planted through PUT /settings", async () => {
    await seed({ weeklyAllowanceOverrides: { "2026-08-30": "150.00" } });
    const res = await request("PUT", "/settings", {
      preferences: {
        weeklyAllowanceOverrides: { "2026-08-30": "150.00" },
        amexAnchor: { balance: 1, asOf: "2026-09-01T00:00:00.000Z", lastAutoBalance: 1 },
        budgetMay2026AmountsV1: true,
      },
    });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual({
      weeklyAllowanceOverrides: { "2026-08-30": "150.00" },
    });
  });

  it("preferences: null clears the user's keys but keeps the server's", async () => {
    const res = await request("PUT", "/settings", { preferences: null });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual({
      amexAnchor: AMEX_ANCHOR,
      amexCleanupDoneAt: CLEANUP_STAMP,
      budgetCategoriesV2: true,
      budgetMay2026AmountsV1: true,
    });
  });

  it("preferences: null on a row with no server keys still stores null", async () => {
    await seed({ weeklyAllowanceOverrides: { "2026-08-30": "150.00" } });
    const res = await request("PUT", "/settings", { preferences: null });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toBeNull();
  });
});
