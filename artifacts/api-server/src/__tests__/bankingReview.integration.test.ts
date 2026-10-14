// ⭐ (S4) GET /banking/review — "I want to review banking and immediately see
// what wasn't in the plan." The scenario, its hand arithmetic and every row's
// expected place are in ./_fixtures/bankingReviewScenario.ts. Synthetic data only.
//
// What this file proves:
//   - every counted row is placed exactly once, by the rules in order (one row
//     per rule), and (Σ buckets + as planned) − cash flow = "0.00" for every range;
//   - cashFlow and balance are GET /transactions/ledger's, to the cent;
//   - a pending row its posted row replaced counts once, and its answer carries;
//   - another account is never compared (all "not compared", no balance);
//   - the badge is computeReviewCount's, with its real scope;
//   - the balance tie is read from what the Sync stored;
//   - paging one bucket never skips or repeats a row.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `s4-banking-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HH;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { GetBankingReviewResponse } from "@workspace/api-zod";
import bankingRouter from "../routes/banking";
import transactionsLedgerRouter from "../routes/transactionsLedger";
import forecastRouter from "../routes/forecast";
import spineRouter from "../routes/spine";
import moneyRouter from "../routes/money";
import { computeReviewCount } from "../lib/reviewCount";
import { buildForecastLedger } from "../lib/forecastLedger";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import {
  ACCOUNTS,
  ANSWERS,
  AS_PLANNED_OCTOBER,
  CATEGORIES,
  DEBTS,
  EXPECTED_OCTOBER,
  NOW,
  OCTOBER_TOTALS,
  PLANNED_OCTOBER,
  PLANS,
  ROWS,
  SNAPSHOT,
  type AccountKey,
  type RowKey,
} from "./_fixtures/bankingReviewScenario";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
for (const r of [bankingRouter, transactionsLedgerRouter, forecastRouter, spineRouter, moneyRouter]) app.use(r);

let server: Server;
let baseUrl = "";

const acct: Record<AccountKey, { rowId: string; ext: string }> = {} as never;
const cat: Record<string, string> = {};
const plan: Record<string, string> = {};
const debt: Record<string, string> = {};
const row: Record<string, string> = {};
const keyOfRow = new Map<string, RowKey>();

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

