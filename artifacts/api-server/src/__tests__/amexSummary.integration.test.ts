// ⭐ (S5) GET /amex/summary — "Same with Amex": review a card and see what was
// not in the plan. And the additive `debtLinkedCards` on GET /amex/weekly-payoff.
//
// The household and every figure, worked by hand, are in
// ./_fixtures/amexCheckingScenario.ts (section "S5"). All synthetic. The B4
// scenario (amexCheckingScenario.integration.test.ts) walks the same summary
// through a real Plaid sync, step by step.
//
// What is proven here:
//   - "all" lists EVERY Amex card, the debt-linked one included; the weekly
//     payoff's `cards` / `combinedWeekCharges` are as before and the debt card
//     is in `debtLinkedCards`;
//   - for a weekly card, purchases − refunds over the payoff week = its
//     `weekCharges`; every row is in exactly one bucket (= the raw rows);
//   - a payment is a payment only, a refund a refund only; a pending row its
//     posted row replaced counts once; a split parent counts once, on its card;
//   - `householdContribution` = GET /money/period-breakdown for that account
//     (week and month), to the cent;
//   - per card, purchases − reimbursable + not mine − refunds = what spending
//     facts count for the card (Σ = household spend for the week);
//   - owed is the anchor's own answer; unknown is null, never "0.00".

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, gte, inArray, lte } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const OWNER = `s5-amex-${tag}`;
const EMPTY = `s5-amex-empty-${tag}`;
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
    const who = String(req.headers["x-test-user"] ?? OWNER);
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
  budgetCategoriesTable,
  debtStatementsTable,
  debtsTable,
  forecastSettingsTable,
  merchantAliasesTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionSplitsTable,
  transactionsTable,
} from "@workspace/db";
import { creditAmount, spendAmount } from "@workspace/avalanche-core";
import { GetAmexSummaryResponse } from "@workspace/api-zod";
import amexRouter from "../routes/amex";
import moneyRouter from "../routes/money";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { loadSupersededPendingIds } from "../lib/supersededPending";
import { merchantSignature } from "../lib/merchantNameExtract";
import {
  S5_ACCOUNTS,
  S5_CATEGORIES,
  S5_DEBTS,
  S5_EXPECTED,
  S5_NOW,
  S5_ROWS,
  S5_WEEK,
  type S5AccountKey,
} from "./_fixtures/amexCheckingScenario";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(amexRouter);
app.use(moneyRouter);

let server: Server;
let baseUrl = "";

async function call(path: string, as: string = OWNER): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": as } });
  return { status: r.status, body: await r.json() };
}
async function get<T = any>(path: string, as: string = OWNER): Promise<T> {
  const r = await call(path, as);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

const ext: Record<string, string> = {};
const rowId: Record<string, string> = {};
const ids: Record<string, string> = {};
const cat: Record<string, string> = {};
const debtId: Record<string, string> = {};
const LIABILITY_AT = new Date("2026-10-08T07:00:00.000Z");

const ac = (t: { amount: string; count: number }) => `${t.amount}/${t.count}`;
const cents = (v: string | number) => Math.round(Number(v) * 100);
const summary = (accountId: string, from: string = S5_WEEK.from, to: string = S5_WEEK.to, extra = "") =>
  get(`/amex/summary?accountId=${accountId}&from=${from}&to=${to}${extra}`);
const attention = (s: any, g: "unplanned" | "unfiled" | "uncategorized") =>
  (s.needsAttention[g].rows as any[]).map((r) => [r.displayName, r.amount, r.category?.name ?? "—", ...r.flags].join(" "));

async function cleanup(): Promise<void> {
  const users = [OWNER, EMPTY];
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length) {
    await db.delete(transactionSplitsTable).where(inArray(transactionSplitsTable.householdId, hhIds));
    await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, hhIds));
    await db.delete(merchantAliasesTable).where(inArray(merchantAliasesTable.householdId, hhIds));
    await db.delete(debtStatementsTable).where(inArray(debtStatementsTable.householdId, hhIds));
  }
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, users));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, users));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, users));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, users));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, users));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, users));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, users));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, users));
}

