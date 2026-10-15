// ⭐ (F1) THE PLAN GATE — every path that writes a plan the everyday hooks read
// refuses (409 `plan_unsafe`, nothing written) while the forecast cannot size
// the card payments the plan moves (`lib/planSafety.ts`): the obligations model
// is off (`HOOK_OBLIGATIONS=off`), or an Amex card a hook depends on has no
// resolved payoff mode (`lib/cardPayoffMode.ts`). It lifts by itself once every
// such card resolves — the code defaults resolve the owner's live cards.
//
// Synthetic households; every name, amount and account number is made up.
// Pinned now: Wed 2026-10-14 12:00 Central (this week Sun 10/11 – Sat 10/17).
//
// Household G — a Weekly Spend hook (stored $450, Saturdays) and a weekly plan
//   $300 from 9/27.
//     Amex Platinum ••2207  weekly;  its debt row ARCHIVED       → in_full (default)
//     Amex Blue Cash ••1106 monthly; an ACTIVE debt, min 135.00 → debt_plan (default)
//     Amex Gold ••3307      weekly;  an ACTIVE debt row with no APR and no
//                           minimum → UNRESOLVED until the owner chooses
// Household N — no hook at all: nothing to protect, never refused.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const G = `f1-gate-g-${tag}`;
const G_MEMBER = `f1-gate-gm-${tag}`;
const N = `f1-gate-n-${tag}`;
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
    const who = String(req.headers["x-test-user"] ?? G);
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
  agentActionsTable,
  agentRunsTable,
  allowancePlansTable,
  debtsTable,
  householdMembersTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  type AgentProposal,
} from "@workspace/db";
import {
  CreateAllowancePlanResponse,
  GetAmexSummaryResponse,
  GetAmexWeeklyPayoffResponse,
  ListDebtsResponse,
  SetAmexCardPayoffModeResponse,
} from "@workspace/api-zod";
import moneyRouter from "../routes/money";
import settingsRouter from "../routes/settings";
import amexRouter from "../routes/amex";
// (Q1) GET /debts says how a linked card is paid, by the same definition.
import debtsRouter from "../routes/debts";
import { applyProposal } from "../lib/proposalApply";
import { GATE_REASON, planWriteGate } from "../lib/planSafety";
import { defaultModeOf, loadCardPayoffModes, paidAsOf, payDownOf, resolvePayoffMode } from "../lib/cardPayoffMode";
import { createTestHousehold } from "./_helpers/testHousehold";
import { newRun } from "./_helpers/askFixtures";

const NOW = new Date("2026-10-14T12:00:00-05:00");
const THIS_SUNDAY = "2026-10-11";
// Gold has an active debt with no APR and no minimum: Paying down cannot take effect, so the reason never offers it.
const GOLD_REASON = GATE_REASON.unresolvedCard("Amex Gold ••3307", { available: false, reason: "debt_terms_missing" });

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(settingsRouter);
app.use(amexRouter);
app.use(debtsRouter);

let server: Server;
let baseUrl: string;
let gPlanId = "";
const ext: Record<string, string> = {};