async function call(path: string): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${baseUrl}${path}`);
  return { status: r.status, body: (await r.json()) as Json };
}
async function get(path: string): Promise<Json> {
  const r = await call(path);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const review = async (qs: string): Promise<Json> => {
  const body = await get(`/banking/review?${qs}`);
  // The generated schema accepts every response.
  expect(() => GetBankingReviewResponse.parse(body)).not.toThrow();
  return body;
};

const BUCKETS = ["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"] as const;
const cents = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 100);

async function cleanup(): Promise<void> {
  if (!HH) return;
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, HH));
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, HH));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, HH));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, HH));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  const owned = { userId: OWNER, householdId: HH };

  for (const [key, a] of Object.entries(ACCOUNTS) as Array<[AccountKey, (typeof ACCOUNTS)[AccountKey]]>) {
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        ...owned,
        itemId: `s4-item-${key}-${randomUUID()}`,
        accessToken: "t",
        institutionName: a.institution,
        institutionSlug: key === "amex" ? "amex" : "chase",
        lastSyncedAt: new Date("2026-10-14T09:00:00-05:00"),
      })
      .returning();
    const ext = `s4-${key}-${randomUUID().slice(0, 8)}`;
    const [r] = await db
      .insert(plaidAccountsTable)
      .values({ ...owned, itemId: item!.id, accountId: ext, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })
      .returning();
    acct[key] = { rowId: r!.id, ext };
  }

  await db.insert(forecastSettingsTable).values({
    ...owned,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "500.00",
    bankSnapshotBalance: SNAPSHOT.balance,
    bankSnapshotAt: SNAPSHOT.at,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct.chase.rowId,
    bankSnapshotMask: ACCOUNTS.chase.mask,
  });

  for (const [key, c] of Object.entries(CATEGORIES)) {
    const [r] = await db.insert(budgetCategoriesTable).values({ ...owned, name: c.name, kind: c.kind, groupName: "S4" }).returning();
    cat[key] = r!.id;
  }

  for (const [key, p] of Object.entries(PLANS)) {
    const day = String(p.day).padStart(2, "0");
    const [r] = await db
      .insert(recurringItemsTable)
      .values({
        ...owned,
        name: p.name,
        kind: p.kind,
        amount: p.amount,
        frequency: "monthly",
        dayOfMonth: p.day,
        anchorDate: `2026-10-${day}`,
        active: "true",
        categoryId: "category" in p && p.category ? cat[p.category]! : null,
      })
      .returning();
    plan[key] = r!.id;
  }

  for (const [key, d] of Object.entries(DEBTS)) {
    const [r] = await db
      .insert(debtsTable)
      .values({
        ...owned,
        name: d.name,
        balance: d.balance,
        originalBalance: d.balance,
        apr: "0",
        minPayment: d.minPayment,
        payment: "0",
        dueDay: d.dueDay,
        type: d.type,
        createdAt: new Date("2026-01-01T12:00:00-06:00"),
      })
      .returning();
    debt[key] = r!.id;
  }

  for (const [key, spec] of Object.entries(ROWS) as Array<[RowKey, (typeof ROWS)[RowKey]]>) {
    const s = spec as {
      on: string;
      desc: string;
      amount: string;
      account: AccountKey;
      category?: string;
      pending?: boolean;
      unplanned?: boolean;
      transfer?: boolean;
      debt?: string;
      pfc?: string;
    };
    const [r] = await db
      .insert(transactionsTable)
      .values({
        ...owned,
        occurredOn: s.on,
        createdAt: createdAtStartOfHouseholdDay(s.on),
        description: s.desc,
        amount: s.amount,
        plaidAccountId: acct[s.account].ext,
        plaidTransactionId: `s4-${key}-${randomUUID().slice(0, 8)}`,
        source: s.account === "amex" ? "plaid:amex" : "plaid:chase",
        categoryId: s.category ? cat[s.category]! : null,
        pending: s.pending ?? false,
        unplannedAllowance: s.unplanned ?? false,
        isTransfer: s.transfer ?? false,
        debtId: s.debt ? debt[s.debt]! : null,
        pfcDetailed: s.pfc ?? null,
        forecastFlag: s.account === "chase",
      })
      .returning({ id: transactionsTable.id });
    row[key] = r!.id;
    keyOfRow.set(r!.id, key);
  }

  for (const a of ANSWERS) {
    const p = a.plan ? PLANS[a.plan] : null;
    await db.insert(forecastResolutionsTable).values({
      ...owned,
      recurringItemId: a.plan ? plan[a.plan]! : null,
      occurrenceDate: p ? `2026-10-${String(p.day).padStart(2, "0")}` : null,
      status: a.status,
      matchedTxnId: row[a.row]!,
    });
  }

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

/** Every row of every bucket, paged to the end, as "<bucket> <reason> <kind>" by fixture key. */
async function placementsOf(qs: string): Promise<Map<RowKey, string>> {
  const out = new Map<RowKey, string>();
  for (const b of BUCKETS) {
    let cursor: string | null = null;
    do {
      const page: Json = (await review(`${qs}&bucket=${b}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).page;
      for (const r of page.rows) {
        const k = keyOfRow.get(r.id)!;
        expect(out.has(k), `${k} placed twice`).toBe(false);
        out.set(k, `${b} ${r.reason} ${r.kind}`);
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  return out;
}