beforeAll(async () => {
  vi.setSystemTime(S5_NOW);
  for (const u of [OWNER, EMPTY]) HH[u] = await createTestHousehold(u);
  await cleanup();
  const hh = HH[OWNER]!.householdId;
  const owned = { userId: OWNER, householdId: hh };

  // ── Accounts: one item per institution.
  const items: Record<string, string> = {};
  for (const [slug, name] of [["chase", "Chase"], ["amex", "American Express"]] as const) {
    const [it] = await db
      .insert(plaidItemsTable)
      .values({ ...owned, itemId: `s5-item-${slug}-${tag}`, accessToken: "t", institutionSlug: slug, institutionName: name })
      .returning();
    items[slug] = it!.id;
  }
  for (const [key, a] of Object.entries(S5_ACCOUNTS) as Array<[S5AccountKey, (typeof S5_ACCOUNTS)[S5AccountKey]]>) {
    ext[key] = `${a.accountId}-${tag}`;
    const [row] = await db
      .insert(plaidAccountsTable)
      .values({
        ...owned,
        itemId: items[a.slug]!,
        accountId: ext[key]!,
        name: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        liabilityBalance: a.liability,
        liabilityLastFetchedAt: a.liability ? LIABILITY_AT : null,
      })
      .returning();
    rowId[key] = row!.id;
  }
  await db.insert(forecastSettingsTable).values({
    ...owned,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: rowId.chase!,
  });

  // ── Debts: the Gold card is tracked as one; a car loan beside it.
  const [gold] = await db
    .insert(debtsTable)
    .values({ ...owned, name: S5_DEBTS.gold.name, balance: S5_DEBTS.gold.balance, apr: S5_DEBTS.gold.apr, minPayment: S5_DEBTS.gold.minPayment, type: "credit_card", plaidAccountId: rowId.gold!, balanceSource: "plaid" })
    .returning();
  debtId.gold = gold!.id;
  const [car] = await db
    .insert(debtsTable)
    .values({ ...owned, name: S5_DEBTS.car.name, balance: S5_DEBTS.car.balance, apr: S5_DEBTS.car.apr, minPayment: S5_DEBTS.car.minPayment, type: "auto_loan" })
    .returning();
  debtId.car = car!.id;
  await db.insert(debtStatementsTable).values({
    householdId: hh,
    debtId: debtId.gold!,
    statementDate: S5_DEBTS.gold.statement.date,
    statementBalance: S5_DEBTS.gold.statement.balance,
    minPayment: S5_DEBTS.gold.minPayment,
    source: "plaid",
  });

  // ── Categories, plans, hooks.
  for (const n of S5_CATEGORIES) {
    const [c] = await db.insert(budgetCategoriesTable).values({ ...owned, name: n, kind: "expense", groupName: "S5" }).returning();
    cat[n] = c!.id;
  }
  await db.insert(allowancePlansTable).values({ householdId: hh, memberUserId: null, period: "weekly", amount: "1000.00", effectiveFrom: "2026-05-01", source: "owner" });
  const hookIds: Record<string, string> = {};
  for (const [key, name, amount, frequency, anchorDate] of [
    ["weekly", "Weekly Spend", "450", "weekly", "2026-10-10"],
    ["monthly", "Monthly Spend", "200", "monthly", "2026-10-28"],
  ] as const) {
    const [p] = await db
      .insert(recurringItemsTable)
      .values({ ...owned, name, kind: "bill", amount, frequency, dayOfMonth: Number(anchorDate.slice(8, 10)), anchorDate, active: "true" })
      .returning();
    hookIds[key] = p!.id;
  }

  // ── The rows. A pending row is created before the posted row that replaces it.
  for (const r of S5_ROWS) {
    const [t] = await db
      .insert(transactionsTable)
      .values({
        ...owned,
        occurredOn: r.on,
        createdAt: createdAtStartOfHouseholdDay(r.on),
        description: r.desc,
        amount: r.amount,
        plaidAccountId: ext[r.account]!,
        plaidTransactionId: `s5-${r.key}-${tag}`,
        source: r.account === "chase" ? "plaid:chase" : "plaid:amex",
        categoryId: r.category ? cat[r.category]! : null,
        categoryLockedByUser: r.byHand ?? false,
        isTransferUserOverridden: r.byHand ?? false,
        weeklyAllowance: r.weekly ?? false,
        monthlyAllowance: r.monthly ?? false,
        unplannedAllowance: r.unplanned ?? false,
        reimbursable: r.reimbursable ?? false,
        isTransfer: r.transfer ?? false,
        pending: r.pending ?? false,
        pfcDetailed: r.pfc ?? null,
      })
      .returning({ id: transactionsTable.id });
    ids[r.key] = t!.id;
    if (r.splits) {
      await db.insert(transactionSplitsTable).values(
        r.splits.map(([c, amount]) => ({ householdId: hh, transactionId: t!.id, categoryId: cat[c]!, amount, userId: OWNER })),
      );
    }
  }
  await db.insert(merchantAliasesTable).values({ ...owned, signature: merchantSignature("COSTCO WHSE"), alias: "Costco" });

  // ── The owner's preferences: the hooks, a card name, the "not mine" row.
  await db.insert(settingsTable).values({
    ...owned,
    preferences: {
      everydayHooks: { weekly: { recurringItemId: hookIds.weekly }, monthly: { recurringItemId: hookIds.monthly } },
      amexCardNames: { [ext.plat!]: "Everyday Plat" },
      amexExcludedTxnIds: [ids.notMine],
    },
  });

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  if (server) await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

describe("S5 · GET /amex/summary — one card's week", () => {
  it("the Platinum card: every bucket, worked by hand, and the schema", async () => {
    const s = await summary(ext.plat!);
    expect(GetAmexSummaryResponse.safeParse(s).success, JSON.stringify(GetAmexSummaryResponse.safeParse(s).error?.issues?.slice(0, 3))).toBe(true);
    const e = S5_EXPECTED.plat;
    expect(s.scope).toMatchObject({ kind: "card", accountId: ext.plat, name: "Everyday Plat", mask: "1001", institution: "American Express" });
    expect(s.scope.cards).toEqual([
      { accountId: ext.plat, name: "Everyday Plat", mask: "1001", institution: "American Express", brand: "silver", cadence: "weekly", debtLinked: false, debtId: null, owed: e.owed },
    ]);
    expect(s.period).toEqual({ from: S5_WEEK.from, to: S5_WEEK.to, timezone: "America/Chicago" });
    expect(s.owed).toEqual({ current: e.owed, statement: null, asOf: LIABILITY_AT.toISOString(), source: "plaid" });
    expect({
      purchases: ac(s.purchases),
      reimbursable: ac(s.purchases.reimbursable),
      refunds: ac(s.refunds),
      payments: ac(s.payments),
      otherCredits: ac(s.otherCredits),
      otherCharges: ac(s.otherCharges),
      notMine: ac(s.notMine),
    }).toEqual({
      purchases: e.purchases,
      reimbursable: e.reimbursable,
      refunds: e.refunds,
      payments: e.payments,
      otherCredits: e.otherCredits,
      otherCharges: e.otherCharges,
      notMine: e.notMine,
    });
    expect(s.householdContribution).toEqual({ ...e.household, link: "/spending/week" });
    expect([s.planLink.kind, s.planLink.payoff, s.planLink.payoffDate, s.planLink.basis].join(" ")).toBe(e.plan);
    // Rows read the household's alias ("Costco"), else the cleaned bank description.
    expect({ unplanned: attention(s, "unplanned"), unfiled: attention(s, "unfiled"), uncategorized: attention(s, "uncategorized") }).toEqual(e.attention);
    expect([s.needsAttention.unplanned, s.needsAttention.unfiled, s.needsAttention.uncategorized].map(ac)).toEqual(["120.00/1", "65.00/2", "80.00/1"]);
    expect(s.needsAttention.truncated).toBe(false);
    expect(s.limitations).toEqual([]);
    // Every row says its card.
    for (const r of s.needsAttention.unfiled.rows) expect(r.card).toEqual({ accountId: ext.plat, name: "Everyday Plat", mask: "1001" });
    // The review note's sample: S5_PRINT_SAMPLE=<file> writes this answer (and the Gold card's) there.
    if (process.env.S5_PRINT_SAMPLE) {
      writeFileSync(process.env.S5_PRINT_SAMPLE, JSON.stringify({ platinumWeek: s, goldWeek: await summary(ext.gold!) }, null, 2));
    }
  });

  it("⭐ purchases − refunds for the payoff week = the card's weekCharges, to the cent", async () => {
    const [s, payoff] = await Promise.all([summary(ext.plat!), get(`/amex/weekly-payoff?weekStart=${S5_WEEK.from}`)]);
    const card = (payoff.cards as any[]).find((c) => c.accountId === ext.plat)!;
    expect(card.weekCharges).toBe(S5_EXPECTED.plat.weekCharges);
    expect(cents(s.purchases.amount) - cents(s.refunds.amount)).toBe(cents(card.weekCharges));
  });

  it("every row on the card is in exactly one bucket: the buckets add up to the raw rows (replaced pending out)", async () => {
    const s = await summary(ext.plat!);
    const replaced = await loadSupersededPendingIds(HH[OWNER]!.householdId);
    const raw = (
      await db
        .select()
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.plaidAccountId, ext.plat!),
            gte(transactionsTable.occurredOn, S5_WEEK.from),
            lte(transactionsTable.occurredOn, S5_WEEK.to),
          ),
        )
    ).filter((t) => !replaced.has(t.id));
    const charges = raw.reduce((a, t) => a + cents(spendAmount(t)), 0);
    const credits = raw.reduce((a, t) => a + cents(creditAmount(t)), 0);
    expect(cents(s.purchases.amount) + cents(s.otherCharges.amount) + cents(s.notMine.amount)).toBe(charges);
    expect(cents(s.refunds.amount) + cents(s.payments.amount) + cents(s.otherCredits.amount)).toBe(credits);
    expect(s.purchases.count + s.otherCharges.count + s.notMine.count + s.refunds.count + s.payments.count + s.otherCredits.count).toBe(raw.length);
  });

  it("a payment is a payment only, a refund a refund only; pending→posted once; a split parent once, on its card", async () => {
    const [plat, gold] = await Promise.all([summary(ext.plat!, S5_WEEK.from, S5_WEEK.to, "&rowsPerGroup=50"), summary(ext.gold!, S5_WEEK.from, S5_WEEK.to, "&rowsPerGroup=50")]);
    // The fixture means what it says: the posted Shell row replaced the pending one.
    expect((await loadSupersededPendingIds(HH[OWNER]!.householdId)).has(ids.shellPending!)).toBe(true);
    // The payment (200) is not in purchases or refunds; the refund (15) is not in payments.
    expect(ac(plat.payments)).toBe("200.00/1");
    expect(ac(plat.refunds)).toBe("15.00/1");
    // The pending Shell row is gone; its posted row counts once, with the filing it carried (Gas).
    const listed = (["unplanned", "unfiled", "uncategorized"] as const).flatMap((g) => plat.needsAttention[g].rows as any[]);
    expect(listed.map((r) => r.id)).not.toContain(ids.shellPending);
    expect(listed.filter((r) => r.id === ids.shellPosted).map((r) => [r.amount, r.category?.name, r.pending])).toEqual([["40.00", "Gas", false]]);
    // The split parent ($70: Groceries 50 / Home 20) is one purchase on the Platinum, none on the Gold.
    expect(plat.purchases.count).toBe(7);
    expect(ac(gold.purchases)).toBe(S5_EXPECTED.gold.purchases);
    const allPlat = await summary("all");
    expect(cents(allPlat.purchases.amount)).toBe(cents(plat.purchases.amount) + cents(gold.purchases.amount));
  });

  it("⭐ householdContribution = GET /money/period-breakdown for that account (week and month), to the cent", async () => {
    const [s, week] = await Promise.all([
      summary(ext.plat!),
      get(`/money/period-breakdown?period=week&start=${S5_WEEK.from}&account=${rowId.plat}`),
    ]);
    expect(s.householdContribution.weeklyPlan).toBe(week.actual);
    expect(s.householdContribution.unfiled).toBe(week.needsClassification.amount);
    const [blue, month] = await Promise.all([
      summary(ext.blue!, "2026-10-01", "2026-10-31"),
      get(`/money/period-breakdown?period=month&start=2026-10-01&account=${rowId.blue}`),
    ]);
    expect(blue.householdContribution.monthlyPlan).toBe(month.actual);
    expect(blue.householdContribution.monthlyPlan).toBe(S5_EXPECTED.blueMonth.monthlyPlan);
  });

  it("per card, purchases − reimbursable + not mine − refunds = what spending facts count; Σ = the week's household spend", async () => {
    const facts = await buildSpendingFacts(HH[OWNER]!.householdId, S5_WEEK.from, S5_WEEK.to);
    let total = 0;
    for (const key of ["plat", "gold", "blue"] as const) {
      const s = await summary(ext[key]!);
      total += Math.max(0, cents(s.purchases.amount) - cents(s.purchases.reimbursable.amount) + cents(s.notMine.amount) - cents(s.refunds.amount));
    }
    expect(facts.householdSpend.total).toBe(S5_EXPECTED.spendingFactsWeek);
    expect(total).toBe(cents(facts.householdSpend.total));
  });
});