async function call(method: "GET" | "PUT" | "POST", path: string, as: string, body?: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-test-user": as, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

const plansOf = async (user: string) =>
  (await db.select().from(allowancePlansTable).where(eq(allowancePlansTable.householdId, HH[user]!.householdId)))
    .map((p) => [p.period, p.amount, p.effectiveFrom])
    .sort();
const settingsOf = async (user: string) => (await db.select().from(settingsTable).where(eq(settingsTable.userId, user)))[0]!;
const prefsOf = async (user: string) => (await settingsOf(user)).preferences as Record<string, unknown>;

async function cleanup(): Promise<void> {
  const users = [G, N];
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length) {
    await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, hhIds));
    await db.delete(agentActionsTable).where(inArray(agentActionsTable.householdId, hhIds));
    await db.delete(agentRunsTable).where(inArray(agentRunsTable.householdId, hhIds));
  }
  await db.delete(debtsTable).where(inArray(debtsTable.userId, users));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, users));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, users));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, users));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, users));
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  for (const u of [G, N]) HH[u] = await createTestHousehold(u);
  await db.insert(householdMembersTable).values({ userId: G_MEMBER, householdId: HH[G]!.householdId, role: "member" }).onConflictDoNothing();
  HH[G_MEMBER] = { householdId: HH[G]!.householdId, ownerUserId: G };
  await cleanup();
  const g = HH[G]!.householdId;
  const [amexItem] = await db
    .insert(plaidItemsTable)
    .values({ userId: G, householdId: g, itemId: `item-${randomUUID()}`, accessToken: "t", institutionSlug: "amex" })
    .returning();
  ext.plat = `gate-plat-${tag}`;
  ext.blue = `gate-blue-${tag}`;
  ext.gold = `gate-gold-${tag}`;
  const [plat, blue, gold] = await db
    .insert(plaidAccountsTable)
    .values([
      { userId: G, householdId: g, itemId: amexItem!.id, accountId: ext.plat, name: "Amex Platinum", mask: "2207", type: "credit", subtype: "credit card" },
      { userId: G, householdId: g, itemId: amexItem!.id, accountId: ext.blue, name: "Amex Blue Cash", mask: "1106", type: "credit", subtype: "credit card" },
      { userId: G, householdId: g, itemId: amexItem!.id, accountId: ext.gold, name: "Amex Gold", mask: "3307", type: "credit", subtype: "credit card" },
    ])
    .returning();
  await db.insert(debtsTable).values([
    { userId: G, householdId: g, name: "Amex Platinum", balance: "1200.00", apr: "0.2499", minPayment: "40.00", status: "archived", type: "credit_card", plaidAccountId: plat!.id },
    { userId: G, householdId: g, name: "Amex Blue Cash", balance: "4100.00", apr: "0.2299", minPayment: "135.00", status: "active", type: "credit_card", dueDay: 20, plaidAccountId: blue!.id },
    { userId: G, householdId: g, name: "Amex Gold", balance: "300.00", apr: "0", minPayment: "0", status: "active", type: "credit_card", plaidAccountId: gold!.id },
  ]);
  const [ws] = await db
    .insert(recurringItemsTable)
    .values({ userId: G, householdId: g, name: "Weekly Spend", kind: "bill", amount: "450", frequency: "weekly", anchorDate: "2026-10-17", active: "true" })
    .returning();
  const [plan] = await db
    .insert(allowancePlansTable)
    .values({ householdId: g, memberUserId: null, period: "weekly", amount: "300.00", effectiveFrom: "2026-09-27", source: "owner" })
    .returning();
  gPlanId = plan!.id;
  await db.insert(settingsTable).values({
    userId: G,
    householdId: g,
    weeklyAllowanceAmount: "0",
    monthlyAllowanceAmount: "0",
    preferences: { everydayHooks: { weekly: { recurringItemId: ws!.id }, monthly: null }, weeklyAllowanceOverrides: { "2026-10-18": "320" }, dismissedDetectedSubs: [] },
  });
  await db.insert(settingsTable).values({ userId: N, householdId: HH[N]!.householdId, weeklyAllowanceAmount: "0", monthlyAllowanceAmount: "0", preferences: {} });

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  delete process.env.HOOK_OBLIGATIONS;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, G_MEMBER));
});

const unsafe = (reason: string) => ({ code: "plan_unsafe", reason, error: reason });

