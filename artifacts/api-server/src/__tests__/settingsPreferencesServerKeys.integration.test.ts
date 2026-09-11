import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { and, asc, eq } from "drizzle-orm";

/**
 * PUT /settings replaces `settings.preferences` wholesale with whatever the
 * generated `UpdateSettingsBody` lets through. That zod object strips every key
 * the OpenAPI spec does not list, so the preference keys the SERVER writes
 * (the Amex anchor, the one-shot heal stamp, the budget migration gates) were
 * silently deleted by any web preferences save, even one that spread the
 * previous preferences back in (`{...prev, ...patch}`).
 *
 * These go through the real routes, the way the web calls them. The last
 * describe is a source scan that keeps `SERVER_OWNED_PREFERENCE_KEYS` honest.
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

import {
  db,
  pool,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  mappingRulesTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { UpdateSettingsBody } from "@workspace/api-zod";
import settingsRouter, { SERVER_OWNED_PREFERENCE_KEYS } from "../routes/settings";
import budgetRouter from "../routes/budget";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

// Settings and budget together, so a settings save can be followed by the
// budget read that used to re-run the May 2026 reset.
const routes = express.Router();
routes.use(settingsRouter);
routes.use(budgetRouter);
const { request, baseUrl } = createTestApp(routes);

// Shaped exactly as the server writes them.
const AMEX_ANCHOR = {
  balance: 4321.09,
  asOf: "2026-09-10T15:04:05.000Z",
  lastAutoBalance: 4321.09,
};
const CLEANUP_STAMP = "2026-08-01T12:00:00.000Z";

const SERVER_KEYS_SEEDED = {
  amexAnchor: AMEX_ANCHOR,
  amexCleanupDoneAt: CLEANUP_STAMP,
  budgetCategoriesV2: true,
  budgetMay2026AmountsV1: true,
};

const SEEDED_PREFS = {
  ...SERVER_KEYS_SEEDED,
  weeklyAllowanceOverrides: { "2026-08-30": "150.00", "2026-09-06": "175.00" },
  amexCardCadence: { "acct-blue": "monthly", "acct-plat": "weekly" },
  dismissedDetectedSubs: ["Hulu"],
};

const MAY_2026 = "2026-05-01";

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
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, TEST_USER));
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
      ...SERVER_KEYS_SEEDED,
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
    // The browser read the settings before a server write moved the anchor.
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

  it("server keys sent as null or false are ignored", async () => {
    const res = await request("PUT", "/settings", {
      preferences: {
        weeklyAllowanceOverrides: { "2026-08-30": "150.00" },
        amexAnchor: null,
        amexCleanupDoneAt: null,
        budgetCategoriesV2: false,
        budgetMay2026AmountsV1: false,
      },
    });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual({
      weeklyAllowanceOverrides: { "2026-08-30": "150.00" },
      ...SERVER_KEYS_SEEDED,
    });
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

  it("preferences: {} clears the user's keys but keeps the server's", async () => {
    const res = await request("PUT", "/settings", { preferences: {} });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual(SERVER_KEYS_SEEDED);
  });

  it("preferences: null clears the user's keys but keeps the server's", async () => {
    const res = await request("PUT", "/settings", { preferences: null });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual(SERVER_KEYS_SEEDED);
  });

  it("preferences: null on a row with no server keys still stores null", async () => {
    await seed({ weeklyAllowanceOverrides: { "2026-08-30": "150.00" } });
    const res = await request("PUT", "/settings", { preferences: null });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toBeNull();
  });

  it("the first PUT, with no settings row yet, creates the row with the preferences sent", async () => {
    await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
    const res = await request("PUT", "/settings", {
      preferences: { weeklyAllowanceOverrides: { "2026-09-13": "200.00" } },
    });
    expect(res.status).toBe(200);
    expect(await storedPrefs()).toEqual({
      weeklyAllowanceOverrides: { "2026-09-13": "200.00" },
    });
  });

  it("array, string or number preferences are rejected with 400 and change nothing", async () => {
    for (const bad of [["weeklyAllowanceOverrides"], "weeklyAllowanceOverrides", 42]) {
      const res = await request("PUT", "/settings", { preferences: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await storedPrefs()).toEqual(SEEDED_PREFS);
  });

  it("a __proto__ key in the body is stripped, never stored", async () => {
    // Raw JSON: an object literal with __proto__ would set a prototype, not a key.
    const res = await fetch(`${baseUrl()}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"preferences":{"__proto__":{"polluted":true},"weeklyAllowanceOverrides":{"2026-08-30":"150.00"}}}',
    });
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ has: boolean }>(
      `select preferences ? '__proto__' as has from settings where user_id = $1`,
      [TEST_USER],
    );
    expect(rows[0]?.has).toBe(false);
    expect(await storedPrefs()).toEqual({
      weeklyAllowanceOverrides: { "2026-08-30": "150.00" },
      ...SERVER_KEYS_SEEDED,
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("waits for a server write still in flight and keeps it (the row lock)", async () => {
    // A server writer (e.g. POST /amex/anchor) has updated the row but not
    // committed. The PUT must wait for it, then read the new anchor; without
    // the lock it reads the old one and writes it back over the new.
    const NEW_ANCHOR = {
      balance: 5000.5,
      asOf: "2026-09-11T18:00:00.000Z",
      lastAutoBalance: 5000.5,
    };
    const client = await pool.connect();
    let committed = false;
    let put: Promise<{ status: number; json: unknown }> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        `update settings
            set preferences = jsonb_set(preferences, '{amexAnchor}', $1::jsonb),
                updated_at = now()
          where user_id = $2`,
        [JSON.stringify(NEW_ANCHOR), TEST_USER],
      );
      put = request("PUT", "/settings", {
        preferences: {
          ...SEEDED_PREFS,
          weeklyAllowanceOverrides: { "2026-09-13": "200.00" },
        },
      });
      let settled = false;
      void put.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      await client.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    const res = await put!;
    expect(res.status).toBe(200);
    const after = await storedPrefs();
    expect(after?.amexAnchor).toEqual(NEW_ANCHOR);
    expect(after?.weeklyAllowanceOverrides).toEqual({ "2026-09-13": "200.00" });
  });
});

describe("end to end: a settings save does not re-run the May 2026 budget reset", () => {
  async function mayLines(): Promise<Array<[string, string]>> {
    const rows = await db
      .select({
        categoryId: budgetLinesTable.categoryId,
        plannedAmount: budgetLinesTable.plannedAmount,
      })
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.householdId, TEST_HOUSEHOLD_ID),
          eq(budgetLinesTable.monthStart, MAY_2026),
        ),
      )
      .orderBy(asc(budgetLinesTable.categoryId));
    return rows.map((r) => [String(r.categoryId), r.plannedAmount]);
  }

  async function mayPinned(): Promise<boolean | undefined> {
    const [m] = await db
      .select({ pinned: budgetMonthsTable.pinned })
      .from(budgetMonthsTable)
      .where(
        and(
          eq(budgetMonthsTable.householdId, TEST_HOUSEHOLD_ID),
          eq(budgetMonthsTable.monthStart, MAY_2026),
        ),
      );
    return m?.pinned;
  }

  it("a web allowance save, then a May 2026 read, leaves the May planned lines and the pin alone", async () => {
    // A real household: seeded categories, the May reset already run once.
    await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
    expect((await request("POST", "/budget/seed-defaults")).status).toBe(200);
    expect((await request("GET", `/budget/months/${MAY_2026}`)).status).toBe(200);
    expect((await storedPrefs())?.budgetMay2026AmountsV1).toBe(true);

    // The household then hand-edits a May line, and clear-budget-pinned-state
    // (#777) unpins the month.
    const [misc] = await db
      .select({ id: budgetCategoriesTable.id })
      .from(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.householdId, TEST_HOUSEHOLD_ID),
          eq(budgetCategoriesTable.name, "Misc / Buffer"),
        ),
      );
    expect(misc).toBeTruthy();
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "999.00" })
      .where(
        and(
          eq(budgetLinesTable.householdId, TEST_HOUSEHOLD_ID),
          eq(budgetLinesTable.monthStart, MAY_2026),
          eq(budgetLinesTable.categoryId, misc!.id),
        ),
      );
    await db
      .update(budgetMonthsTable)
      .set({ pinned: false })
      .where(
        and(
          eq(budgetMonthsTable.householdId, TEST_HOUSEHOLD_ID),
          eq(budgetMonthsTable.monthStart, MAY_2026),
        ),
      );
    const before = await mayLines();
    expect(before.find(([id]) => id === String(misc!.id))?.[1]).toBe("999.00");

    // A web preferences save, then the May budget read.
    expect(
      (await webPatch({ weeklyAllowanceOverrides: { "2026-09-13": "200.00" } })).status,
    ).toBe(200);
    expect((await request("GET", `/budget/months/${MAY_2026}`)).status).toBe(200);

    expect(await mayLines()).toEqual(before);
    expect(await mayPinned()).toBe(false);
    expect((await storedPrefs())?.budgetMay2026AmountsV1).toBe(true);
  });
});

/**
 * Guard for the hand-kept list. Scans the API server's own source (src and
 * scripts, never tests) for writes of a preference key and fails when a key is
 * neither server-owned nor in the spec, i.e. a key PUT /settings would strip.
 *
 * What it recognises, which is how every writer is shaped today:
 *   - an object literal that spreads a `*prefs` variable and adds keys
 *     (`{ ...prefs, amexAnchor: … }`, `{ ...(prefs ?? {}), budgetCategoriesV2: true }`);
 *   - `delete (<…prefs>).key`;
 *   - `jsonb_set(preferences, '{key}', …)` in SQL.
 * A writer shaped otherwise (spreading `s?.preferences` directly, say) is not
 * seen. The first test fails if the scan stops seeing a writer it sees today.
 */