describe("S5 · the debt-linked card and every card", () => {
  it("the Gold card (a debt): its own balance and statement, its debt as the plan", async () => {
    const s = await summary(ext.gold!);
    const e = S5_EXPECTED.gold;
    expect(s.scope.cards[0]).toMatchObject({ accountId: ext.gold, name: "Platinum", mask: "2002", debtLinked: true, debtId: debtId.gold, owed: e.owed });
    expect(s.owed).toEqual({ current: e.owed, statement: e.statement, asOf: LIABILITY_AT.toISOString(), source: "plaid" });
    expect(ac(s.payments)).toBe(e.payments);
    expect(s.planLink).toEqual({ ...e.plan, debtId: debtId.gold, payoff: null, payoffDate: null, basis: null });
    // Its purchases still count toward the household week — said, not hidden.
    expect(s.householdContribution).toEqual({ weeklyPlan: "250.00", monthlyPlan: "0.00", unfiled: "250.00", link: "/spending/week" });
  });

  it("⭐ owed is null when the anchor does not know it — never 0.00 (Blue: no Plaid balance, no debt)", async () => {
    const s = await summary(ext.blue!, "2026-10-01", "2026-10-31");
    expect(s.owed).toEqual({ current: null, statement: null, asOf: null, source: "missing" });
    expect(s.scope.cards[0].owed).toBeNull();
    expect(ac(s.purchases)).toBe(S5_EXPECTED.blueMonth.purchases);
    // The Monthly Spend hook pays the Blue card; with no monthly plan it keeps its stored amount, and says so.
    expect([s.planLink.kind, s.planLink.payoff, s.planLink.payoffDate, s.planLink.basis].join(" ")).toBe(S5_EXPECTED.blueMonth.plan);
  });

  it("\"all\" lists every Amex card, the debt one included; owed is the combined anchor (= GET /amex/anchor)", async () => {
    const [s, anchor] = await Promise.all([summary("all"), get("/amex/anchor")]);
    const e = S5_EXPECTED.all;
    expect(s.scope).toMatchObject({ kind: "all", accountId: null, name: null, mask: null, institution: null });
    expect(s.scope.cards.map((c: any) => [c.accountId, c.name, c.mask, c.debtLinked, c.owed])).toEqual([
      [ext.blue, "Blue Cash", "3003", false, null],
      [ext.gold, "Platinum", "2002", true, S5_EXPECTED.gold.owed],
      [ext.plat, "Everyday Plat", "1001", false, S5_EXPECTED.plat.owed],
    ]);
    expect(s.owed.current).toBe(e.owed);
    expect(cents(s.owed.current)).toBe(cents(anchor.amexEndingBalance));
    expect(s.owed.source).toBe(anchor.source);
    expect([ac(s.purchases), ac(s.refunds), ac(s.payments)]).toEqual([e.purchases, e.refunds, e.payments]);
    expect(s.householdContribution).toEqual({ ...e.household, link: "/spending/week" });
    expect(ac(s.needsAttention.unfiled)).toBe(e.unfiled);
    // The hook that bills the band's cards (weekly first): the Saturday payoff.
    expect([s.planLink.kind, s.planLink.payoff].join(" ")).toBe("weekly_hook 600.00");
  });

  it("⭐ GET /amex/weekly-payoff: cards and combinedWeekCharges as before; the debt card is in debtLinkedCards", async () => {
    const p = await get(`/amex/weekly-payoff?weekStart=${S5_WEEK.from}`);
    expect((p.cards as any[]).map((c) => [c.accountId, c.cadence, c.weekCharges, c.debtId])).toEqual([
      [ext.blue, "monthly", 45, null],
      [ext.plat, "weekly", S5_EXPECTED.plat.weekCharges, null],
    ]);
    expect(p.combinedWeekCharges).toBe(S5_EXPECTED.combinedWeekCharges);
    expect(p.debtLinkedCards).toEqual([
      { accountId: ext.gold, name: "Gold Card", mask: "2002", debtId: debtId.gold, brand: "silver", cadence: "weekly", displayName: null },
    ]);
  });

  it("a household with no Amex card: \"all\" is empty and owed unknown, never 0", async () => {
    const s = (await call(`/amex/summary?accountId=all&from=${S5_WEEK.from}&to=${S5_WEEK.to}`, EMPTY)).body;
    expect(s.scope.cards).toEqual([]);
    expect(s.owed).toEqual({ current: null, statement: null, asOf: null, source: "missing" });
    expect([s.purchases, s.refunds, s.payments].map(ac)).toEqual(["0.00/0", "0.00/0", "0.00/0"]);
    expect(s.planLink.kind).toBe("none");
    const p = (await call(`/amex/weekly-payoff?weekStart=${S5_WEEK.from}`, EMPTY)).body;
    expect(p.debtLinkedCards).toEqual([]);
  });
});