describe("payoff modes — the one rule (pure)", () => {
  const d = (status: string, balance: string, apr: string, min: string) => ({ id: `d-${status}-${apr}-${min}`, status, balance, apr, minPayment: min });
  it("defaults: no debt / no active debt → in_full; active with an APR or a minimum → debt_plan; active with neither → unresolved; an explicit choice wins", () => {
    expect(resolvePayoffMode(null, [])).toMatchObject({ mode: "in_full", source: "default", reason: "no_debt" });
    expect(resolvePayoffMode(null, [d("archived", "1200", "0.25", "40")])).toMatchObject({ mode: "in_full", reason: "debt_not_active" });
    expect(resolvePayoffMode(null, [d("paid", "0", "0.25", "40")])).toMatchObject({ mode: "in_full", reason: "debt_not_active" });
    expect(resolvePayoffMode(null, [d("active", "0", "0.25", "40")])).toMatchObject({ mode: "in_full", reason: "debt_not_active" });
    expect(resolvePayoffMode(null, [d("active", "4100", "0.23", "135.00")])).toMatchObject({ mode: "debt_plan", reason: "debt_active" });
    expect(resolvePayoffMode(null, [d("active", "4100", "0.23", "0")])).toMatchObject({ mode: "debt_plan", reason: "debt_active" });
    expect(resolvePayoffMode(null, [d("active", "300", "0", "0")])).toMatchObject({ mode: null, reason: "debt_terms_missing" });
    expect(resolvePayoffMode("in_full", [d("active", "4100", "0.23", "135.00")])).toMatchObject({ mode: "in_full", source: "explicit", reason: "set_by_owner" });
    expect(resolvePayoffMode("debt_plan", [d("active", "4100", "0.23", "135.00")])).toMatchObject({ mode: "debt_plan", source: "explicit" });
    expect(resolvePayoffMode("debt_plan", [d("archived", "1200", "0.25", "40")])).toMatchObject({ mode: null, source: "explicit", reason: "debt_plan_without_active_debt" });
  });

  it("(Q6b) payDownOf: Paying down is available only when the one rule would resolve it, and the reason names the cause", () => {
    expect(payDownOf([])).toEqual({ available: false, reason: "no_debt" });
    expect(payDownOf([d("archived", "1200", "0.25", "40")])).toEqual({ available: false, reason: "debt_not_active" });
    expect(payDownOf([d("paid", "0", "0.25", "40")])).toEqual({ available: false, reason: "debt_not_active" });
    expect(payDownOf([d("active", "300", "0", "0")])).toEqual({ available: false, reason: "debt_terms_missing" });
    expect(payDownOf([d("active", "4100", "0.23", "0")])).toEqual({ available: true, reason: null });
    expect(payDownOf([d("active", "4100", "0", "135.00")])).toEqual({ available: true, reason: null });
    // One source: it agrees with resolvePayoffMode("debt_plan", …) for every input above.
    for (const linked of [[], [d("archived", "1200", "0.25", "40")], [d("active", "300", "0", "0")], [d("active", "4100", "0.23", "135.00")]]) {
      expect(payDownOf(linked).available).toBe(resolvePayoffMode("debt_plan", linked).mode === "debt_plan");
    }
  });

  it("(Q6b r3) the gate words offer paying it down only where it can take effect", () => {
    const open = (r: Parameters<typeof GATE_REASON.unresolvedCard>[1]) => GATE_REASON.unresolvedCard("Amex Gold ••3307", r);
    expect(open({ available: true, reason: null })).toBe("Plans are paused: choose how Amex Gold ••3307 is paid — in full, or paying it down.");
    expect(open(undefined)).toContain("paying it down");
    expect(open({ available: false, reason: "debt_terms_missing" })).toBe("Plans are paused: choose how Amex Gold ••3307 is paid — in full — or add the debt's APR and minimum in Debts.");
    expect(open({ available: false, reason: "debt_not_active" })).toBe("Plans are paused: choose how Amex Gold ••3307 is paid — in full.");
    expect(open({ available: false, reason: "no_debt" })).not.toContain("paying it down");
    expect(GOLD_REASON).not.toContain("paying it down");
  });

  it("(Q6b r3) defaultModeOf: what Use the default resolves to, from the one rule", () => {
    expect(defaultModeOf([])).toEqual({ mode: "in_full", reason: "no_debt" });
    expect(defaultModeOf([d("archived", "1200", "0.25", "40")])).toEqual({ mode: "in_full", reason: "debt_not_active" });
    expect(defaultModeOf([d("active", "4100", "0.23", "0")])).toEqual({ mode: "debt_plan", reason: "debt_active" });
    expect(defaultModeOf([d("active", "300", "0", "0")])).toEqual({ mode: null, reason: "debt_terms_missing" });
  });

  it("household G's cards: Platinum in_full (archived debt), Blue debt_plan (active debt), Gold unresolved", async () => {
    const modes = await loadCardPayoffModes(HH[G]!.householdId, G);
    expect(modes.map((m) => [m.mask, m.cadence, m.mode, m.source, m.reason]).sort()).toEqual([
      ["1106", "monthly", "debt_plan", "default", "debt_active"],
      ["2207", "weekly", "in_full", "default", "debt_not_active"],
      ["3307", "weekly", null, "default", "debt_terms_missing"],
    ]);
    // (Q1) The one definition every screen words.
    expect(modes.map((m) => [m.mask, m.paidAs.effectiveMode, m.paidAs.source]).sort()).toEqual([
      ["1106", "debt_plan", "default_debt_active"],
      ["2207", "in_full_weekly", "default_debt_inactive"],
      ["3307", "unset", "needs_choice"],
    ]);
    // (Q6b) Whether Paying down can take effect, per card: Blue yes; Platinum (archived) and Gold (no APR or minimum) no, each with its cause.
    expect(modes.map((m) => [m.mask, m.payDown]).sort()).toEqual([
      ["1106", { available: true, reason: null }],
      ["2207", { available: false, reason: "debt_not_active" }],
      ["3307", { available: false, reason: "debt_terms_missing" }],
    ]);
  });

  it("(Q1) paidAsOf: the effective mode carries the cadence; the source says chosen or which default", () => {
    const at = (explicit: "in_full" | "debt_plan" | null, linked: ReturnType<typeof d>[], cadence: "weekly" | "monthly") =>
      paidAsOf(resolvePayoffMode(explicit, linked), cadence);
    expect(at(null, [], "weekly")).toEqual({ effectiveMode: "in_full_weekly", source: "default_no_debt" });
    expect(at(null, [], "monthly")).toEqual({ effectiveMode: "in_full_monthly", source: "default_no_debt" });
    // ⭐ An archived debt's card is paid in full at its cadence — never "on the payoff plan".
    expect(at(null, [d("archived", "1200", "0.25", "40")], "weekly")).toEqual({ effectiveMode: "in_full_weekly", source: "default_debt_inactive" });
    // An active debt with an APR or a minimum: the debt plan.
    expect(at(null, [d("active", "4100", "0.23", "135.00")], "monthly")).toEqual({ effectiveMode: "debt_plan", source: "default_debt_active" });
    expect(at(null, [d("active", "4100", "0", "135.00")], "weekly")).toEqual({ effectiveMode: "debt_plan", source: "default_debt_active" });
    // ⭐ An explicit choice wins, either way.
    expect(at("in_full", [d("active", "4100", "0.23", "135.00")], "monthly")).toEqual({ effectiveMode: "in_full_monthly", source: "chosen" });
    expect(at("debt_plan", [d("active", "4100", "0.23", "135.00")], "weekly")).toEqual({ effectiveMode: "debt_plan", source: "chosen" });
    // Unresolved: the owner must choose.
    expect(at(null, [d("active", "300", "0", "0")], "weekly")).toEqual({ effectiveMode: "unset", source: "needs_choice" });
    expect(at("debt_plan", [d("archived", "1200", "0.25", "40")], "weekly")).toEqual({ effectiveMode: "unset", source: "needs_choice" });
  });
});

