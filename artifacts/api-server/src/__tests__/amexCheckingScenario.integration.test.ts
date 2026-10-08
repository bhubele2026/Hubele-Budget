// ⭐ PACKAGE B4 — THE COMPLETE AMEX + CHECKING SCENARIO, PROVEN ON IDENTICAL FIXTURES.
//
// The owner's reviewer asked for one household walked through: (1) an Amex
// grocery purchase, pending; (2) a checking grocery purchase; (3) the pending
// Amex purchase posting after a person filed it; (4) an Amex refund; (5) a
// checking-to-Amex payment — and, after each, the account views, the expense
// totals and the forecast, with no double count of a purchase and its card
// payment, refunds netting, pending→posted keeping the category, and every
// intentional numerical difference explained.
//
// NO FINANCIAL LOGIC IS CHANGED BY THIS FILE. It proves the engine as it is:
// every event goes through the product's own path — the real Plaid sync
// (`syncPlaidItem`, a stubbed Plaid client returning these rows) and the real
// PATCH /transactions/:id a person's filing uses — and every figure is read
// back through the real routes. Only the household's starting state is seeded
// directly (accounts, the snapshot, the cap, the plan, the hook, the debt).
//
// The expected table is ./_fixtures/amexCheckingScenario.ts; the arithmetic,
// the observed table and the differences are in
// docs/reviews/2026-10-08-b4-money-proof.md. Never loosen an expectation to go
// green: a difference is documented there and pinned in the fixture's DIFFERENCES, so
// the package that changes it notices.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

type PlaidTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  merchant_name: null;
  pending: boolean;
  pending_transaction_id: string | null;
  personal_finance_category: { primary: string; detailed: string } | null;
  datetime: null;
  authorized_datetime: null;
  iso_currency_code: "USD";
};
type SyncBatch = { added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string }[] };
/** What `/transactions/sync` returns next, per access token. Consumed by one sync. */
let syncQueue: Record<string, SyncBatch> = {};

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async ({ access_token }: { access_token: string }) => {
        const batch = syncQueue[access_token] ?? { added: [], modified: [], removed: [] };
        delete syncQueue[access_token];
        return { data: { ...batch, next_cursor: `c-${randomUUID()}`, has_more: false } };
      },
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({ data: { item: { item_id: "item-b4", consent_expiration_time: null } } }),
    }),
  };
});

const OWNER = `b4-amex-checking-${process.pid}-${randomUUID().slice(0, 8)}`;
const RUN = randomUUID().slice(0, 8);
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
  allowancePlansTable,
  budgetCategoriesTable,
  categoryDecisionsTable,
  debtLedgerEventsTable,
  debtMilestonesTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  merchantMemoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";
import transactionsRouter from "../routes/transactions";
import transactionsLedgerRouter from "../routes/transactionsLedger";
import amexRouter from "../routes/amex";
import forecastRouter from "../routes/forecast";
import spineRouter from "../routes/spine";
import moneyRouter from "../routes/money";
import categorizationRouter from "../routes/categorization";
import plaidRouter from "../routes/plaid";
import { createTestHousehold } from "./_helpers/testHousehold";
import {
  ACCOUNTS,
  AMEX_DEBT,
  AMEX_HISTORY,
  DIFFERENCES,
  DIFFERENCE_TITLES,
  EOD_DATES,
  contractValue,
  expectedToday,
  PAYCHECK,
  PLAID,
  SNAPSHOT,
  WEEKLY_CAP,
  WHEN,
  type Observed,
  type StepId,
} from "./_fixtures/amexCheckingScenario";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
for (const r of [
  transactionsLedgerRouter,
  transactionsRouter,
  amexRouter,
  forecastRouter,
  spineRouter,
  moneyRouter,
  categorizationRouter,
  plaidRouter,
]) {
  app.use(r);
}

let server: Server;
let baseUrl = "";

// Ids created in setup and carried across steps.
const item = { chase: "", amex: "", chaseToken: `access-sandbox-b4-chase-${RUN}`, amexToken: `access-sandbox-b4-amex-${RUN}` };
const cat: Record<string, string> = {};
const plan: Record<string, string> = {};
const catName = new Map<string, string>();
let amexPendingRowId = "";

const pid = (id: string) => `${id}-${RUN}`;
const acct = (a: "chase" | "amex") => `${ACCOUNTS[a].accountId}-${RUN}`;
const fmt = (v: unknown): string | null => (v == null ? null : Number(v).toFixed(2));

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
const get = <T>(path: string) => call<T>("GET", path);