describe("S5 · bounds and refusals", () => {
  it("rows are bounded per group, largest first; the group's total still covers every row", async () => {
    const s = await summary(ext.plat!, S5_WEEK.from, S5_WEEK.to, "&rowsPerGroup=1");
    expect(s.needsAttention.unfiled.rows.map((r: any) => r.amount)).toEqual(["40.00"]);
    expect(ac(s.needsAttention.unfiled)).toBe("65.00/2");
    expect(s.needsAttention.unfiled.truncated).toBe(true);
    expect(s.needsAttention.truncated).toBe(true);
  });

  it("a period that starts before tracking is clamped, and says so", async () => {
    const s = await summary(ext.plat!, "2026-04-01", S5_WEEK.to);
    expect(s.period.from).toBe("2026-05-01");
    expect(s.limitations).toEqual(["tracking_start:2026-05-01"]);
  });

  it("refuses what it cannot answer", async () => {
    const refuse = async (q: string, status: number, error: string) => {
      const r = await call(`/amex/summary?${q}`);
      expect([r.status, r.body.error], q).toEqual([status, error]);
    };
    await refuse(`accountId=${ext.chase}&from=${S5_WEEK.from}&to=${S5_WEEK.to}`, 404, "card_not_found");
    await refuse(`accountId=nobody&from=${S5_WEEK.from}&to=${S5_WEEK.to}`, 404, "card_not_found");
    await refuse(`accountId=all&from=2026-10-10&to=2026-10-04`, 400, "from_after_to");
    await refuse(`accountId=all&from=2026-10-09&to=2026-10-10`, 400, "from_in_future");
    await refuse(`accountId=all&from=2026-02-30&to=2026-10-10`, 400, "invalid_date");
    await refuse(`accountId=all&from=2026-01-01&to=2026-04-30`, 400, "before_tracking_start");
    await refuse(`accountId=all&from=2025-05-01&to=2026-10-10`, 400, "range_too_long");
    await refuse(`accountId=all&from=${S5_WEEK.from}&to=${S5_WEEK.to}&rowsPerGroup=1e1`, 400, "invalid_rows_per_group");
    await refuse(`accountId=all&from=${S5_WEEK.from}&to=${S5_WEEK.to}&rowsPerGroup=51`, 400, "invalid_query");
    await refuse(`from=${S5_WEEK.from}&to=${S5_WEEK.to}`, 400, "invalid_query");
  });
});