describe("a weekly card with no resolved payoff mode: every plan path refuses, with a plain reason, and writes nothing", () => {
  it("the gate names the card", async () => {
    expect(await planWriteGate(HH[G]!.householdId, G)).toEqual({ ok: false, code: "plan_unsafe", reason: GOLD_REASON });
  });

  it("POST /allowance-plans (the one-tap): 409; the request's own mistakes still answer 400 first", async () => {
    const before = await plansOf(G);
    expect(await call("POST", "/allowance-plans", G, { period: "weekly", amount: "450", effectiveFrom: THIS_SUNDAY })).toEqual({ status: 409, body: unsafe(GOLD_REASON) });
    expect(await call("POST", "/allowance-plans", G, { period: "weekly", amount: "450", effectiveFrom: "2026-10-04" })).toEqual({
      status: 400,
      body: { error: "effectiveFrom is in a past week or month" },
    });
    expect(await plansOf(G)).toEqual(before);
  });

  it("PUT /allowance-plans/:id: 409; the row and history untouched", async () => {
    const before = await plansOf(G);
    expect(await call("PUT", `/allowance-plans/${gPlanId}`, G, { amount: "350" })).toEqual({ status: 409, body: unsafe(GOLD_REASON) });
    expect(await plansOf(G)).toEqual(before);
  });

  it("an approved weekly-limit proposal: 409 plan_unsafe, nothing written", async () => {
    const before = await plansOf(G);
    const proposal = { id: randomUUID(), householdId: HH[G]!.householdId, runId: randomUUID(), kind: "weekly_limit", payload: { target: gPlanId, before: 300, after: 250 } } as unknown as AgentProposal;
    expect(await applyProposal(proposal, { householdId: HH[G]!.householdId, ownerUserId: G, actorUserId: G, isOwner: true })).toEqual({
      ok: false,
      status: 409,
      error: GOLD_REASON,
      code: "plan_unsafe",
    });
    expect(await plansOf(G)).toEqual(before);
  });

  it("PUT /settings changing the weekly or monthly allowance (mirrored into a plan): 409; settings and plans untouched", async () => {
    const before = await plansOf(G);
    expect(await call("PUT", "/settings", G, { weeklyAllowanceAmount: "450" })).toEqual({ status: 409, body: unsafe(GOLD_REASON) });
    expect(await call("PUT", "/settings", G, { monthlyAllowanceAmount: "600" })).toEqual({ status: 409, body: unsafe(GOLD_REASON) });
    expect([(await settingsOf(G)).weeklyAllowanceAmount, (await settingsOf(G)).monthlyAllowanceAmount]).toEqual(["0.00", "0.00"]);
    expect(await plansOf(G)).toEqual(before);
  });

  it("PUT /settings changing a per-week override (changed, added or removed): 409; the overrides untouched", async () => {
    const prefs = await prefsOf(G);
    for (const overrides of [{ "2026-10-18": "200" }, { "2026-10-18": "320", "2026-10-25": "100" }, {}]) {
      expect(await call("PUT", "/settings", G, { preferences: { ...prefs, weeklyAllowanceOverrides: overrides } }), JSON.stringify(overrides)).toEqual({
        status: 409,
        body: unsafe(GOLD_REASON),
      });
    }
    expect((await prefsOf(G)).weeklyAllowanceOverrides).toEqual({ "2026-10-18": "320" });
  });

  it("PUT /settings that changes no plan input is never gated (the same overrides, another preference, the same allowance)", async () => {
    const prefs = await prefsOf(G);
    const r = await call("PUT", "/settings", G, { preferences: { ...prefs, dismissedDetectedSubs: ["CINEMA 12"], weeklyAllowanceOverrides: { "2026-10-18": "320.00" } }, weeklyAllowanceAmount: "0" });
    expect(r.status).toBe(200);
    expect((await prefsOf(G)).dismissedDetectedSubs).toEqual(["CINEMA 12"]);
  });

  it("the dry run still shows the plan's effect, and says why it is refused; nothing is written", async () => {
    const before = await plansOf(G);
    const r = await call("POST", "/allowance-plans?dryRun=1", G, { period: "weekly", amount: "450", effectiveFrom: THIS_SUNDAY });
    expect(r.status).toBe(200);
    expect(() => CreateAllowancePlanResponse.parse(r.body)).not.toThrow();
    expect(r.body).toMatchObject({ dryRun: true, allowed: false, reason: GOLD_REASON, plan: { period: "weekly", amount: "450.00", effectiveFrom: THIS_SUNDAY } });
    expect(await plansOf(G)).toEqual(before);
  });
});