function plaidRow(e: (typeof PLAID)[keyof typeof PLAID], pendingOf?: string): PlaidTxn {
  return {
    transaction_id: pid(e.id),
    account_id: acct(e.account),
    date: e.date,
    amount: e.amount,
    name: e.name,
    merchant_name: null,
    pending: e.pending,
    pending_transaction_id: pendingOf ? pid(pendingOf) : null,
    personal_finance_category: { ...e.pfc },
    datetime: null,
    authorized_datetime: null,
    iso_currency_code: "USD",
  };
}

/** One webhook-driven sync of one item, as production runs it. */
async function sync(which: "chase" | "amex", batch: Partial<SyncBatch>): Promise<void> {
  const token = which === "chase" ? item.chaseToken : item.amexToken;
  syncQueue[token] = { added: batch.added ?? [], modified: batch.modified ?? [], removed: batch.removed ?? [] };
  const res = await syncPlaidItem(OWNER, which === "chase" ? item.chase : item.amex);
  expect(res.error ?? null, `${which} sync error`).toBeNull();
}

type Txn = Record<string, unknown> & {
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  pending: boolean;
  plaidAccountId: string | null;
  categoryId: string | null;
  categoryLockedByUser: boolean;
};

/** ⭐ Every figure of one step, read through the routes. */
async function observe(): Promise<Observed & { _raw: Record<string, unknown> }> {
  const [spine, pos, sig, forecast, txns, items, ledger, balances, anchor, payoff, queue] = await Promise.all([
    get<Record<string, any>>("/spine"),
    get<Record<string, any>>("/money/position"),
    get<Record<string, any>>("/forecast/cash-signal"),
    get<Record<string, any>>("/forecast"),
    get<Txn[]>("/transactions"),
    get<Array<{ institutionName: string; accounts: Array<{ accountId: string; mask: string }> }>>("/plaid/items"),
    get<Record<string, any>>("/transactions/ledger?limit=100"),
    get<Record<string, any>>(`/transactions/balances?dates=${EOD_DATES.join(",")}`),
    get<Record<string, any>>("/amex/anchor"),
    get<Record<string, any>>("/amex/weekly-payoff?weekStart=2026-10-04"),
    get<{ total: number; items: Array<Record<string, any>> }>("/categorization/review?limit=50"),
  ]);
  // The client's account label: GET /transactions carries `plaidAccountId`;
  // the institution and mask come from GET /plaid/items.
  const label = new Map<string, string>();
  for (const it of items) for (const a of it.accounts) label.set(a.accountId, `${it.institutionName} ••${a.mask}`);
  const rows = txns
    .map((t) => ({
      date: t.occurredOn,
      text: [
        label.get(t.plaidAccountId ?? "") ?? `? ${String(t.source)}`,
        t.occurredOn,
        t.description,
        fmt(t.amount),
        t.pending ? "pending" : "posted",
        t.categoryId ? (catName.get(t.categoryId) ?? "?") : "—",
        t.categoryLockedByUser ? "locked" : "unlocked",
      ].join(" | "),
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.text.localeCompare(b.text))
    .map((r) => r.text);
  const card = (payoff.cards as Array<Record<string, any>>)[0];
  const descOf = new Map(txns.map((t) => [t.id, t.description]));
  const hookEvent = (e: Record<string, any>) => e.itemId === plan.weeklySpend;
  const events = ((sig.events ?? []) as Array<Record<string, any>>).filter((e) => e.date <= "2026-10-17");
  const dayBal = (d: string) => (sig.daily as Array<{ date: string; balance: string }>).find((x) => x.date === d)?.balance ?? null;
  return {
    rows,
    chase: {
      rows: (ledger.rows as Array<Record<string, any>>)
        .map((r) => ({ d: String(r.occurredOn), t: `${r.occurredOn} ${r.description} ${fmt(r.amount)} → ${fmt(r.runningBalance)}` }))
        .sort((a, b) => a.d.localeCompare(b.d))
        .map((r) => r.t),
      moneyIn: fmt(ledger.totals.moneyIn)!,
      moneyOut: fmt(ledger.totals.moneyOut)!,
      net: fmt(ledger.totals.net)!,
      balanceToday: fmt(ledger.balanceToday),
    },
    chaseEndOfDay: (balances.balances as Array<{ balance: string | null }>).map((b) => fmt(b.balance)),
    amex: {
      endingBalance: fmt(anchor.amexEndingBalance),
      source: String(anchor.source),
      weekCharges: fmt(card?.weekCharges ?? 0)!,
      chargeCount: Number(card?.chargeCount ?? 0),
      combinedWeekCharges: fmt(payoff.combinedWeekCharges)!,
    },
    spentWeek: fmt(spine.spentWeek)!,
    spentMonth: fmt(spine.spentMonth)!,
    cash: String(spine.bank.balance),
    reviewCount: Number(spine.reviewCount),
    debt: {
      payoffPct: spine.debt.payoffPct == null ? null : Number(spine.debt.payoffPct).toFixed(3),
      paidDownMtd: fmt(spine.debt.paidDownMtd)!,
      confirmedPaymentsMtd: fmt(spine.debt.confirmedPaymentsMtd)!,
      newChargesMtd: fmt(spine.debt.newChargesMtd)!,
      nextMilestone: spine.debt.nextMilestone ? `${spine.debt.nextMilestone.label} ${spine.debt.nextMilestone.estimatedMonth}` : null,
    },
    position: {
      remainingWeek: pos.remainingWeek,
      unplannedWeek: pos.unplannedWeek,
      needsClassificationWeek: pos.needsClassificationWeek,
      lowestUntilPayday: pos.lowestUntilPayday == null ? null : `${pos.lowestUntilPayday} @ ${pos.lowestUntilPaydayDate}`,
      availableUntilPayday: pos.availableUntilPayday,
      safeToSpendNow: pos.safeToSpendNow,
    },
    forecast: {
      hookEvents: events.filter(hookEvent).map((e) => `${e.date} ${fmt(e.amount)}`),
      otherExpenses: events.filter((e) => !hookEvent(e)).map((e) => `${e.date} ${e.label} ${fmt(e.amount)}`),
      curve: Object.fromEntries(["2026-10-10", "2026-10-12", "2026-10-16", "2026-10-17"].map((d) => [d, dayBal(d)])),
      assumedPaid: ((sig.overdueAssumedPaid ?? []) as Array<Record<string, any>>).map(
        (p) => `${p.label} ${p.occurrenceDate} plan ${fmt(p.planAmount)} ← ${descOf.get(p.txnId) ?? p.txnId} ${fmt(p.txnAmount)}`,
      ),
    },
    queue: queue.items
      .map((q) => `${q.description} | ${q.source} | ${q.band} | ${q.suggestedCategoryId ? (catName.get(q.suggestedCategoryId) ?? "?") : "—"}`)
      .sort(),
    _raw: { spine, pos, sig, forecast, txns, ledger, anchor, payoff, queue },
  };
}

/** Assert one step: the whole observed table, plus the parity every step owes. */
async function expectStep(id: StepId): Promise<Observed & { _raw: Record<string, unknown> }> {
  vi.setSystemTime(WHEN[id]);
  const o = await observe();
  const { _raw, ...observed } = o;
  // The contract, with each documented difference at the value the app reports today.
  expect(observed, `${id} — every figure`).toEqual(expectedToday(id));
  // The spine's position is GET /money/position's, to the cent.
  const spine = _raw.spine as Record<string, any>;
  const pos = _raw.pos as Record<string, any>;
  for (const k of ["safeToSpendNow", "remainingWeek", "availableUntilPayday"]) {
    expect(spine.position[k], `${id} spine.position.${k}`).toBe(pos[k]);
  }
  // The spine never carries a debt balance (CLAUDE.md §3, spine law).
  expect(Object.keys(spine.debt).sort(), `${id} spine.debt keys`).toEqual(
    ["confirmedPaymentsMtd", "newChargesMtd", "nextMilestone", "paidDownMtd", "payoffPct"],
  );
  // The Forecast page's curve is the cash-signal's, the same call.
  expect((_raw.forecast as Record<string, any>).cashSignal, `${id} /forecast cashSignal`).toEqual(_raw.sig);
  // The Chase page's "today" is the spine's bank balance.
  expect(o.chase.balanceToday, `${id} Chase register today = spine cash`).toBe(o.cash);
  return o;
}

async function cleanup(): Promise<void> {
  if (!HH) return;
  await db.delete(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, HH));
  await db.delete(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, HH));
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, HH));
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
  await db.delete(debtLedgerEventsTable).where(eq(debtLedgerEventsTable.householdId, HH));
  await db.delete(debtMilestonesTable).where(eq(debtMilestonesTable.householdId, HH));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, HH));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, HH));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, HH));
  await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, HH));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, OWNER));
  await db.delete(plaidSyncAttemptsTable).where(eq(plaidSyncAttemptsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  vi.setSystemTime(WHEN.S0);
  const owned = { userId: OWNER, householdId: HH };

  // ── The two institutions, each already linked and syncing (a cursor on file).
  const [chaseItem] = await db
    .insert(plaidItemsTable)
    .values({ ...owned, itemId: `b4-item-chase-${RUN}`, accessToken: item.chaseToken, institutionName: "Chase", institutionSlug: "chase", cursor: "seed-cursor" })
    .returning();
  const [amexItem] = await db
    .insert(plaidItemsTable)
    .values({ ...owned, itemId: `b4-item-amex-${RUN}`, accessToken: item.amexToken, institutionName: "American Express", institutionSlug: "amex", cursor: "seed-cursor" })
    .returning();
  item.chase = chaseItem!.id;
  item.amex = amexItem!.id;
  const linked = new Date("2026-01-01T00:00:00Z");
  const [chaseAcct] = await db
    .insert(plaidAccountsTable)
    .values({ ...owned, itemId: item.chase, accountId: acct("chase"), mask: ACCOUNTS.chase.mask, name: ACCOUNTS.chase.name, type: "depository", subtype: "checking", firstSyncCompletedAt: linked })
    .returning();
  await db
    .insert(plaidAccountsTable)
    .values({ ...owned, itemId: item.amex, accountId: acct("amex"), mask: ACCOUNTS.amex.mask, name: ACCOUNTS.amex.name, type: "credit", subtype: "credit card", firstSyncCompletedAt: linked });

  // ── The bank snapshot on the checking account.
  await db.insert(forecastSettingsTable).values({
    ...owned,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: SNAPSHOT.cashBuffer,
    bankSnapshotBalance: SNAPSHOT.balance,
    bankSnapshotAt: SNAPSHOT.at,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chaseAcct!.id,
    bankSnapshotMask: ACCOUNTS.chase.mask,
  });

  // ── Categories.
  for (const [key, name, kind] of [
    ["groceries", "Groceries", "expense"],
    ["travel", "Travel", "expense"],
    ["paycheck", "Paycheck", "income"],
  ] as const) {
    const [c] = await db.insert(budgetCategoriesTable).values({ ...owned, name, kind, groupName: "B4" }).returning();
    cat[key] = c!.id;
    catName.set(c!.id, name);
  }

  // ── One income plan, and the Weekly Spend bill the weekly hook replaces.
  for (const [key, name, kind, amount, frequency, anchorDate] of [
    ["paycheck", "Paycheck", "income", PAYCHECK.amount, "monthly", PAYCHECK.anchorDate],
    ["weeklySpend", "Weekly Spend", "bill", "300", "weekly", "2026-10-10"],
  ] as const) {
    const [p] = await db
      .insert(recurringItemsTable)
      .values({ ...owned, name, kind, amount, frequency, dayOfMonth: Number(anchorDate.slice(8, 10)), anchorDate, active: "true" })
      .returning();
    plan[key] = p!.id;
  }

  // ── The weekly cap, the hook (as 0042_everyday_hooks.sql writes it) and the Amex anchor.
  await db.insert(allowancePlansTable).values({
    householdId: HH,
    memberUserId: null,
    period: "weekly",
    amount: WEEKLY_CAP.amount,
    effectiveFrom: WEEKLY_CAP.effectiveFrom,
    source: "owner",
  });
  await db.insert(settingsTable).values({
    ...owned,
    preferences: {
      everydayHooks: { weekly: { recurringItemId: plan.weeklySpend }, monthly: null },
      amexAnchor: { balance: Number(AMEX_DEBT.balance), asOf: "2026-10-01T12:00:00.000Z", lastAutoBalance: Number(AMEX_DEBT.balance) },
    },
  });

  // ── The Amex card as a debt with an anchor (named, as POST /debts writes it).
  await db.insert(debtsTable).values({
    ...owned,
    name: AMEX_DEBT.name,
    balance: AMEX_DEBT.balance,
    originalBalance: AMEX_DEBT.originalBalance,
    apr: "0",
    minPayment: "0",
    payment: "0",
    type: "credit_card",
  });

  // ── The card's earlier history: the $500.00 the anchor holds (filed long ago).
  await db.insert(transactionsTable).values({
    ...owned,
    occurredOn: AMEX_HISTORY.date,
    description: AMEX_HISTORY.name,
    amount: AMEX_HISTORY.amount,
    categoryId: cat.travel,
    categoryLockedByUser: true,
    plaidAccountId: acct("amex"),
    plaidTransactionId: pid(AMEX_HISTORY.id),
    source: "plaid:amex",
    reviewed: true,
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

const rowOf = async (plaidId: string) =>
  (await db.select().from(transactionsTable).where(eq(transactionsTable.plaidTransactionId, pid(plaidId))))[0];

describe("B4 · Amex + checking — Sun 10/4 to Mon 10/12, 2026", () => {
  it("S0 · the household before any event", async () => {
    const o = await expectStep("S0");
    // The fields GET /transactions carries today for the client's account label.
    const t = (o._raw.txns as Txn[])[0]!;
    expect(Object.keys(t)).toEqual(expect.arrayContaining(["plaidAccountId", "source", "pending", "categoryLockedByUser"]));
    for (const absent of ["institutionName", "mask", "accountName"]) expect(t, `GET /transactions has no ${absent}`).not.toHaveProperty(absent);
  });

  it("S1 · Mon 10/5 — Amex: KROGER #442 $86.33, pending", async () => {
    vi.setSystemTime(WHEN.S1);
    await sync("amex", { added: [plaidRow(PLAID.amexPending)] });
    const row = await rowOf(PLAID.amexPending.id);
    expect(row).toMatchObject({ pending: true, amount: "-86.33", source: "plaid:amex", isTransfer: false, forecastFlag: false });
    amexPendingRowId = row!.id;
    await expectStep("S1");
  });

  it("S2 · Mon 10/5 — Chase: KROGER #442 $42.10, posted", async () => {
    vi.setSystemTime(WHEN.S2);
    await sync("chase", { added: [plaidRow(PLAID.chasePurchase)] });
    expect(await rowOf(PLAID.chasePurchase.id)).toMatchObject({ pending: false, amount: "-42.10", source: "plaid:chase", forecastFlag: true });
    await expectStep("S2");
  });

  it("S3a · Tue 10/6 — a person files the pending Amex charge as Groceries", async () => {
    vi.setSystemTime(WHEN.S3a);
    const res = await call<Record<string, unknown>>("PATCH", `/transactions/${amexPendingRowId}`, { categoryId: cat.groceries });
    expect(res).toMatchObject({ id: amexPendingRowId, categoryId: cat.groceries, categoryLockedByUser: true, categoryProvisional: false });
    await expectStep("S3a");
  });

  it("S3b · Wed 10/7 — the pending Amex charge posts (new id, pending_transaction_id)", async () => {
    vi.setSystemTime(WHEN.S3b);
    await sync("amex", {
      added: [plaidRow(PLAID.amexPosted, PLAID.amexPending.id)],
      removed: [{ transaction_id: pid(PLAID.amexPending.id) }],
    });
    // Re-keyed in place: the same row, the new id, the hand category and its lock kept.
    const posted = await rowOf(PLAID.amexPosted.id);
    expect(posted).toMatchObject({
      id: amexPendingRowId,
      pending: false,
      amount: "-86.33",
      occurredOn: "2026-10-06",
      categoryId: cat.groceries,
      categoryLockedByUser: true,
      categoryProvisional: false,
    });
    expect(await rowOf(PLAID.amexPending.id), "the pending id is gone").toBeUndefined();
    await expectStep("S3b");
  });

  it("S4 · Thu 10/8 — Amex: KROGER #442 REFUND $20.00", async () => {
    vi.setSystemTime(WHEN.S4);
    await sync("amex", { added: [plaidRow(PLAID.amexRefund)] });
    const refund = await rowOf(PLAID.amexRefund.id);
    // Not auto-filed as groceries.
    expect(refund).toMatchObject({ amount: "20.00", categoryId: null, categoryLockedByUser: false });
    await expectStep("S4");
  });

  it("S5 · Mon 10/12 — $100.00 from Chase to the Amex card", async () => {
    vi.setSystemTime(WHEN.S5);
    await sync("chase", { added: [plaidRow(PLAID.chasePayment)] });
    await sync("amex", { added: [plaidRow(PLAID.amexPayment)] });
    expect(await rowOf(PLAID.chasePayment.id)).toMatchObject({ amount: "-100.00", isTransfer: false, forecastFlag: true });
    expect(await rowOf(PLAID.amexPayment.id)).toMatchObject({ amount: "100.00", isTransfer: false });
    await expectStep("S5");
  });

  // ⚠️ The documented differences: the contract's value, waiting for the package that delivers it.
  for (const id of Object.keys(DIFFERENCE_TITLES) as Array<keyof typeof DIFFERENCE_TITLES>) {
    const where = (Object.entries(DIFFERENCES) as Array<[StepId, (typeof DIFFERENCES)[StepId]]>)
      .flatMap(([step, diffs]) =>
        diffs
          .filter((d) => d.id === id)
          .map((d) => `${step} ${d.path} ${JSON.stringify(contractValue(step, d.path))} (app ${JSON.stringify(d.today)})`),
      )
      .join(" · ");
    it.todo(`${id}: ${DIFFERENCE_TITLES[id]} — ${where}`);
  }
});