/** The parity every range owes: ledger totals and balances, and nothing unexplained. */
async function expectTiesToLedger(qs: string, ledgerQs: string): Promise<Json> {
  const [r, ledger] = await Promise.all([review(qs), get(`/transactions/ledger?${ledgerQs}&limit=1`)]);
  // The ledger page's own shape is unchanged by the shared totals read.
  expect(Object.keys(ledger.totals).sort()).toEqual(["count", "moneyIn", "moneyOut", "net"]);
  expect(Object.keys(ledger.review).sort()).toEqual(["reviewed", "unreviewed"]);
  expect(r.cashFlow.moneyIn, `${qs} moneyIn`).toBe(ledger.totals.moneyIn);
  expect(r.cashFlow.moneyOut, `${qs} moneyOut`).toBe(ledger.totals.moneyOut);
  expect(r.cashFlow.net, `${qs} net`).toBe(ledger.totals.net);
  expect(r.cashFlow.count, `${qs} count`).toBe(ledger.totals.count);
  expect(r.balance.end, `${qs} balance.end`).toBe(ledger.balanceEnd);
  expect(r.balance.start, `${qs} balance.start`).toBe(ledger.balanceStart);
  expect(r.balance.today, `${qs} balance.today`).toBe(ledger.balanceToday);
  expect(r.balance.unavailableReason, `${qs} unavailableReason`).toBe(ledger.balanceUnavailableReason);
  expect(r.reconciliation, `${qs} reconciliation`).toEqual({ rowsPlaced: r.reconciliation.rowsPlaced, rowsUnexplained: 0, unexplained: "0.00" });
  // Σ buckets + as planned = cash flow, to the cent, from the response itself.
  const sum = BUCKETS.reduce((a, b) => a + cents(r.notInPlan[b].net), 0) + cents(r.asPlanned.net);
  expect(sum, `${qs} Σ buckets + asPlanned`).toBe(cents(r.cashFlow.net));
  const count = BUCKETS.reduce((a, b) => a + r.notInPlan[b].count, 0) + r.asPlanned.count;
  expect(count + r.cashFlow.supersededExcluded + r.cashFlow.otherExcluded, `${qs} rows`).toBe(r.cashFlow.count);
  return r;
}