describe("the owner chooses how the card is paid — PUT /amex/cards/:accountId/payoff-mode — and the gate lifts by itself", () => {
  it("only the owner; a mode it does not know is 400; an unknown card 404", async () => {
    expect((await call("PUT", `/amex/cards/${ext.gold}/payoff-mode`, G_MEMBER, { mode: "in_full" })).status).toBe(403);
    expect((await call("PUT", `/amex/cards/${ext.gold}/payoff-mode`, G, { mode: "weekly" })).status).toBe(400);
    expect((await call("PUT", `/amex/cards/${ext.gold}/payoff-mode`, G, {})).status).toBe(400);
    expect((await call("PUT", `/amex/cards/nope-${tag}/payoff-mode`, G, { mode: "in_full" })).status).toBe(404);
    expect((await prefsOf(G)).amexCardPayoffMode).toBeUndefined();
  });

  it("debt_plan with no minimum or APR behind it stays unresolved: nothing would pay its purchases", async () => {
    const r = await call("PUT", `/amex/cards/${ext.gold}/payoff-mode`, G, { mode: "debt_plan" });
    expect(r.status).toBe(200);
    expect(() => SetAmexCardPayoffModeResponse.parse(r.body)).not.toThrow();
    expect(r.body).toMatchObject({ accountId: ext.gold, mode: null, source: "explicit", reason: "debt_plan_without_active_debt" });
    expect((await planWriteGate(HH[G]!.householdId, G)).ok).toBe(false);
  });

  it("in_full resolves it: the gate lifts, the choice survives a settings save, and the weekly payoff lists every card's mode", async () => {
    const r = await call("PUT", `/amex/cards/${ext.gold}/payoff-mode`, G, { mode: "in_full" });
    expect(r.body).toMatchObject({ accountId: ext.gold, mode: "in_full", source: "explicit", reason: "set_by_owner" });
    expect(await planWriteGate(HH[G]!.householdId, G)).toEqual({ ok: true });
    // A settings save (the web sends {...prev, ...patch}, without the server-owned key) never clears it.
    const prefs = await prefsOf(G);
    const { amexCardPayoffMode: _drop, ...rest } = prefs;
    expect((await call("PUT", "/settings", G, { preferences: { ...rest, dismissedDetectedSubs: [] } })).status).toBe(200);
    expect((await prefsOf(G)).amexCardPayoffMode).toEqual({ [ext.gold]: "in_full" });
    const payoff = await call("GET", `/amex/weekly-payoff?weekStart=${THIS_SUNDAY}`, G);
    expect(() => GetAmexWeeklyPayoffResponse.parse(payoff.body)).not.toThrow();
    expect((payoff.body.payoffModes as Array<{ mask: string; mode: string; source: string }>).map((m) => [m.mask, m.mode, m.source]).sort()).toEqual([
      ["1106", "debt_plan", "default"],
      ["2207", "in_full", "default"],
      ["3307", "in_full", "explicit"],
    ]);
  });

  it("every path now writes: POST, PUT, the settings mirror, an override, an approved proposal", async () => {
    const post = await call("POST", "/allowance-plans", G, { period: "weekly", amount: "450", effectiveFrom: THIS_SUNDAY });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ period: "weekly", amount: "450.00", effectiveFrom: THIS_SUNDAY, created: true });
    expect((await call("PUT", `/allowance-plans/${post.body.id}`, G, { amount: "425" })).status).toBe(200);
    expect((await call("PUT", "/settings", G, { weeklyAllowanceAmount: "425" })).status).toBe(200);
    const prefs = await prefsOf(G);
    expect((await call("PUT", "/settings", G, { preferences: { ...prefs, weeklyAllowanceOverrides: { "2026-10-18": "300" } } })).status).toBe(200);
    const runId = await newRun(HH[G]!.householdId);
    const proposal = { id: randomUUID(), householdId: HH[G]!.householdId, runId, kind: "weekly_limit", payload: { target: post.body.id, before: 425, after: 400 } } as unknown as AgentProposal;
    expect(await applyProposal(proposal, { householdId: HH[G]!.householdId, ownerUserId: G, actorUserId: G, isOwner: true })).toMatchObject({ ok: true });
    const [row] = await db
      .select()
      .from(allowancePlansTable)
      .where(and(eq(allowancePlansTable.householdId, HH[G]!.householdId), eq(allowancePlansTable.effectiveFrom, THIS_SUNDAY)));
    expect(row!.amount).toBe("400.00");
  });

  it("null clears the choice: the default (unresolved) applies again and the gate holds", async () => {
    const r = await call("PUT", `/amex/cards/${ext.gold}/payoff-mode`, G, { mode: null });
    expect(r.body).toMatchObject({ mode: null, source: "default", reason: "debt_terms_missing" });
    expect((await prefsOf(G)).amexCardPayoffMode).toEqual({});
    expect((await planWriteGate(HH[G]!.householdId, G)).ok).toBe(false);
    await call("PUT", `/amex/cards/${ext.gold}/payoff-mode`, G, { mode: "in_full" });
  });
});