describe("SERVER_OWNED_PREFERENCE_KEYS matches the server's preference writers", () => {
  const API_ROOT = fileURLToPath(new URL("../../", import.meta.url));

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "__tests__"].includes(entry.name)) continue;
        out.push(...sourceFiles(full));
      } else if (/\.m?ts$/.test(entry.name) && !/\.test\.m?ts$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  function skipQuoted(src: string, i: number): number {
    const quote = src[i];
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") {
        j++;
        continue;
      }
      if (src[j] === quote) return j;
    }
    return src.length;
  }

  /** The other top-level keys of the object literal a spread at `start` sits in. */
  function siblingKeys(src: string, start: number): string[] {
    const keys: string[] = [];
    let depth = 0;
    let entryStart = start;
    const take = (end: number) => {
      const entry = src.slice(entryStart, end).trim();
      if (entry.startsWith("...")) return;
      const m = /^(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:/.exec(entry);
      if (m) keys.push((m[1] ?? m[2])!);
    };
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skipQuoted(src, i);
      } else if (c === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        if (nl < 0) break;
        i = nl;
      } else if (c === "/" && src[i + 1] === "*") {
        const endComment = src.indexOf("*/", i + 2);
        if (endComment < 0) break;
        i = endComment + 1;
      } else if (c === "(" || c === "{" || c === "[") {
        depth++;
      } else if (c === ")" || c === "}" || c === "]") {
        if (depth === 0) {
          take(i);
          break;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        take(i);
        entryStart = i + 1;
      }
    }
    return keys;
  }

  type Write = { key: string; where: string };

  function scanWrites(): Write[] {
    const writes: Write[] = [];
    const files = [
      ...sourceFiles(join(API_ROOT, "src")),
      ...sourceFiles(join(API_ROOT, "scripts")),
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const where = (index: number) =>
        `${relative(API_ROOT, file)}:${src.slice(0, index).split("\n").length}`;
      for (const m of src.matchAll(/\.\.\.\s*\(*\s*([A-Za-z_$][\w$]*)/g)) {
        if (!/prefs$/i.test(m[1]!)) continue;
        for (const key of siblingKeys(src, m.index!)) {
          writes.push({ key, where: where(m.index!) });
        }
      }
      for (const m of src.matchAll(
        /delete\s+\(?\s*[A-Za-z_$][\w$]*prefs\b[^;\n]*?\)?\s*\.\s*([A-Za-z_$][\w$]*)/gi,
      )) {
        writes.push({ key: m[1]!, where: where(m.index!) });
      }
      for (const m of src.matchAll(/jsonb_set\(\s*[^,]*preferences[^,]*,\s*'\{([\w$]+)/g)) {
        writes.push({ key: m[1]!, where: where(m.index!) });
      }
    }
    return writes;
  }

  const specKeys = new Set(
    Object.keys(UpdateSettingsBody.shape.preferences.unwrap().options[0].shape),
  );
  const serverOwned = new Set<string>(SERVER_OWNED_PREFERENCE_KEYS);

  it("the scan still sees every server-owned key being written", () => {
    const seen = new Set(scanWrites().map((w) => w.key));
    for (const key of SERVER_OWNED_PREFERENCE_KEYS) {
      expect(seen.has(key), `scan no longer sees a write of ${key}`).toBe(true);
    }
  });

  it("every preference key the server writes is server-owned or in the spec", () => {
    const unlisted = scanWrites().filter(
      (w) => !serverOwned.has(w.key) && !specKeys.has(w.key),
    );
    expect(
      unlisted.map((w) => `${w.where} writes preferences.${w.key}`),
      "add the key to SERVER_OWNED_PREFERENCE_KEYS (server-written) or to the spec (user-written)",
    ).toEqual([]);
  });

  it("no key is both server-owned and in the spec", () => {
    expect([...serverOwned].filter((k) => specKeys.has(k))).toEqual([]);
  });
});
