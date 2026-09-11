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
      // Wait until the PUT's backend is blocked on this transaction's row lock,
      // instead of sleeping a fixed time. With the lock, the blocked statement is
      // the PUT's SELECT … FOR UPDATE, which then reads the committed anchor.
      // Without it, the PUT's plain SELECT has already read the old anchor and
      // its UPDATE is what blocks.
      const blockerPid = (
        await client.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      const deadline = Date.now() + 15_000;
      let blocked = 0;
      while (Date.now() < deadline && !settled) {
        const { rows } = await pool.query<{ n: number }>(
          `select count(*)::int as n
             from pg_stat_activity
            where wait_event_type = 'Lock'
              and $1 = any(pg_blocking_pids(pid))`,
          [blockerPid],
        );
        blocked = rows[0]?.n ?? 0;
        if (blocked > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(settled, "the PUT finished while the server write was uncommitted").toBe(false);
      expect(blocked, "the PUT never blocked on the server write's row lock").toBe(1);
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
 * Guard for the hand-kept list. Scans the server's own source for writes of a
 * settings preference key and fails when a key is neither server-owned nor in
 * the spec, i.e. a key PUT /settings would strip.
 *
 * Where: `artifacts/api-server/src`, `artifacts/api-server/scripts` and the
 * repo-root `scripts/` (home of `restoreAmexAnchor.ts`). Test files are skipped.
 *
 * Which files: only files that use `settingsTable`. The per-user UI preferences
 * writer (`routes/me.ts`, `userUiPreferencesTable`) spreads `*Prefs` variables
 * too, and never touches this column.
 *
 * What it reads, after blanking comment text and regex-literal bodies:
 *   - an object literal that spreads a `*prefs` / `preferences` variable and adds
 *     keys (`{ ...prefs, amexAnchor: … }`, `{ ...(prefs ?? {}), budgetCategoriesV2: true }`);
 *   - `delete (<…prefs>).key`;
 *   - `jsonb_set(preferences, '{key}', …)` in SQL.
 *
 * Limits (also residual 5 in the review note):
 *   - a file that uses `settingsTable` is scanned whole, so a `*Prefs` spread in it
 *     that feeds some other table is flagged;
 *   - a writer in a file that never names `settingsTable` (raw SQL through a
 *     helper, say) is not scanned;
 *   - a writer shaped otherwise (spreading `s?.preferences` directly, or setting
 *     keys one by one) is not seen;
 *   - a regex literal is told from a division by the character or keyword before
 *     the `/`, the usual heuristic, and a backtick inside `${…}` in a template
 *     literal is not followed.
 * The first test fails if the scan stops seeing a writer it sees today.
 */
describe("SERVER_OWNED_PREFERENCE_KEYS matches the server's preference writers", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
  const SCAN_ROOTS = [
    join(REPO_ROOT, "artifacts/api-server/src"),
    join(REPO_ROOT, "artifacts/api-server/scripts"),
    join(REPO_ROOT, "scripts"),
  ];

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

  /** Index of the closing quote of the string or template literal opening at `i`. */
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

  /** End (exclusive, flags included) of a regex literal opening at `start`, or -1. */
  function regexEnd(src: string, start: number): number {
    let inClass = false;
    for (let j = start + 1; j < src.length; j++) {
      const ch = src[j];
      if (ch === "\n") return -1;
      if (ch === "\\") {
        j++;
        continue;
      }
      if (inClass) {
        if (ch === "]") inClass = false;
        continue;
      }
      if (ch === "[") {
        inClass = true;
        continue;
      }
      if (ch === "/") {
        let k = j + 1;
        while (k < src.length && /[a-z]/i.test(src[k]!)) k++;
        return k;
      }
    }
    return -1;
  }

  const REGEX_AFTER_CHAR = "(,=:[!&|?{};+-*%<>~^";
  const REGEX_AFTER_WORD = new Set([
    "return", "typeof", "case", "do", "else", "in", "of", "instanceof",
    "new", "delete", "void", "throw", "yield", "await",
  ]);

  /**
   * `src` with comment text and regex-literal bodies replaced by spaces.
   * Newlines are kept, so offsets and line numbers do not move; strings are left
   * as they are (SQL lives in them).
   */
  function blankCommentsAndRegex(src: string): string {
    const out = src.split("");
    const blank = (from: number, to: number) => {
      for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
    };
    let prevChar = "";
    let prevWord = "";
    let i = 0;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        const end = nl < 0 ? src.length : nl;
        blank(i, end);
        i = end;
      } else if (c === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i + 2);
        const end = close < 0 ? src.length : close + 2;
        blank(i, end);
        i = end;
      } else if (c === '"' || c === "'" || c === "`") {
        i = skipQuoted(src, i) + 1;
        prevChar = c;
        prevWord = "";
      } else if (
        c === "/" &&
        (prevChar === "" || REGEX_AFTER_CHAR.includes(prevChar) || REGEX_AFTER_WORD.has(prevWord)) &&
        regexEnd(src, i) > 0
      ) {
        const end = regexEnd(src, i);
        blank(i, end);
        i = end;
        prevChar = "0";
        prevWord = "";
      } else if (/\s/.test(c)) {
        i++;
      } else if (/[\w$]/.test(c)) {
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j]!)) j++;
        prevWord = src.slice(i, j);
        prevChar = src[j - 1]!;
        i = j;
      } else {
        prevChar = c;
        prevWord = "";
        i++;
      }
    }
    return out.join("");
  }

  /** The other top-level keys of the object literal a spread at `start` sits in. */
  function siblingKeys(code: string, start: number): string[] {
    const keys: string[] = [];
    let depth = 0;
    let entryStart = start;
    const take = (end: number) => {
      const entry = code.slice(entryStart, end).trim();
      if (entry.startsWith("...")) return;
      const m = /^(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:/.exec(entry);
      if (m) keys.push((m[1] ?? m[2])!);
    };
    for (let i = start; i < code.length; i++) {
      const c = code[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skipQuoted(code, i);
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

  /** Settings preference keys one source file writes (none if it never uses `settingsTable`). */
  function writesInSource(src: string, file: string): Write[] {
    const code = blankCommentsAndRegex(src);
    if (!/\bsettingsTable\b/.test(code)) return [];
    const where = (index: number) => `${file}:${code.slice(0, index).split("\n").length}`;
    const writes: Write[] = [];
    for (const m of code.matchAll(/\.\.\.\s*\(*\s*([A-Za-z_$][\w$]*)/g)) {
      if (!/(prefs|^preferences)$/i.test(m[1]!)) continue;
      for (const key of siblingKeys(code, m.index!)) {
        writes.push({ key, where: where(m.index!) });
      }
    }
    for (const m of code.matchAll(
      /delete\s+\(?\s*[A-Za-z_$][\w$]*prefs\b[^;\n]*?\)?\s*\.\s*([A-Za-z_$][\w$]*)/gi,
    )) {
      writes.push({ key: m[1]!, where: where(m.index!) });
    }
    for (const m of code.matchAll(/jsonb_set\(\s*[^,]*preferences[^,]*,\s*'\{([\w$]+)/g)) {
      writes.push({ key: m[1]!, where: where(m.index!) });
    }
    return writes;
  }

  function scanWrites(): Write[] {
    return SCAN_ROOTS.flatMap(sourceFiles).flatMap((file) =>
      writesInSource(readFileSync(file, "utf8"), relative(REPO_ROOT, file)),
    );
  }

  const specKeys = new Set(
    Object.keys(UpdateSettingsBody.shape.preferences.unwrap().options[0].shape),
  );
  const serverOwned = new Set<string>(SERVER_OWNED_PREFERENCE_KEYS);

  it("the scan still sees every server-owned key being written", () => {
    const writes = scanWrites();
    const seen = new Set(writes.map((w) => w.key));
    for (const key of SERVER_OWNED_PREFERENCE_KEYS) {
      expect(seen.has(key), `scan no longer sees a write of ${key}`).toBe(true);
    }
    // The repo-root scripts/ folder is scanned too.
    expect(
      writes.some((w) => w.where.startsWith("scripts/src/restoreAmexAnchor.ts:")),
    ).toBe(true);
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

  // The scanner on the shapes that fooled its first version.
  const SETTINGS_READ =
    "const [s] = await db.select({ preferences: settingsTable.preferences }).from(settingsTable);\n" +
    "const prefs = (s?.preferences ?? {}) as Record<string, unknown>;\n";

  it("scanner: a preference write inside a comment is not a write", () => {
    const src =
      SETTINGS_READ +
      "// const next = { ...prefs, commentOnlyKey: 1 };\n" +
      "/* const other = { ...prefs, blockCommentKey: 1 }; */\n" +
      "const nextPrefs = { ...prefs, amexAnchor: 1 };\n";
    expect(writesInSource(src, "probe.ts").map((w) => w.key)).toEqual(["amexAnchor"]);
  });

  it("scanner: a file that never uses settingsTable (the per-user UI preferences writer) is skipped", () => {
    const src =
      "const merged = { ...existingUiPrefs, sidebarCollapsed: true };\n" +
      "await db.insert(userUiPreferencesTable).values({ userId, preferences: merged });\n";
    expect(writesInSource(src, "probe.ts")).toEqual([]);
  });

  it("scanner: a quote inside a regex literal does not hide the keys after it", () => {
    const src =
      SETTINGS_READ +
      'const nextPrefs = { ...prefs, re: /["]/.source, afterRegexKey: 1 };\n' +
      'const later = { ...prefs, laterKey: "x" };\n';
    expect(writesInSource(src, "probe.ts").map((w) => w.key)).toEqual([
      "re",
      "afterRegexKey",
      "laterKey",
    ]);
  });

  it("scanner: a real unlisted writer is reported with its file and line", () => {
    const src =
      SETTINGS_READ + "const nextPrefs = {\n  ...(prefs ?? {}),\n  someNewServerFlag: true,\n};\n";
    expect(writesInSource(src, "probe.ts")).toEqual([
      { key: "someNewServerFlag", where: "probe.ts:4" },
    ]);
  });
});