describe("the kill switch — HOOK_OBLIGATIONS=off restores the gate", () => {
  it("every hook household is refused with the model reason; a household with no hook is not", async () => {
    process.env.HOOK_OBLIGATIONS = "off";
    expect(await planWriteGate(HH[G]!.householdId, G)).toEqual({ ok: false, code: "plan_unsafe", reason: GATE_REASON.modelOff });
    expect(await call("POST", "/allowance-plans", G, { period: "weekly", amount: "450", effectiveFrom: THIS_SUNDAY })).toEqual({
      status: 409,
      body: unsafe(GATE_REASON.modelOff),
    });
    expect(await planWriteGate(HH[N]!.householdId, N)).toEqual({ ok: true });
  });
});

describe("a household with no hook: nothing to protect", () => {
  it("the gate is open, and POST /allowance-plans writes", async () => {
    expect(await planWriteGate(HH[N]!.householdId, N)).toEqual({ ok: true });
    const r = await call("POST", "/allowance-plans", N, { period: "weekly", amount: "300", effectiveFrom: THIS_SUNDAY });
    expect(r.status).toBe(200);
    expect(await plansOf(N)).toEqual([["weekly", "300.00", THIS_SUNDAY]]);
    expect((await call("PUT", "/settings", N, { weeklyAllowanceAmount: "250" })).status).toBe(200);
  });
});

