// ⭐ (PR-B1) ALLOWANCE PLANS — the backfill, the owner-only writer, the
// suggestion, and the law that nothing automatic ever writes a plan.
//
// The backfill is the REAL file (lib/db/migrations/0040_allowance_plans.sql),
// run against real rows, twice. All figures are synthetic.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const H1_OWNER = `allow-h1-${process.pid}-${randomUUID().slice(0, 8)}`;
const H1_MEMBER = `allow-h1m-${process.pid}-${randomUUID().slice(0, 8)}`;
const H2_OWNER = `allow-h2-${process.pid}-${randomUUID().slice(0, 8)}`;
const H3_OWNER = `allow-h3-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      headers: Record<string, string | string[] | undefined>;
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? H1_OWNER);
    const hh = HH[who]!;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  pool,
  allowancePlansTable,
  avalancheSettingsTable,
  debtsTable,
  householdMembersTable,
  recurringItemsTable,
  settingsTable,
} from "@workspace/db";
import { everydayPlan, everydayPlanFromRows, addDaysISO, weekBounds } from "@workspace/avalanche-core";
import moneyRouter from "../routes/money";
import settingsRouter from "../routes/settings";
import { householdTodayISO } from "../lib/householdClock";
import { createTestHousehold } from "./_helpers/testHousehold";
import { loadAllowancePlans, planRowsOf } from "../lib/allowancePlans";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../../lib/db/migrations");
const SRC = resolve(HERE, "..");

const app = express();
app.use(express.json());
app.use(moneyRouter);
app.use(settingsRouter);
let server: Server;
let baseUrl: string;

async function call(method: "GET" | "PUT" | "POST", path: string, as: string, body?: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-test-user": as, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

const runSql = async (file: string) => {
  await pool.query(readFileSync(join(MIGRATIONS, file), "utf8"));
};

const OWNERS = [H1_OWNER, H2_OWNER, H3_OWNER];
const householdIds = () => OWNERS.map((o) => HH[o]!.householdId);

async function plansOf(owner: string) {
  return db
    .select()
    .from(allowancePlansTable)
    .where(eq(allowancePlansTable.householdId, HH[owner]!.householdId));
}

async function cleanup(): Promise<void> {
  if (Object.keys(HH).length) {
    await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, householdIds()));
  }
  await db.delete(settingsTable).where(inArray(settingsTable.userId, OWNERS));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, OWNERS));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, OWNERS));
  await db.delete(avalancheSettingsTable).where(inArray(avalancheSettingsTable.userId, OWNERS));
}

const H1_OVERRIDES = { "2026-10-04": "275", "2026-10-11": "12abc", "2026-10-07": "1" };

beforeAll(async () => {
  for (const o of OWNERS) HH[o] = await createTestHousehold(o);
  await db
    .insert(householdMembersTable)
    .values({ userId: H1_MEMBER, householdId: HH[H1_OWNER]!.householdId, role: "member" })
    .onConflictDoNothing();
  HH[H1_MEMBER] = { householdId: HH[H1_OWNER]!.householdId, ownerUserId: H1_OWNER };
  await cleanup();

  // The owners' standing allowances, as the classic Allowances page saved them.
  await db.insert(settingsTable).values([
    { userId: H1_OWNER, householdId: HH[H1_OWNER]!.householdId, weeklyAllowanceAmount: "300.00", monthlyAllowanceAmount: "400.00", preferences: { weeklyAllowanceOverrides: H1_OVERRIDES } },
    { userId: H2_OWNER, householdId: HH[H2_OWNER]!.householdId, weeklyAllowanceAmount: "0", monthlyAllowanceAmount: "0" },
    { userId: H3_OWNER, householdId: HH[H3_OWNER]!.householdId, weeklyAllowanceAmount: "125.50", monthlyAllowanceAmount: "0" },
  ]);

  // H1's plans and debts, for the suggestion.
  const h1 = { userId: H1_OWNER, householdId: HH[H1_OWNER]!.householdId };
  const [car] = await db
    .insert(debtsTable)
    .values([
      { ...h1, name: "Visa", balance: "3000", minPayment: "85", status: "active" },
      { ...h1, name: "Car loan", balance: "7000", minPayment: "310", status: "active" },
      { ...h1, name: "Old card", balance: "0", minPayment: "999", status: "paid_off" },
    ])
    .returning();
  await db.insert(recurringItemsTable).values([
    { ...h1, name: "Paycheck", kind: "income", amount: "2000", frequency: "biweekly", anchorDate: "2026-10-09" },
    { ...h1, name: "Mortgage", kind: "bill", amount: "1800", frequency: "monthly", dayOfMonth: 12 },
    { ...h1, name: "Streaming", kind: "subscription", amount: "15.99", frequency: "monthly", dayOfMonth: 3 },
    { ...h1, name: "Weekly Spend", kind: "bill", amount: "300", frequency: "weekly", anchorDate: "2026-10-10" },
    { ...h1, name: "Car payment", kind: "bill", amount: "350", frequency: "monthly", dayOfMonth: 20, debtId: car!.id },
    { ...h1, name: "Gym", kind: "bill", amount: "40", frequency: "monthly", dayOfMonth: 1, active: "false" },
  ]);
  await db.insert(avalancheSettingsTable).values({ ...h1, manualExtra: "250" });

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, H1_MEMBER));
});

describe("0040_allowance_plans.sql — the backfill", () => {
  it("writes one weekly and one monthly household-pool row per non-zero amount, and nothing the second time", async () => {
    await runSql("0040_allowance_plans.sql");
    await runSql("0041_recurring_amount_kind.sql");
    const shape = async (o: string) =>
      (await plansOf(o))
        .map((p) => ({ member: p.memberUserId, period: p.period, amount: p.amount, from: p.effectiveFrom, source: p.source, by: p.createdByKind }))
        .sort((a, b) => a.period.localeCompare(b.period));
    const first = { h1: await shape(H1_OWNER), h2: await shape(H2_OWNER), h3: await shape(H3_OWNER) };
    expect(first.h1).toEqual([
      { member: null, period: "monthly", amount: "400.00", from: "2026-05-01", source: "owner", by: "user" },
      { member: null, period: "weekly", amount: "300.00", from: "2026-05-01", source: "owner", by: "user" },
    ]);
    expect(first.h2).toEqual([]); // $0 means no plan was ever set
    expect(first.h3).toEqual([{ member: null, period: "weekly", amount: "125.50", from: "2026-05-01", source: "owner", by: "user" }]);

    // Twice more: idempotent, row for row.
    await runSql("0040_allowance_plans.sql");
    await runSql("0041_recurring_amount_kind.sql");
    await runSql("0040_allowance_plans.sql");
    expect({ h1: await shape(H1_OWNER), h2: await shape(H2_OWNER), h3: await shape(H3_OWNER) }).toEqual(first);

    // 0041: every existing plan reads "fixed", and the column refuses anything else.
    const items = await db.select({ k: recurringItemsTable.amountKind }).from(recurringItemsTable).where(eq(recurringItemsTable.userId, H1_OWNER));
    expect(items.length).toBe(6);
    expect(new Set(items.map((i) => i.k))).toEqual(new Set(["fixed"]));
    await expect(
      db.update(recurringItemsTable).set({ amountKind: "guess" }).where(eq(recurringItemsTable.userId, H1_OWNER)),
    ).rejects.toThrow();
  });

  it("⭐ everydayPlanFromRows(backfilled rows) agrees with everydayPlan(settings) for every fixture household, every week", async () => {
    let weeks = 0;
    for (const owner of OWNERS) {
      const [s] = await db.select().from(settingsTable).where(eq(settingsTable.userId, owner));
      const prefs = (s!.preferences ?? {}) as { weeklyAllowanceOverrides?: Record<string, string> };
      const rows = planRowsOf(await loadAllowancePlans(HH[owner]!.householdId));
      for (let sunday = "2026-04-26"; sunday <= "2027-05-02"; sunday = addDaysISO(sunday, 7)) {
        const want = everydayPlan(sunday, { weeklyAllowanceAmount: s!.weeklyAllowanceAmount, monthlyAllowanceAmount: s!.monthlyAllowanceAmount }, prefs.weeklyAllowanceOverrides);
        const got = everydayPlanFromRows(sunday, rows, prefs.weeklyAllowanceOverrides);
        expect({ weeklyCents: got.weeklyCents, monthlyCents: got.monthlyCents }, `${owner} ${sunday}`).toEqual(want);
        weeks++;
      }
    }
    expect(weeks).toBe(3 * 54);
    // Not vacuous: H1's override week and an unparsable override both went through.
    const h1 = planRowsOf(await loadAllowancePlans(HH[H1_OWNER]!.householdId));
    expect(everydayPlanFromRows("2026-10-04", h1, H1_OVERRIDES).weeklyCents).toBe(27500);
    expect(everydayPlanFromRows("2026-10-11", h1, H1_OVERRIDES).weeklyCents).toBe(30000);
  });

  it("the CHECK refuses a plan written by anything but a person", async () => {
    await expect(
      db.insert(allowancePlansTable).values({
        householdId: HH[H2_OWNER]!.householdId,
        period: "weekly",
        amount: "999",
        effectiveFrom: "2026-11-01",
        source: "derived",
        createdByKind: "job",
      }),
    ).rejects.toThrow();
    expect(await plansOf(H2_OWNER)).toEqual([]);
  });
});

describe("GET /allowance-plans", () => {
  it("lists the household's plans and the suggested weekly cap with its working", async () => {
    const r = await call("GET", "/allowance-plans", H1_MEMBER);
    expect(r.status).toBe(200);
    expect(r.body.plans.map((p: { period: string; amount: string }) => [p.period, p.amount]).sort()).toEqual([
      ["monthly", "400.00"],
      ["weekly", "300.00"],
    ]);
    // take-home 2,000 × 26/12 = 4,333.33; committed 1,800 + 15.99 (Weekly Spend,
    // the debt-linked car payment and the paused gym are out); minimums 85 + 310;
    // extra 250 → 1,872.34 a month → × 12/52 = 432.08 → $430.
    expect(r.body.suggested).toEqual({
      weekly: "430.00",
      derivation: {
        takeHomeMonthly: "4333.33",
        committedMonthly: "1815.99",
        debtMinimumsMonthly: "395.00",
        extraMonthly: "250.00",
        goalsMonthly: "0.00",
        discretionaryMonthly: "1872.34",
      },
    });
    // Reading wrote nothing.
    expect((await plansOf(H1_OWNER)).length).toBe(2);
  });

  it("another household sees only its own plans", async () => {
    const r = await call("GET", "/allowance-plans", H3_OWNER);
    expect(r.body.plans.map((p: { amount: string }) => p.amount)).toEqual(["125.50"]);
  });
});

describe("PUT /allowance-plans/:id — the owner only", () => {
  const weeklyOf = async (o: string) => (await plansOf(o)).find((p) => p.period === "weekly")!;

  it("a member of the household is refused, and nothing changes", async () => {
    const plan = await weeklyOf(H1_OWNER);
    const r = await call("PUT", `/allowance-plans/${plan.id}`, H1_MEMBER, { amount: "999.00" });
    expect(r.status).toBe(403);
    expect((await weeklyOf(H1_OWNER)).amount).toBe("300.00");
  });

  it("the owner sets the amount: source 'owner', a person wrote it, and the backfill never overwrites it", async () => {
    const plan = await weeklyOf(H1_OWNER);
    await db.update(allowancePlansTable).set({ source: "derived", derivation: { suggestedWeekly: "430.00" } }).where(eq(allowancePlansTable.id, plan.id));
    const r = await call("PUT", `/allowance-plans/${plan.id}`, H1_OWNER, { amount: "320.5" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: plan.id, period: "weekly", amount: "320.50", source: "owner", derivation: null, effectiveFrom: "2026-05-01" });
    const stored = await weeklyOf(H1_OWNER);
    expect([stored.amount, stored.source, stored.createdByKind, stored.derivation]).toEqual(["320.50", "owner", "user", null]);
    await runSql("0040_allowance_plans.sql");
    expect((await plansOf(H1_OWNER)).length).toBe(2);
    expect((await weeklyOf(H1_OWNER)).amount).toBe("320.50");
  });

  it("another household's plan is not found — not even to its own owner", async () => {
    const plan = await weeklyOf(H1_OWNER);
    const r = await call("PUT", `/allowance-plans/${plan.id}`, H3_OWNER, { amount: "1.00" });
    expect(r.status).toBe(404);
    expect((await weeklyOf(H1_OWNER)).amount).toBe("320.50");
    expect((await call("PUT", `/allowance-plans/not-a-uuid`, H1_OWNER, { amount: "1.00" })).status).toBe(404);
  });

  it("refuses an amount that is not dollars and cents, and a date that is not on the calendar", async () => {
    const plan = await weeklyOf(H1_OWNER);
    for (const body of [{ amount: "12.345" }, { amount: "-5" }, { amount: "abc" }, {}, { amount: "10", effectiveFrom: "2026-02-30" }, { amount: "10", effectiveFrom: "10/04/2026" }]) {
      expect((await call("PUT", `/allowance-plans/${plan.id}`, H1_OWNER, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await weeklyOf(H1_OWNER)).amount).toBe("320.50");
  });

  it("a start date another plan of the same period already has is a conflict", async () => {
    const [later] = await db
      .insert(allowancePlansTable)
      .values({ householdId: HH[H1_OWNER]!.householdId, period: "weekly", amount: "350", effectiveFrom: "2026-11-01", source: "owner" })
      .returning();
    const r = await call("PUT", `/allowance-plans/${later!.id}`, H1_OWNER, { amount: "350", effectiveFrom: "2026-05-01" });
    expect(r.status).toBe(409);
    const moved = await call("PUT", `/allowance-plans/${later!.id}`, H1_OWNER, { amount: "360", effectiveFrom: "2026-12-06" });
    expect(moved.status).toBe(200);
    expect(moved.body.effectiveFrom).toBe("2026-12-06");
    await db.delete(allowancePlansTable).where(and(eq(allowancePlansTable.id, later!.id)));
  });
});

describe("(Round 2, Q4) the classic Allowances page's save is mirrored into the plan", () => {
  it("a changed allowance upserts this week's household-pool plan, and the position reads it at once", async () => {
    // This test runs on the real clock: clear H1's per-week overrides so the
    // plan in effect, not an override, is what the week reads.
    await db.update(settingsTable).set({ preferences: {} }).where(eq(settingsTable.userId, H1_OWNER));
    const thisSunday = weekBounds(householdTodayISO()).start;
    const capNow = async () => (await call("GET", "/money/position", H1_MEMBER)).body.weekCap as string | null;
    const weeklyRows = async () =>
      (await plansOf(H1_OWNER)).filter((p) => p.period === "weekly").sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    expect(await capNow()).toBe("320.50");
    const before = await weeklyRows();

    // A household member saves a new weekly allowance on the classic page.
    expect((await call("PUT", "/settings", H1_MEMBER, { weeklyAllowanceAmount: "410" })).status).toBe(200);
    const after = await weeklyRows();
    expect(after.length).toBe(before.length + 1);
    const mirrored = after.find((p) => p.effectiveFrom === thisSunday)!;
    expect([mirrored.amount, mirrored.source, mirrored.createdByKind, mirrored.memberUserId, mirrored.derivation]).toEqual([
      "410.00",
      "owner",
      "user",
      null,
      null,
    ]);
    expect(await capNow()).toBe("410.00");
    // Past weeks keep the cap they had.
    expect(after.find((p) => p.effectiveFrom === "2026-05-01")!.amount).toBe("320.50");

    // A second save in the same week updates that row; saving the same value, or another field, writes nothing.
    await call("PUT", "/settings", H1_MEMBER, { weeklyAllowanceAmount: "425" });
    await call("PUT", "/settings", H1_MEMBER, { weeklyAllowanceAmount: "425.00", unplannedAllowanceAmount: "50" });
    expect((await weeklyRows()).length).toBe(before.length + 1);
    expect(await capNow()).toBe("425.00");

    // The monthly allowance mirrors on its own.
    await call("PUT", "/settings", H1_MEMBER, { monthlyAllowanceAmount: "380" });
    const monthly = (await plansOf(H1_OWNER)).filter((p) => p.period === "monthly");
    expect(monthly.find((p) => p.effectiveFrom === thisSunday)?.amount).toBe("380.00");

    // $0 on the classic page means no cap (Q2): a $0 row, read as none.
    await call("PUT", "/settings", H1_MEMBER, { weeklyAllowanceAmount: "0" });
    expect((await weeklyRows()).find((p) => p.effectiveFrom === thisSunday)!.amount).toBe("0.00");
    expect(await capNow()).toBeNull();

    // …and so does a $0 override for this week: never a $0 cap.
    await call("PUT", "/settings", H1_MEMBER, { weeklyAllowanceAmount: "410" });
    expect(await capNow()).toBe("410.00");
    await db
      .update(settingsTable)
      .set({ preferences: { weeklyAllowanceOverrides: { [thisSunday]: "0" } } })
      .where(eq(settingsTable.userId, H1_OWNER));
    expect(await capNow()).toBeNull();
  });
});

describe("⚠️ nothing automatic writes a plan", () => {
  /** Every .ts file under `dir`, recursively; none when the directory does not exist yet. */
  function sourcesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...sourcesUnder(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }
  const writesPlans = (file: string): boolean =>
    /allowancePlanWriter|allowancePlansTable|allowance_plans/.test(readFileSync(file, "utf8"));

  it("no file under src/jobs or src/ai imports the writer or names the table", () => {
    const files = [...sourcesUnder(join(SRC, "jobs")), ...sourcesUnder(join(SRC, "ai"))];
    for (const f of files) expect(writesPlans(f), f).toBe(false);
  });

  it("the scan is live: it finds the two user-initiated routes that do write, and no other", () => {
    expect(writesPlans(join(SRC, "routes", "money.ts"))).toBe(true);
    expect(
      sourcesUnder(join(SRC, "routes"))
        .filter(writesPlans)
        .map((f) => f.slice(SRC.length + 1))
        .sort(),
    ).toEqual(["routes/money.ts", "routes/settings.ts"]);
  });
});