describe("S4 · GET /banking/review — the forecast account", () => {
  it("⭐ October 1–14: every counted row lands exactly once, where the rules put it", async () => {
    const placements = await placementsOf("from=2026-10-01&to=2026-10-14");
    expect(Object.fromEntries(placements)).toEqual(EXPECTED_OCTOBER);
    // As planned is totals only: the rest of the counted October rows, by elimination.
    const october = (Object.keys(ROWS) as RowKey[]).filter(
      (k) => ROWS[k].account === "chase" && ROWS[k].on >= "2026-10-01" && k !== "shellPending",
    );
    expect(october.filter((k) => !placements.has(k)).sort()).toEqual([...AS_PLANNED_OCTOBER].sort());
    const r = await review("from=2026-10-01&to=2026-10-14");
    const asPlannedCents = AS_PLANNED_OCTOBER.reduce((a, k) => a + cents(ROWS[k].amount), 0);
    expect(r.asPlanned).toMatchObject({ count: AS_PLANNED_OCTOBER.length, net: (asPlannedCents / 100).toFixed(2) });
  });

  it("⭐ October 1–14: the buckets add up to the ledger's cash flow, by hand", async () => {
    const r = await expectTiesToLedger("from=2026-10-01&to=2026-10-14", "from=2026-10-01&to=2026-10-14");
    expect(r.cashFlow).toEqual(OCTOBER_TOTALS.cashFlow);
    expect(r.asPlanned).toEqual(OCTOBER_TOTALS.asPlanned);
    for (const b of BUCKETS) {
      const { count, moneyIn, moneyOut, net, pendingNet } = r.notInPlan[b];
      const want = OCTOBER_TOTALS[b] as Json;
      expect({ count, moneyIn, moneyOut, net, pendingNet }, b).toEqual({
        count: want.count,
        moneyIn: want.moneyIn,
        moneyOut: want.moneyOut,
        net: want.net,
        pendingNet: want.pendingNet,
      });
    }
    expect(r.notInPlan.amountDifference.differenceTotal).toBe("233.40");
    for (const b of ["timingDifference", "confirmedUnplanned", "uncertain", "unmatched"] as const) {
      expect(r.notInPlan[b].differenceTotal).toBeNull();
    }
    expect(r.notInPlan.unmatched.byKind).toEqual({
      spending: { count: 3, moneyIn: "0.00", moneyOut: "112.80", net: "-112.80", pendingNet: "-6.50" },
      card_payment: { count: 1, moneyIn: "0.00", moneyOut: "250.00", net: "-250.00", pendingNet: "0.00" },
      debt_payment: { count: 1, moneyIn: "0.00", moneyOut: "300.00", net: "-300.00", pendingNet: "0.00" },
      transfer: { count: 1, moneyIn: "0.00", moneyOut: "500.00", net: "-500.00", pendingNet: "0.00" },
      income: { count: 1, moneyIn: "300.00", moneyOut: "0.00", net: "300.00", pendingNet: "0.00" },
      refund: { count: 1, moneyIn: "25.00", moneyOut: "0.00", net: "25.00", pendingNet: "0.00" },
      other: { count: 1, moneyIn: "100.00", moneyOut: "0.00", net: "100.00", pendingNet: "0.00" },
    });
    expect(r.notInPlan.uncertain.byReason).toEqual({
      needs_review: { count: 1, moneyIn: "0.00", moneyOut: "70.00", net: "-70.00", pendingNet: "0.00" },
      suggested_match: { count: 1, moneyIn: "0.00", moneyOut: "75.00", net: "-75.00", pendingNet: "0.00" },
      not_compared: { count: 0, moneyIn: "0.00", moneyOut: "0.00", net: "0.00", pendingNet: "0.00" },
    });
    expect(r.notInPlan.unmatched.byReason).toBeNull();
    expect(r.notInPlan.uncertain.byKind).toBeNull();
  });

  it("identity, period, comparison window and freshness are always there", async () => {
    const r = await review("from=2026-10-01&to=2026-10-14");
    // For the review note: S4_PRINT_SAMPLE=<file> writes a small response there.
    if (process.env.S4_PRINT_SAMPLE) {
      writeFileSync(process.env.S4_PRINT_SAMPLE, JSON.stringify(await review("from=2026-10-01&to=2026-10-14&rowsPerBucket=1"), null, 2));
    }
    expect(r.account).toEqual({
      id: acct.chase.rowId,
      institution: "Chase",
      name: "Total Checking",
      mask: "4321",
      isForecastAccount: true,
      lastSyncedAt: new Date("2026-10-14T09:00:00-05:00").toISOString(),
    });
    expect(r.period).toEqual({ from: "2026-10-01", to: "2026-10-14", today: "2026-10-14", timezone: "America/Chicago" });
    expect(r.planComparison).toEqual({
      available: true,
      reason: null,
      comparedFrom: "2026-08-16",
      plansFrom: "2026-09-01",
      through: "2026-10-14",
    });
    expect(r.freshness).toMatchObject({ source: "plaid", stale: false });
    // The spine's own bank balance.
    const spine = await get("/spine");
    expect(r.balance.today).toBe(spine.bank.balance);
    expect(r.balance.asOf).toBe(spine.bank.asOfDate);
  });

  it("rows carry their plan, amounts and flags — the UN flag and a missing category are shown, never a rule", async () => {
    const r = await review("from=2026-10-01&to=2026-10-14&rowsPerBucket=50");
    const all: Json[] = BUCKETS.flatMap((b) => r.notInPlan[b].rows);
    const byKey = new Map(all.map((x) => [keyOfRow.get(x.id)!, x] as const));
    expect(byKey.get("target")).toMatchObject({
      displayName: expect.any(String),
      amount: "-64.20",
      kind: "spending",
      reason: "no_plan",
      evidence: null,
      plan: null,
      category: null,
      flags: { unplannedAllowance: true, weeklyAllowance: false, monthlyAllowance: false, reimbursable: false, transfer: false, cardPayment: false },
    });
    expect(byKey.get("amexPayment")).toMatchObject({ kind: "card_payment", reason: "no_plan" });
    expect(byKey.get("kroger")).toMatchObject({ category: { id: cat.groceries, name: "Groceries" }, reason: "no_plan" });
    expect(byKey.get("starbucks")).toMatchObject({ pending: true, amount: "-6.50", manual: false });
    expect(byKey.get("capone")).toMatchObject({
      evidence: "automatic",
      reason: "amount",
      plan: {
        key: `debt:${debt.capitalOne}|2026-10-02`,
        label: "Capital One Platinum minimum",
        scheduledDate: "2026-10-02",
        planned: "-40.00",
        difference: "260.00",
        dayDelta: 2,
      },
    });
    expect(byKey.get("insurance")).toMatchObject({
      evidence: "confirmed",
      reason: "partial",
      plan: { label: "Car Insurance", planned: "-200.00", difference: "-50.00", dayDelta: 0 },
    });
    expect(byKey.get("gym")).toMatchObject({
      evidence: "confirmed",
      reason: "timing",
      plan: { label: "Gym Membership", scheduledDate: "2026-10-01", planned: "-40.00", difference: "0.00", dayDelta: 7 },
    });
    expect(byKey.get("zelle")).toMatchObject({
      evidence: null,
      reason: "suggested_match",
      plan: { label: "Lawn Service", planned: "-75.00", difference: "0.00", dayDelta: 0 },
    });
    expect(byKey.get("spectrum")).toMatchObject({ reason: "needs_review", plan: { label: "Internet", planned: "-70.00" } });
    // Largest first inside a bucket.
    const unmatched = r.notInPlan.unmatched.rows.map((x: Json) => keyOfRow.get(x.id));
    expect(unmatched).toEqual(["toSavings", "irs", "toyota", "amexPayment", "deposit", "target", "kroger", "refund", "starbucks"]);
  });

  it("the suggestion is the forecast's own pair (GET /forecast/cash-signal), never re-derived", async () => {
    const signal = await get("/forecast/cash-signal");
    const pair = (signal.matches as Json[]).find((m) => m.txnId === row.zelle);
    expect(pair).toMatchObject({ planKey: `${plan.lawn}|2026-10-07`, tier: 3, offCurve: false });
    const paid = (signal.overdueAssumedPaid as Json[]).find((p) => p.txnId === row.capone);
    expect(paid).toMatchObject({ confidence: "card_payment", planAmount: "-40.00" });
  });

  it("planned: the occurrences due in the range, with the fate the ledger decided", async () => {
    const r = await review("from=2026-10-01&to=2026-10-14");
    const lines = (r.planned as Json[]).map((p) =>
      p.txnId
        ? `${p.scheduledDate} ${p.label} ${p.fate} ${p.planned} ← ${p.txnAmount} on ${p.txnDate} (${p.dayDelta >= 0 ? "+" : ""}${p.dayDelta}d, diff ${p.difference})`
        : `${p.scheduledDate} ${p.label} ${p.fate} ${p.planned}`,
    );
    expect(lines).toEqual(PLANNED_OCTOBER);
    const insurance = (r.planned as Json[]).find((p) => p.label === "Car Insurance")!;
    expect(insurance).toMatchObject({ remainder: "-50.00", onCurve: true, txnOnThisAccount: true });
    const internet = (r.planned as Json[]).find((p) => p.label === "Internet")!;
    expect(internet).toMatchObject({ onCurve: true, txnId: null });
  });

  it("the ledger's plan occurrences do not reach the cash-signal output (the golden output is unchanged)", async () => {
    const signal = await get("/forecast/cash-signal");
    expect(signal).not.toHaveProperty("planOccurrences");
    expect(signal).not.toHaveProperty("planComparison");
    const ledger = await buildForecastLedger(HH, OWNER, { horizonDays: 90 });
    // Every occurrence the ledger expanded has exactly one fate.
    const keys = ledger.planOccurrences.map((o) => o.planKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Every plan on the curve is an occurrence the ledger says is on the curve.
    for (const it of ledger.items) {
      if (it.kind !== "plan") continue;
      const o = ledger.planOccurrences.find((x) => x.planKey === `${it.itemId}|${it.occurrenceDate}`);
      expect(o?.onCurve, `${it.label} ${it.occurrenceDate}`).toBe(true);
    }
    // …and every occurrence said to be on the curve is on it.
    for (const o of ledger.planOccurrences.filter((x) => x.onCurve)) {
      expect(
        ledger.items.some((it) => it.kind === "plan" && `${it.itemId}|${it.occurrenceDate}` === o.planKey),
        o.planKey,
      ).toBe(true);
    }
  });

  it("⭐ the reconciliation is zero for every range, and cash flow = the ledger's totals", async () => {
    for (const [from, to] of [
      ["2026-10-01", "2026-10-14"],
      ["2026-10-01", "2026-10-31"],
      ["2026-08-01", "2026-10-14"],
      ["2026-09-01", "2026-09-30"],
      ["2026-10-12", "2026-10-12"],
      ["2026-10-11", "2026-10-11"],
      ["2025-10-15", "2026-10-14"],
    ]) {
      await expectTiesToLedger(`from=${from}&to=${to}`, `from=${from}&to=${to}`);
    }
  });

  it("rule 6: a row before the comparison window is not compared — uncertain, never unplanned", async () => {
    const placements = await placementsOf("from=2026-08-01&to=2026-10-14");
    expect(placements.get("old")).toBe("uncertain not_compared spending");
    expect(placements.get("hardware")).toBe("unmatched no_plan spending");
    for (const k of AS_PLANNED_OCTOBER) expect(placements.has(k), k).toBe(false);
    for (const [k, v] of Object.entries(EXPECTED_OCTOBER)) expect(placements.get(k as RowKey), k).toBe(v);
    const r = await review("from=2026-08-01&to=2026-10-14");
    expect(r.notInPlan.uncertain.byReason.not_compared).toMatchObject({ count: 1, net: "-20.00" });
    // September: no rows; the overdue Capital One minimum is listed as outside the forecast.
    const sep = await review("from=2026-09-01&to=2026-09-30");
    expect(sep.planned.map((p: Json) => `${p.scheduledDate} ${p.label} ${p.fate}`)).toEqual([
      "2026-09-02 Capital One Platinum minimum overdue_outside",
    ]);
    expect(sep.cashFlow).toMatchObject({ count: 0, net: "0.00" });
  });

  it("pending → posted counts once; the answer on the pending row carries to the posted row", async () => {
    const r = await review("from=2026-10-11&to=2026-10-12&rowsPerBucket=50");
    expect(r.cashFlow).toMatchObject({ supersededExcluded: 1, count: 4 });
    const ids = BUCKETS.flatMap((b) => r.notInPlan[b].rows.map((x: Json) => x.id));
    expect(ids).not.toContain(row.shellPending);
    expect(ids.filter((id: string) => id === row.shell)).toHaveLength(1);
    const shell = r.notInPlan.confirmedUnplanned.rows.find((x: Json) => x.id === row.shell);
    expect(shell).toMatchObject({ amount: "-47.50", reason: "ignored_unforecasted", pending: false });
  });

  it("reviewInbox: the badge is computeReviewCount's, with its scope; the range's own count beside it", async () => {
    const r = await review("from=2026-10-01&to=2026-10-14");
    const badge = await computeReviewCount(HH, OWNER);
    expect(r.reviewInbox.badgeCount).toBe(badge);
    expect(r.reviewInbox.badgeCount).toBe((await get("/forecast/review-count")).count);
    expect(r.reviewInbox.badgeScope).toBe("this calendar month, forecast account");
    // 23 October rows; answered: Verizon, Electric, Car Insurance, Gym, Cash App,
    // Venmo, the Shell pending row. (S6) The badge reads the same pairs as the
    // review: the replaced pending row is out and its answer carries to the
    // posted Shell row → 15 (it was 16: the posted Shell row was asked again).
    expect(badge).toBe(15);
    // The review places 22 rows (the replaced pending row is out) and the Shell
    // answer carries to its posted row → 15. "Not this" (Kroger) and the pair
    // waiting for review (Spectrum) still wait.
    expect(r.reviewInbox.unresolvedInRange).toBe(15);
    // Over the same days (10/01 – today) the badge and the review now agree.
    expect(r.reviewInbox.unresolvedInRange).toBe(badge);
  });

  it("balanceTie: not checked until a Sync stores one; then that check, for this account only", async () => {
    expect((await review("from=2026-10-01&to=2026-10-14")).balanceTie).toEqual({ status: "not_checked", checkedAt: null, unexplained: null });
    await db
      .update(forecastSettingsTable)
      .set({ lastBankReconciliation: { checkedAt: "2026-10-14T14:00:00.000Z", accountId: acct.chase.ext, unexplained: "-12.34", status: "drift" } })
      .where(eq(forecastSettingsTable.userId, OWNER));
    try {
      expect((await review("from=2026-10-01&to=2026-10-14")).balanceTie).toEqual({
        status: "drift",
        checkedAt: "2026-10-14T14:00:00.000Z",
        unexplained: "-12.34",
      });
      // Another account's review never borrows the checking account's tie.
      expect((await review(`account=${acct.savings.rowId}&from=2026-10-01&to=2026-10-14`)).balanceTie.status).toBe("not_checked");
    } finally {
      await db.update(forecastSettingsTable).set({ lastBankReconciliation: null }).where(eq(forecastSettingsTable.userId, OWNER));
    }
  });

  it("household: secondary, labelled, the money position's own week", async () => {
    const [r, pos] = await Promise.all([review("from=2026-10-01&to=2026-10-14"), get("/money/position")]);
    expect(r.household).toEqual({
      scope: "all accounts · this week",
      weekStart: pos.weekStart,
      weekEnd: pos.weekEnd,
      spentWeek: pos.spentWeekDiscretionary,
      weekPlan: pos.weekCap,
      remainingWeek: pos.remainingWeek,
    });
    // No weekly plan in this household: "not set" is null, never "0.00".
    expect(r.household.weekPlan).toBeNull();
    expect(r.household.remainingWeek).toBeNull();
  });

  it("paging one bucket: largest first, never a row skipped or repeated; kind narrows unmatched", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Json = (await review(`from=2026-10-01&to=2026-10-14&bucket=unmatched&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).page;
      expect(page.limit).toBe(4);
      seen.push(...page.rows.map((x: Json) => keyOfRow.get(x.id)!));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["toSavings", "irs", "toyota", "amexPayment", "deposit", "target", "kroger", "refund", "starbucks"]);
    const cards = await review("from=2026-10-01&to=2026-10-14&bucket=unmatched&kind=card_payment");
    expect(cards.page.rows.map((x: Json) => keyOfRow.get(x.id))).toEqual(["amexPayment"]);
    expect(cards.page.kind).toBe("card_payment");
    // rowsPerBucket caps each bucket's own list and says so.
    const small = await review("from=2026-10-01&to=2026-10-14&rowsPerBucket=2");
    expect(small.notInPlan.unmatched.rows).toHaveLength(2);
    expect(small.notInPlan.unmatched.truncated).toBe(true);
    expect(small.notInPlan.unmatched.count).toBe(9);
    expect(small.page).toBeNull();
  });

  it("refuses what it cannot answer", async () => {
    const bad = async (qs: string) => (await call(`/banking/review?${qs}`)).status;
    expect(await bad("to=2026-10-14")).toBe(400);
    expect(await bad("from=2026-10-14&to=2026-10-01")).toBe(400);
    expect(await bad("from=2026-10-15&to=2026-10-31")).toBe(400);
    expect(await bad("from=2025-01-01&to=2026-10-14")).toBe(400);
    expect(await bad("from=2026-02-30&to=2026-03-01")).toBe(400);
    expect(await bad("from=2026-10-01&to=2026-10-14&kind=spending")).toBe(400);
    expect(await bad("from=2026-10-01&to=2026-10-14&bucket=nope")).toBe(400);
    expect(await bad("from=2026-10-01&to=2026-10-14&limit=1e1")).toBe(400);
    expect(await bad("from=2026-10-01&to=2026-10-14&rowsPerBucket=51")).toBe(400);
    expect(await bad("from=2026-10-01&to=2026-10-14&bucket=unmatched&cursor=abc")).toBe(400);
    expect(await bad("from=2026-10-01&to=2026-10-14&cursor=abc")).toBe(400);
    expect(await bad(`from=2026-10-01&to=2026-10-14&account=${acct.amex.rowId}`)).toBe(400);
    expect(await bad(`from=2026-10-01&to=2026-10-14&account=${randomUUID()}`)).toBe(400);
    expect(await bad("from=2026-10-01&to=2026-10-14&account=not-a-uuid")).toBe(400);
  });
});

describe("S4 · GET /banking/review — another account", () => {
  it("is never compared with the plan: every row not compared, no balance, no planned list", async () => {
    const qs = `account=${acct.savings.rowId}&from=2026-10-01&to=2026-10-14`;
    const r = await expectTiesToLedger(qs, qs);
    expect(r.planComparison).toEqual({ available: false, reason: "not_forecast_account", comparedFrom: null, plansFrom: null, through: null });
    expect(r.planned).toEqual([]);
    expect(r.balance).toEqual({ today: null, asOf: null, start: null, end: null, unavailableReason: "not_snapshot_account" });
    expect(r.freshness).toBeNull();
    expect(r.account).toMatchObject({ id: acct.savings.rowId, institution: "Chase", name: "Savings", mask: "8802", isForecastAccount: false });
    expect(r.asPlanned.count).toBe(0);
    for (const b of ["amountDifference", "timingDifference", "confirmedUnplanned", "unmatched"] as const) {
      expect(r.notInPlan[b].count, b).toBe(0);
    }
    expect(r.notInPlan.uncertain).toMatchObject({ count: 2, moneyIn: "501.20", net: "501.20" });
    expect(r.notInPlan.uncertain.rows.map((x: Json) => x.reason)).toEqual(["not_compared", "not_compared"]);
    expect(r.cashFlow).toMatchObject({ count: 2, net: "501.20" });
    // The badge is the household's, whatever account is reviewed. (S6: 16 → 15, the Shell pair once.)
    expect(r.reviewInbox.badgeCount).toBe(15);
  });
});