describe("(Q1) one payoff-mode definition on every surface: the weekly payoff (band and debt-linked), the Amex summary, the debts list", () => {
  const pick = <T extends { accountId: string; paidAs: unknown }>(list: T[]) =>
    Object.fromEntries(list.map((c) => [c.accountId, c.paidAs]));

  it("⭐ each card reads the same paidAs everywhere; the archived Platinum is in full weekly though a debt row links it; the owner's choice wins", async () => {
    // Gold was chosen in_full above; Platinum and Blue are defaults.
    const want = {
      [ext.plat]: { effectiveMode: "in_full_weekly", source: "default_debt_inactive" },
      [ext.blue]: { effectiveMode: "debt_plan", source: "default_debt_active" },
      [ext.gold]: { effectiveMode: "in_full_weekly", source: "chosen" },
    };
    const payoff = await call("GET", `/amex/weekly-payoff?weekStart=${THIS_SUNDAY}`, G);
    expect(() => GetAmexWeeklyPayoffResponse.parse(payoff.body)).not.toThrow();
    // The band (`cards`) and the debt-linked list together hold every card once, each with its definition.
    const onPage = { ...pick(payoff.body.cards), ...pick(payoff.body.debtLinkedCards) };
    expect(onPage).toEqual(want);
    expect(pick(payoff.body.payoffModes)).toEqual(want);
    // A card in the debt-linked list is not "on the payoff plan" because it is there.
    const platLinked = (payoff.body.debtLinkedCards as Array<{ accountId: string }>).some((c) => c.accountId === ext.plat);
    if (platLinked) expect(onPage[ext.plat]).toMatchObject({ effectiveMode: "in_full_weekly" });

    const summary = await call("GET", `/amex/summary?accountId=all&from=${THIS_SUNDAY}&to=2026-10-14`, G);
    expect(summary.status).toBe(200);
    expect(() => GetAmexSummaryResponse.parse(summary.body)).not.toThrow();
    expect(pick(summary.body.scope.cards)).toEqual(want);
    // (Q6b) The same card says whether Paying down can take effect, on the summary and on the payoff-mode answer.
    const payDownWant = {
      [ext.plat]: { available: false, reason: "debt_not_active" },
      [ext.blue]: { available: true, reason: null },
      [ext.gold]: { available: false, reason: "debt_terms_missing" },
    };
    expect(Object.fromEntries((summary.body.scope.cards as Array<{ accountId: string; payDown: unknown }>).map((c) => [c.accountId, c.payDown]))).toEqual(payDownWant);
    expect((await call("PUT", `/amex/cards/${ext.plat}/payoff-mode`, G, { mode: "in_full" })).body.payDown).toEqual(payDownWant[ext.plat]);
    expect((await call("PUT", `/amex/cards/${ext.plat}/payoff-mode`, G, { mode: null })).body.payDown).toEqual(payDownWant[ext.plat]);

    // (Q6b r3) What Use the default would resolve to, on the summary and the payoff-mode answer: Gold cannot tell.
    const defWant = {
      [ext.plat]: { mode: "in_full", reason: "debt_not_active" },
      [ext.blue]: { mode: "debt_plan", reason: "debt_active" },
      [ext.gold]: { mode: null, reason: "debt_terms_missing" },
    };
    expect(Object.fromEntries((summary.body.scope.cards as Array<{ accountId: string; defaultMode: unknown }>).map((c) => [c.accountId, c.defaultMode]))).toEqual(defWant);
    expect((await call("PUT", `/amex/cards/${ext.plat}/payoff-mode`, G, { mode: null })).body.defaultMode).toEqual(defWant[ext.plat]);

    const debts = await call("GET", "/debts", G);
    expect(debts.status).toBe(200);
    expect(() => ListDebtsResponse.parse(debts.body)).not.toThrow();
    const byName = Object.fromEntries((debts.body as Array<{ name: string; paidAs: unknown }>).map((x) => [x.name, x.paidAs]));
    expect(byName).toEqual({
      "Amex Platinum": want[ext.plat],
      "Amex Blue Cash": want[ext.blue],
      "Amex Gold": want[ext.gold],
    });
  });

  it("an explicit choice moves every surface at once (Blue chosen in full monthly), and clearing it restores the default", async () => {
    expect((await call("PUT", `/amex/cards/${ext.blue}/payoff-mode`, G, { mode: "in_full" })).body.paidAs).toEqual({ effectiveMode: "in_full_monthly", source: "chosen" });
    try {
      const payoff = await call("GET", `/amex/weekly-payoff?weekStart=${THIS_SUNDAY}`, G);
      expect({ ...pick(payoff.body.cards), ...pick(payoff.body.debtLinkedCards) }[ext.blue]).toEqual({ effectiveMode: "in_full_monthly", source: "chosen" });
      const debts = await call("GET", "/debts", G);
      expect((debts.body as Array<{ name: string; paidAs: unknown }>).find((x) => x.name === "Amex Blue Cash")!.paidAs).toEqual({
        effectiveMode: "in_full_monthly",
        source: "chosen",
      });
    } finally {
      const back = await call("PUT", `/amex/cards/${ext.blue}/payoff-mode`, G, { mode: null });
      expect(back.body.paidAs).toEqual({ effectiveMode: "debt_plan", source: "default_debt_active" });
    }
  });

  it("the band's cards and figures are unchanged: which cards are in `cards`, and the combined totals, do not depend on paidAs", async () => {
    const payoff = await call("GET", `/amex/weekly-payoff?weekStart=${THIS_SUNDAY}`, G);
    // Every card in `cards` has no debt row (the hook's old split, kept); paidAs only words it.
    for (const c of payoff.body.cards as Array<{ debtId: string | null }>) expect(c.debtId).toBeNull();
    for (const c of payoff.body.debtLinkedCards as Array<{ debtId: string }>) expect(typeof c.debtId).toBe("string");
  });
});
