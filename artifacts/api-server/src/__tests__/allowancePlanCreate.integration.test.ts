// ⭐ (S2) ALLOWANCE PLANS — SET SAFELY, KEEP HISTORY, LABEL THE RESERVE.
// The owner: "No weekly plan set" sits beside a $X "Weekly Spend" the forecast
// keeps every Saturday. Decisions (2026-10-14): show "Plan not set" plainly
// with a one-tap, confirmed "Use $X as the weekly plan from this week" (POST);
// nothing is set silently; editing a plan never erases the plan a past week was
// judged against (versioned PUT); one "no plan" rule for the position, the
// breakdown and the forecast hook.
//
// Synthetic households; every name, amount and account number is made up.
// Pinned now: Wed 2026-10-14 12:00 Central. This week Sun 10/11 – Sat 10/17;
// last week 10/4 – 10/10; the month is October.
//
// Household P — NO weekly plan, settings $0, a Weekly Spend hook stored at $380
//   on Saturdays. Chase Checking ••7701 (2,000.00 read Sun 10/11 08:00),
//   Amex Platinum ••3301.
//     last week  Plat 10/6  TARGET       −120.00 weekly
//     this week  Plat 10/12 HEB GROCERY   −40.00 weekly
//                Chase 10/13 SHELL OIL    −25.00 weekly
//   Spent this week (the weekly cap's pool) 40 + 25 = 65.00.
//   No plan: each Weekly Spend occurrence keeps the stored 380 (basis stored_amount).
//   After POST weekly 380 from 10/11: this week's payoff = card charges 40 +
//   what is left (380 − 65 = 315) = 355; next weeks 380; LAST week (no plan
//   then) keeps the stored 380 — past weeks are untouched.
//
// Household Q — history: a weekly plan $300 from Sun 9/27 (a fixture row, as if
//   set two weeks ago), a monthly plan $600 from 5/1, and last week's stored
//   daily metrics (as of Sat 10/10: weeklyCap 300).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const P = `s2-p-${tag}`;
const P_MEMBER = `s2-pm-${tag}`;
const Q = `s2-q-${tag}`;
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
    const who = String(req.headers["x-test-user"] ?? P);
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
  allowancePlansTable,
  forecastSettingsTable,
  householdMembersTable,
  householdMetricsDailyTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import {
  CreateAllowancePlanResponse,
  GetForecastCashSignalResponse,
  ListAllowancePlansResponse,
  UpdateAllowancePlanResponse,
} from "@workspace/api-zod";
import moneyRouter from "../routes/money";
import spineRouter from "../routes/spine";
import forecastRouter from "../routes/forecast";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { planStartProblem } from "../lib/allowancePlanWriter";

const NOW = new Date("2026-10-14T12:00:00-05:00");
const THIS_SUNDAY = "2026-10-11";
const LAST_SUNDAY = "2026-10-04";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(spineRouter);
app.use(forecastRouter);

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
async function get<T>(path: string, as: string): Promise<T> {
  const r = await call("GET", path, as);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

type Plan = { id: string; period: string; amount: string; effectiveFrom: string; source: string; memberUserId: string | null };
type Saved = Plan & { created: boolean; inEffect: { weekly: Plan | null; monthly: Plan | null } };
type Plans = {
  plans: Plan[];
  inEffect: { weekly: Plan | null; monthly: Plan | null };
  prefills: Array<{ period: string; amount: string; source: string; label: string }>;
};
type Position = { weekCap: string | null; spentWeekDiscretionary: string; remainingWeek: string | null; withinPlan: string | null };
type Breakdown = {
  plan: { status: string; amount: string | null; source: string; planId: string | null; effectiveFrom: string | null };
  actual: string;
  remaining: string | null;
  over: string | null;
};
type Spine = {
  position: { remainingWeek: string | null; withinPlan: string | null };
  monthAllowance: { plan: string | null; actual: string; status: string };
};
type Signal = {
  events?: Array<{ date: string; amount: string; itemId?: string | null; occurrenceKey?: string; originalDate?: string; assumption?: string | null }>;
  hookAmountIgnored?: Array<{ itemId: string; cadence: string; storedAmount: string }>;
  hookReserves?: Array<{ hook: string; recurringItemId: string; planKey: string; occurrenceDate: string; label: string; amount: string; basis: string }>;
};

const week = (start: string) => `/money/period-breakdown?period=week&start=${start}`;
const month = (start: string) => `/money/period-breakdown?period=month&start=${start}`;
const SIGNAL = "/forecast/cash-signal?horizonDays=30";

const acct: Record<string, string> = {};
let pWeeklySpend = "";

async function cleanup(): Promise<void> {
  const users = [P, Q];
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length) {
    await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, hhIds));
    await db.delete(householdMetricsDailyTable).where(inArray(householdMetricsDailyTable.householdId, hhIds));
  }
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, users));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, users));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, users));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, users));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, users));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, users));
}

async function seedAccount(user: string, key: string, slug: "chase" | "amex", name: string, mask: string, type: string, subtype: string) {
  const hh = HH[user]!.householdId;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: user, householdId: hh, itemId: `item-${randomUUID()}`, accessToken: "t", institutionSlug: slug })
    .returning();
  const ext = `${key}-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(plaidAccountsTable)
    .values({ userId: user, householdId: hh, itemId: item!.id, accountId: ext, name, mask, type, subtype })
    .returning();
  acct[key] = ext;
  return row!.id;
}

async function txn(user: string, t: { on: string; desc: string; amount: string; account: string; weekly?: boolean }) {
  const isChase = t.account.endsWith("chase");
  await db.insert(transactionsTable).values({
    userId: user,
    householdId: HH[user]!.householdId,
    occurredOn: t.on,
    description: t.desc,
    amount: t.amount,
    plaidAccountId: acct[t.account]!,
    source: isChase ? "plaid:chase" : "plaid:amex",
    weeklyAllowance: t.weekly ?? false,
    forecastFlag: isChase,
    createdAt: createdAtStartOfHouseholdDay(t.on),
  });
}

/** A household with checking, a card, a forecast anchor and (optionally) a Weekly Spend hook. */
async function seedHousehold(user: string, prefix: string, opts: { hookStored?: string }) {
  const hh = HH[user]!.householdId;
  const chase = await seedAccount(user, `${prefix}chase`, "chase", "Chase Checking", prefix === "p" ? "7701" : "7702", "depository", "checking");
  await seedAccount(user, `${prefix}plat`, "amex", "Amex Platinum", prefix === "p" ? "3301" : "3302", "credit", "credit card");
  await db.insert(forecastSettingsTable).values({
    userId: user,
    householdId: hh,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2000.00",
    bankSnapshotAt: new Date("2026-10-11T08:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chase,
  });
  let hookId: string | null = null;
  if (opts.hookStored) {
    const [ws] = await db
      .insert(recurringItemsTable)
      .values({ userId: user, householdId: hh, name: "Weekly Spend", kind: "bill", amount: opts.hookStored, frequency: "weekly", anchorDate: "2026-10-17", active: "true" })
      .returning();
    hookId = ws!.id;
  }
  await db.insert(settingsTable).values({
    userId: user,
    householdId: hh,
    weeklyAllowanceAmount: "0",
    monthlyAllowanceAmount: "0",
    preferences: hookId ? { everydayHooks: { weekly: { recurringItemId: hookId }, monthly: null } } : {},
  });
  return hookId;
}

const plansOf = async (user: string) =>
  db.select().from(allowancePlansTable).where(eq(allowancePlansTable.householdId, HH[user]!.householdId));

beforeAll(async () => {
  vi.setSystemTime(NOW);
  for (const u of [P, Q]) HH[u] = await createTestHousehold(u);
  await db
    .insert(householdMembersTable)
    .values({ userId: P_MEMBER, householdId: HH[P]!.householdId, role: "member" })
    .onConflictDoNothing();
  HH[P_MEMBER] = { householdId: HH[P]!.householdId, ownerUserId: P };
  await cleanup();

  // ── Household P: no plan, a hook stored at $380.
  pWeeklySpend = (await seedHousehold(P, "p", { hookStored: "380" }))!;
  await txn(P, { on: "2026-10-06", desc: "TARGET", amount: "-120.00", account: "pplat", weekly: true });
  await txn(P, { on: "2026-10-12", desc: "HEB GROCERY", amount: "-40.00", account: "pplat", weekly: true });
  await txn(P, { on: "2026-10-13", desc: "SHELL OIL", amount: "-25.00", account: "pchase", weekly: true });

  // ── Household Q: a weekly plan from two weeks ago, a monthly plan from May.
  await seedHousehold(Q, "q", {});
  await db.insert(allowancePlansTable).values([
    { householdId: HH[Q]!.householdId, memberUserId: null, period: "weekly", amount: "300.00", effectiveFrom: "2026-09-27", source: "owner" },
    { householdId: HH[Q]!.householdId, memberUserId: null, period: "monthly", amount: "600.00", effectiveFrom: "2026-05-01", source: "owner" },
  ]);
  await db.insert(householdMetricsDailyTable).values({ householdId: HH[Q]!.householdId, asOf: "2026-10-10", metrics: { weeklyCap: 300 } });
  await txn(Q, { on: "2026-10-06", desc: "CORNER MARKET", amount: "-90.00", account: "qplat", weekly: true });
  await txn(Q, { on: "2026-10-12", desc: "CORNER MARKET", amount: "-30.00", account: "qplat", weekly: true });

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, P_MEMBER));
});

const reserveOn = (sig: Signal, date: string) => sig.hookReserves?.find((r) => r.occurrenceDate === date);
const hookEventOn = (sig: Signal, occurrenceDate: string) =>
  (sig.events ?? []).find((e) => e.itemId === pWeeklySpend && (e.occurrenceKey ?? "").endsWith(`|${occurrenceDate}`));

describe("the start rule (pure)", () => {
  it("a weekly plan starts on a Sunday, a monthly one on the 1st, this period or later", () => {
    const today = "2026-10-14";
    expect(planStartProblem("weekly", THIS_SUNDAY, today)).toBeNull();
    expect(planStartProblem("weekly", "2026-10-18", today)).toBeNull();
    expect(planStartProblem("weekly", LAST_SUNDAY, today)).toBe("start_in_past");
    expect(planStartProblem("weekly", "2026-10-14", today)).toBe("start_not_a_sunday");
    expect(planStartProblem("weekly", "2026-02-30", today)).toBe("start_not_a_sunday");
    expect(planStartProblem("monthly", "2026-10-01", today)).toBeNull();
    expect(planStartProblem("monthly", "2026-11-01", today)).toBeNull();
    expect(planStartProblem("monthly", "2026-09-01", today)).toBe("start_in_past");
    expect(planStartProblem("monthly", "2026-10-11", today)).toBe("start_not_first_of_month");
    // Saturday 23:30 Central is still that week: its Sunday is the current start.
    expect(planStartProblem("weekly", "2026-10-11", "2026-10-17")).toBeNull();
    expect(planStartProblem("weekly", "2026-10-11", "2026-10-18")).toBe("start_in_past");
  });
});

describe("household P — no weekly plan: 'Plan not set', and the forecast keeps the stored reserve, labelled", () => {
  it("GET /allowance-plans: nothing in effect; the hook's stored amount is offered as an option, nothing written", async () => {
    const r = await get<Plans>("/allowance-plans", P_MEMBER);
    expect(() => ListAllowancePlansResponse.parse(r)).not.toThrow();
    expect(r.plans).toEqual([]);
    expect(r.inEffect).toEqual({ weekly: null, monthly: null });
    expect(r.prefills).toContainEqual({ period: "weekly", amount: "380.00", source: "hook_stored", label: "Weekly Spend reserve" });
    // Settings are $0: no "settings" option, never a $0 one.
    expect(r.prefills.filter((p) => p.source === "settings")).toEqual([]);
    expect(r.prefills.every((p) => Number(p.amount) > 0)).toBe(true);
    expect(await plansOf(P)).toEqual([]);
  });

  it("the position and the breakdown: no cap (null) — never a $0 cap", async () => {
    const [pos, b] = await Promise.all([get<Position>("/money/position", P), get<Breakdown>(week(THIS_SUNDAY), P)]);
    expect([pos.weekCap, pos.remainingWeek, pos.spentWeekDiscretionary]).toEqual([null, null, "65.00"]);
    expect(b.plan).toEqual({ status: "not_set", amount: null, source: "none", planId: null, effectiveFrom: null });
    expect(b.actual).toBe("65.00");
  });

  it("the cash signal: every Weekly Spend occurrence is the stored 380 with basis stored_amount — not a plan", async () => {
    const sig = await get<Signal>(SIGNAL, P);
    expect(() => GetForecastCashSignalResponse.parse(sig)).not.toThrow();
    expect(sig.hookAmountIgnored).toBeUndefined();
    for (const d of ["2026-10-10", "2026-10-17", "2026-10-24"]) {
      expect(reserveOn(sig, d), d).toEqual({
        hook: "weekly",
        recurringItemId: pWeeklySpend,
        planKey: `${pWeeklySpend}|${d}`,
        occurrenceDate: d,
        label: "Weekly Spend",
        amount: "380.00",
        basis: "stored_amount",
      });
    }
    expect(sig.hookReserves!.every((r) => r.basis === "stored_amount")).toBe(true);
    expect(hookEventOn(sig, "2026-10-17")?.amount).toBe("-380.00");
  });
});

describe("POST /allowance-plans — the rules", () => {
  it("a member of the household is refused (403), and nothing is written", async () => {
    const r = await call("POST", "/allowance-plans", P_MEMBER, { period: "weekly", amount: "380", effectiveFrom: THIS_SUNDAY });
    expect(r.status).toBe(403);
    expect(await plansOf(P)).toEqual([]);
  });

  it("a past Sunday, a weekday, an impossible date, $0, sub-cents and unknown keys are refused (400); nothing is written", async () => {
    const bad: Array<[unknown, string | null]> = [
      [{ period: "weekly", amount: "380", effectiveFrom: LAST_SUNDAY }, "effectiveFrom is in a past week or month"],
      [{ period: "weekly", amount: "380", effectiveFrom: "2026-10-14" }, "effectiveFrom is not a Sunday"],
      [{ period: "weekly", amount: "380", effectiveFrom: "2026-02-30" }, "effectiveFrom is not a calendar date"],
      [{ period: "weekly", amount: "0", effectiveFrom: THIS_SUNDAY }, "amount must be more than 0"],
      [{ period: "weekly", amount: "0.00", effectiveFrom: THIS_SUNDAY }, "amount must be more than 0"],
      [{ period: "weekly", amount: "12.345", effectiveFrom: THIS_SUNDAY }, null],
      [{ period: "weekly", amount: "-5", effectiveFrom: THIS_SUNDAY }, null],
      [{ period: "daily", amount: "5", effectiveFrom: THIS_SUNDAY }, null],
      [{ period: "weekly", amount: "380", effectiveFrom: "10/11/2026" }, null],
      [{ period: "weekly", amount: "380" }, null],
      [{ period: "weekly", amount: "380", effectiveFrom: THIS_SUNDAY, source: "derived" }, null],
      [{ period: "weekly", amount: "380", effectiveFrom: THIS_SUNDAY, memberUserId: P_MEMBER }, null],
    ];
    for (const [body, error] of bad) {
      const r = await call("POST", "/allowance-plans", P, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      if (error) expect(r.body.error, JSON.stringify(body)).toBe(error);
    }
    expect(await plansOf(P)).toEqual([]);
  });

  it("monthly: the 1st of this month or later; a later month's plan is not in effect yet", async () => {
    expect((await call("POST", "/allowance-plans", P, { period: "monthly", amount: "700", effectiveFrom: "2026-09-01" })).status).toBe(400);
    expect((await call("POST", "/allowance-plans", P, { period: "monthly", amount: "700", effectiveFrom: "2026-10-15" })).status).toBe(400);
    const r = await call("POST", "/allowance-plans", P, { period: "monthly", amount: "700", effectiveFrom: "2026-11-01" });
    expect(r.status).toBe(200);
    expect(() => CreateAllowancePlanResponse.parse(r.body)).not.toThrow();
    expect(r.body).toMatchObject({ period: "monthly", amount: "700.00", effectiveFrom: "2026-11-01", source: "owner", created: true });
    expect(r.body.inEffect).toEqual({ weekly: null, monthly: null });
    // October still has no monthly plan.
    expect((await get<Spine>("/spine", P)).monthAllowance).toMatchObject({ plan: null, status: "not_set" });
    expect((await get<Breakdown>(month("2026-10-01"), P)).plan.status).toBe("not_set");
    await db.delete(allowancePlansTable).where(eq(allowancePlansTable.id, r.body.id));
  });
});

describe("household P — POST weekly 380 from this Sunday (the owner's one tap)", () => {
  let planId = "";

  it("writes one household-pool row from Sun 10/11 and says what is in effect now", async () => {
    const r = await call("POST", "/allowance-plans", P, { period: "weekly", amount: "380", effectiveFrom: THIS_SUNDAY });
    expect(r.status).toBe(200);
    expect(() => CreateAllowancePlanResponse.parse(r.body)).not.toThrow();
    const saved = r.body as Saved;
    expect(saved).toMatchObject({ period: "weekly", amount: "380.00", effectiveFrom: THIS_SUNDAY, source: "owner", memberUserId: null, created: true });
    expect(saved.inEffect.weekly?.id).toBe(saved.id);
    planId = saved.id;
    const rows = await plansOf(P);
    expect(rows.map((p) => [p.period, p.amount, p.effectiveFrom, p.source, p.createdByKind, p.memberUserId])).toEqual([
      ["weekly", "380.00", THIS_SUNDAY, "owner", "user", null],
    ]);
    expect((await get<Plans>("/allowance-plans", P)).inEffect.weekly?.id).toBe(planId);
  });

  it("⭐ position.remainingWeek = 380 − 65 spent; the breakdown says set; the spine agrees to the cent", async () => {
    const [pos, b, spine] = await Promise.all([
      get<Position>("/money/position", P),
      get<Breakdown>(week(THIS_SUNDAY), P),
      get<Spine>("/spine", P),
    ]);
    expect([pos.weekCap, pos.spentWeekDiscretionary, pos.remainingWeek, pos.withinPlan]).toEqual(["380.00", "65.00", "315.00", "yes"]);
    expect(b.plan).toEqual({ status: "set", amount: "380.00", source: "plan", planId, effectiveFrom: THIS_SUNDAY });
    expect([b.actual, b.remaining, b.over]).toEqual(["65.00", "315.00", "0.00"]);
    expect(spine.position.remainingWeek).toBe(pos.remainingWeek);
    expect(spine.position.withinPlan).toBe(pos.withinPlan);
  });

  it("⭐ the forecast hook is now card charges + what is left (basis plan): 40 + 315 = 355; later weeks 380; LAST week keeps the stored 380", async () => {
    const sig = await get<Signal>(SIGNAL, P);
    expect(() => GetForecastCashSignalResponse.parse(sig)).not.toThrow();
    expect(reserveOn(sig, "2026-10-17")).toMatchObject({ amount: "355.00", basis: "plan", label: "Weekly Spend" });
    expect(hookEventOn(sig, "2026-10-17")?.amount).toBe("-355.00");
    expect(reserveOn(sig, "2026-10-24")).toMatchObject({ amount: "380.00", basis: "plan" });
    // Past weeks are untouched: last week had no plan, so it still reserves the stored amount.
    expect(reserveOn(sig, "2026-10-10")).toMatchObject({ amount: "380.00", basis: "stored_amount" });
    expect(sig.hookAmountIgnored).toEqual([{ itemId: pWeeklySpend, cadence: "weekly", storedAmount: "380.00" }]);
  });

  it("a plan below what is spent reads over (negative remaining); a second POST for the same Sunday updates that row (created: false)", async () => {
    const low = await call("POST", "/allowance-plans", P, { period: "weekly", amount: "50", effectiveFrom: THIS_SUNDAY });
    expect(low.status).toBe(200);
    expect(low.body).toMatchObject({ id: planId, amount: "50.00", created: false });
    const [pos, b] = await Promise.all([get<Position>("/money/position", P), get<Breakdown>(week(THIS_SUNDAY), P)]);
    expect([pos.weekCap, pos.remainingWeek, pos.withinPlan]).toEqual(["50.00", "-15.00", "over"]);
    expect([b.remaining, b.over]).toEqual(["-15.00", "15.00"]);
    const back = await call("POST", "/allowance-plans", P, { period: "weekly", amount: "380.00", effectiveFrom: THIS_SUNDAY });
    expect(back.body).toMatchObject({ id: planId, amount: "380.00", created: false });
    expect((await plansOf(P)).length).toBe(1);
  });
});

describe("household Q — editing a plan never rewrites a past week", () => {
  let oldWeekly = "";
  let newWeekly = "";
  let oldMonthly = "";

  beforeAll(async () => {
    const rows = await plansOf(Q);
    oldWeekly = rows.find((p) => p.period === "weekly")!.id;
    oldMonthly = rows.find((p) => p.period === "monthly")!.id;
  });

  it("before: last week and this week are both judged against the $300 row (last week's stored metrics say 300)", async () => {
    const [last, now] = await Promise.all([get<Breakdown>(week(LAST_SUNDAY), Q), get<Breakdown>(week(THIS_SUNDAY), Q)]);
    expect(last.plan).toMatchObject({ status: "set", amount: "300.00", planId: oldWeekly, effectiveFrom: "2026-09-27" });
    expect(now.plan).toMatchObject({ amount: "300.00", planId: oldWeekly });
    expect([last.actual, last.remaining]).toEqual(["90.00", "210.00"]);
  });

  it("⭐ PUT $340 on the $300 row: a NEW row from this Sunday; the $300 row and last week's cap are untouched (= its stored metrics)", async () => {
    const r = await call("PUT", `/allowance-plans/${oldWeekly}`, Q, { amount: "340" });
    expect(r.status).toBe(200);
    expect(() => UpdateAllowancePlanResponse.parse(r.body)).not.toThrow();
    const saved = r.body as Saved;
    expect(saved).toMatchObject({ period: "weekly", amount: "340.00", effectiveFrom: THIS_SUNDAY, source: "owner", created: true });
    expect(saved.id).not.toBe(oldWeekly);
    expect(saved.inEffect.weekly?.id).toBe(saved.id);
    newWeekly = saved.id;

    const [old] = await db.select().from(allowancePlansTable).where(eq(allowancePlansTable.id, oldWeekly));
    expect([old!.amount, old!.effectiveFrom]).toEqual(["300.00", "2026-09-27"]);

    const [metrics] = await db
      .select()
      .from(householdMetricsDailyTable)
      .where(eq(householdMetricsDailyTable.householdId, HH[Q]!.householdId));
    const [last, before, now, pos] = await Promise.all([
      get<Breakdown>(week(LAST_SUNDAY), Q),
      get<Breakdown>(week("2026-09-27"), Q),
      get<Breakdown>(week(THIS_SUNDAY), Q),
      get<Position>("/money/position", Q),
    ]);
    expect(last.plan).toMatchObject({ amount: "300.00", planId: oldWeekly });
    expect(Number(last.plan.amount)).toBe((metrics!.metrics as { weeklyCap: number }).weeklyCap);
    expect([last.actual, last.remaining]).toEqual(["90.00", "210.00"]);
    expect(before.plan).toMatchObject({ amount: "300.00", planId: oldWeekly });
    expect(now.plan).toMatchObject({ amount: "340.00", planId: newWeekly, effectiveFrom: THIS_SUNDAY });
    expect([pos.weekCap, pos.spentWeekDiscretionary, pos.remainingWeek]).toEqual(["340.00", "30.00", "310.00"]);
  });

  it("editing the old row again updates this week's row (no third row); editing this week's row is in place", async () => {
    const again = await call("PUT", `/allowance-plans/${oldWeekly}`, Q, { amount: "350" });
    expect(again.body).toMatchObject({ id: newWeekly, amount: "350.00", created: false });
    const inPlace = await call("PUT", `/allowance-plans/${newWeekly}`, Q, { amount: "345.5" });
    expect(inPlace.body).toMatchObject({ id: newWeekly, amount: "345.50", effectiveFrom: THIS_SUNDAY, created: false });
    const weekly = (await plansOf(Q)).filter((p) => p.period === "weekly").map((p) => [p.effectiveFrom, p.amount]).sort();
    expect(weekly).toEqual([
      ["2026-09-27", "300.00"],
      [THIS_SUNDAY, "345.50"],
    ]);
  });

  it("a start moved into the past, or off a Sunday, is refused (400) and nothing changes", async () => {
    for (const [id, body, error] of [
      [newWeekly, { amount: "345.50", effectiveFrom: LAST_SUNDAY }, "effectiveFrom is in a past week or month"],
      [oldWeekly, { amount: "345.50", effectiveFrom: "2026-09-27" }, "effectiveFrom is in a past week or month"],
      [oldWeekly, { amount: "345.50", effectiveFrom: "2026-10-13" }, "effectiveFrom is not a Sunday"],
    ] as const) {
      const r = await call("PUT", `/allowance-plans/${id}`, Q, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe(error);
    }
    const weekly = (await plansOf(Q)).filter((p) => p.period === "weekly").map((p) => [p.effectiveFrom, p.amount]).sort();
    expect(weekly).toEqual([
      ["2026-09-27", "300.00"],
      [THIS_SUNDAY, "345.50"],
    ]);
  });

  it("monthly: editing the May row starts a new row on October 1st; September keeps $600", async () => {
    const r = await call("PUT", `/allowance-plans/${oldMonthly}`, Q, { amount: "650" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ period: "monthly", amount: "650.00", effectiveFrom: "2026-10-01", created: true });
    expect(r.body.inEffect.monthly.id).toBe(r.body.id);
    const [sep, oct, spine] = await Promise.all([
      get<Breakdown>(month("2026-09-01"), Q),
      get<Breakdown>(month("2026-10-01"), Q),
      get<Spine>("/spine", Q),
    ]);
    expect(sep.plan).toMatchObject({ amount: "600.00", planId: oldMonthly });
    expect(oct.plan).toMatchObject({ amount: "650.00", planId: r.body.id });
    expect(spine.monthAllowance.plan).toBe("650.00");
    const [may] = await db.select().from(allowancePlansTable).where(eq(allowancePlansTable.id, oldMonthly));
    expect([may!.amount, may!.effectiveFrom]).toEqual(["600.00", "2026-05-01"]);
  });
});

describe("the household clock, not the server's", () => {
  it("Sat 23:30 Central (Sun 04:30 UTC) is still this week: this Sunday may be planned; at Sun 00:30 Central it is a past week", async () => {
    try {
      vi.setSystemTime(new Date("2026-10-17T23:30:00-05:00"));
      const late = await call("POST", "/allowance-plans", P, { period: "weekly", amount: "380", effectiveFrom: THIS_SUNDAY });
      expect(late.status).toBe(200);
      expect(late.body).toMatchObject({ effectiveFrom: THIS_SUNDAY, created: false });
      vi.setSystemTime(new Date("2026-10-18T00:30:00-05:00"));
      const next = await call("POST", "/allowance-plans", P, { period: "weekly", amount: "380", effectiveFrom: THIS_SUNDAY });
      expect([next.status, next.body.error]).toEqual([400, "effectiveFrom is in a past week or month"]);
    } finally {
      vi.setSystemTime(NOW);
    }
  });
});
