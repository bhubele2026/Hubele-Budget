// ⭐ (C4) THE MONTHLY SPEND ROW'S WORDS TIE TO ITS AMOUNT — the `nov-gap` scenario.
//
// The owner saw a Monthly Spend row on Nov 1 whose words read "card purchases
// $0.00 + left to spend $X" over an amount that was not X. Three causes the code
// could produce, each built here from synthetic rows (no live figure):
//   (a) a PARTIAL answer: the curve took the plan less the row that paid part
//       of it, and the words printed the whole reserve;
//   (b) a MOVED occurrence (October's, moved to Nov 1): the register looked its
//       words up by the day it is shown on — November's reserve — not by its own
//       occurrence key;
//   (c) a part the words skipped: with no plan, "reserve $300" over a curve that
//       had already taken a payment off;
// and (d) the register row's own amount was the item's STORED amount.
//
// ⭐ (Task 4, D) Now: (d) the register row headlines the curve's figure (the web's
// own `buildLineRegister` + `hookCurveOf`, loaded below), and (a) a partial answer
// on a hook is read as NOT GIVEN by the ledger (`forecastLedger.ts`
// `isHookPartial`) and refused by `POST /forecast/resolutions`: its row is
// already in the balance and pays the card's purchases by evidence, once.
//   Before → after on household N (the hook's total is unchanged, −1,229.50: the
//   $85 payment, no longer claimed by the answer, pays September's purchases — the
//   oldest owed — by evidence instead of November's future reserve):
//     Sep 1 (due → 10/15)   −120.00 → −35.00
//     Nov 1 November's      −535.00 → −620.00
//   ⚠️ Household P is the guard's known limit: a partial on October's occurrence
//   naming the $45.50 allowance purchase from checking. The spending side (the
//   household money classifier, not changed here) still reads the stored answer
//   and leaves that row out of October's spending, and the ledger no longer takes
//   it off the reserve: the forecast reads $45.50 LOWER than with no answer —
//   never higher (the owner's rule: "may read low, never high").
//     Nov 1 October's (moved)   −574.50 → −620.00   (with the answer deleted: −574.50)
//
// Clock: Wed 2026-10-14 12:00 Central. Synthetic names, amounts, account numbers.
//
// Household N (nov-gap): Checking ••5150 (read 2,400.00 at 07:00 today), Amex Green
// ••6406 (monthly, no debt → paid in full). Monthly Spend: stored $400 on the 1st;
// a monthly plan of $620 from Sep 1.
//   Sep   card 9/10 TRAIL OUTFITTERS −120 (monthly)       → Sep 1: 120 owed, due → 10/15
//   Oct   card 10/06 CORNER BAKERY −75 (monthly)           → own 75
//         checking 10/08 CORNER BAKERY −45.50 (monthly)    → spent 120.50, left 499.50
//         Oct 1 MOVED to Nov 1                             → Nov 1: 75 + 499.50 = 574.50
//   Nov   nothing bought; left = the plan 620
//         answered PARTIAL with checking 10/13 AMEX EPAYMENT ACH PMT −85 → Nov 1: 620 − 85 = 535
// Household W (weekly, no plan): Checking ••5150, Amex Gold ••3311 (weekly, in full).
// Weekly Spend stored $300 on Saturdays, no weekly plan.
//   card 10/12 GREEN GROCER −90 (weekly); checking 10/13 AMERICAN EXPRESS ACH PMT −40
//   → Oct 17: own 90, paid 40, incurred 50, left 300 − 90 = 210 → 260 on the curve.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const HH: Record<string, { householdId: string; ownerUserId: string }> = {};
const owners: string[] = [];
const households: string[] = [];

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { headers: Record<string, string | string[] | undefined>; userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"]);
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
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { GetForecastCashSignalResponse } from "@workspace/api-zod";
import forecastRouter from "../routes/forecast";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-14T12:00:00-05:00");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(forecastRouter);
let server: Server;
let baseUrl = "";

async function get<T>(path: string, as: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": as } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

type Signal = {
  bankToday?: string | null;
  endingBalance?: string;
  daily?: Array<{ date: string; balance: string }>;
  matches?: Array<{ planKey: string; planItemId: string; txnId: string }>;
  events: Array<{ date: string; amount: string; itemId?: string; occurrenceKey?: string; occurrenceDate?: string; originalDate?: string }>;
  hookReserves?: Array<{ planKey: string; occurrenceDate: string; amount: string; basis: string; incurred?: string; paid?: string; carried?: string; allowanceLeft?: string; carriedTo?: string | null }>;
} & Record<string, unknown>;
type Bundle = {
  fromDate: string;
  toDate: string;
  events: Array<{ date: string; amount: number | string; itemId: string; label?: string }>;
  resolutions: Array<{ id?: string; recurringItemId: string | null; occurrenceDate: string | null; status: string; rescheduledTo: string | null; matchedTxnId: string | null }>;
  transactions: Array<{ id: string; description: string | null; amount: string | number }>;
};

/** The web's own words (the same module the Forecast register renders). Loaded by path: it is not part of this package. */
type HooksModule = {
  hookPayoffsOf: (s: unknown, d?: (id: string) => string | null) => Map<string, Record<string, unknown>>;
  hookLineOf: (m: Map<string, Record<string, unknown>>, row: { itemId: string; date: string; originalDate?: string }) => Record<string, unknown> | undefined;
  hookPayoffWords: (line: Record<string, unknown>, opts?: { face?: number | null }) => string;
  hookCurveOf: (s: unknown) => { items: ReadonlySet<string>; amountByKey: ReadonlyMap<string, number> } | null;
  itemAmountWords: (line: Record<string, unknown> | undefined, itemAmount: number) => string | null;
};
const loadWords = async (): Promise<HooksModule> => {
  const href = new URL("../../../h2budget/src/lib/forecastHooks.ts", import.meta.url).href;
  return (await import(/* @vite-ignore */ href)) as HooksModule;
};
/** (Task 4, D) The web's own register (`buildLineRegister`), by path like the words. */
type RegisterRow = { kind: string; itemId: string; date: string; originalDate?: string; amount: number; status: string; hookCurve?: { itemAmount: number; onCurve: boolean } };
type MatchModule = { buildLineRegister: (o: Record<string, unknown>) => { allPlan: RegisterRow[]; rows: RegisterRow[] } };
const loadRegister = async (): Promise<MatchModule> => {
  const href = new URL("../../../h2budget/src/lib/forecastMatch.ts", import.meta.url).href;
  return (await import(/* @vite-ignore */ href)) as MatchModule;
};

const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);

async function seedBase(tag: string, card: { name: string; mask: string; cadence: "weekly" | "monthly" }) {
  const owner = `c4-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const { householdId } = await createTestHousehold(owner);
  owners.push(owner);
  households.push(householdId);
  HH[owner] = { householdId, ownerUserId: owner };
  const base = { userId: owner, householdId };
  const ext = { checking: `c4-chk-${randomUUID()}`, card: `c4-card-${randomUUID()}` };
  const [bank, amex] = await db
    .insert(plaidItemsTable)
    .values([
      { ...base, itemId: `item-bank-${randomUUID()}`, accessToken: "t", institutionName: "Lakeside Bank", institutionSlug: "lakeside" },
      { ...base, itemId: `item-amex-${randomUUID()}`, accessToken: "t", institutionName: "American Express", institutionSlug: "amex" },
    ])
    .returning();
  const accts = await db
    .insert(plaidAccountsTable)
    .values([
      { ...base, itemId: bank!.id, accountId: ext.checking, name: "Everyday Checking", mask: "5150", type: "depository", subtype: "checking" },
      { ...base, itemId: amex!.id, accountId: ext.card, name: card.name, mask: card.mask, type: "credit", subtype: "credit card" },
    ])
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2400.00",
    bankSnapshotAt: new Date("2026-10-14T07:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: accts.find((a) => a.accountId === ext.checking)!.id,
    bankSnapshotMask: "5150",
  });
  const rows = async (list: Array<{ on: string; desc: string; amt: string; acct: "checking" | "card"; weekly?: boolean; monthly?: boolean }>) => {
    const out = await db
      .insert(transactionsTable)
      .values(
        list.map((r, i) => ({
          ...base,
          occurredOn: r.on,
          description: r.desc,
          amount: r.amt,
          plaidAccountId: ext[r.acct],
          source: r.acct === "checking" ? "plaid:lakeside" : "plaid:amex",
          plaidTransactionId: `c4-${tag}-${i}-${randomUUID().slice(0, 6)}`,
          forecastFlag: r.acct === "checking",
          weeklyAllowance: r.weekly ?? false,
          monthlyAllowance: r.monthly ?? false,
          createdAt: createdAtStartOfHouseholdDay(r.on),
        })),
      )
      .returning({ id: transactionsTable.id, description: transactionsTable.description });
    return out;
  };
  return { owner, base, ext, rows, cadence: { [ext.card]: card.cadence } };
}

let N: { owner: string; itemId: string; partialTxnId: string };
let W: { owner: string; itemId: string };
let P: { owner: string; itemId: string };
let M: { owner: string; weeklyId: string; monthlyId: string; gymId: string; exactRowId: string; gymRowId: string };

beforeAll(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW);

  // ── Household N: the Monthly Spend hook on the 1st (nov-gap).
  {
    const s = await seedBase("nov", { name: "Amex Green", mask: "6406", cadence: "monthly" });
    const [ms] = await db
      .insert(recurringItemsTable)
      .values({ ...s.base, name: "Monthly Spend", kind: "bill", amount: "400", frequency: "monthly", dayOfMonth: 1, anchorDate: "2026-09-01", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
      .returning();
    await db.insert(settingsTable).values({
      ...s.base,
      preferences: { everydayHooks: { weekly: null, monthly: { recurringItemId: ms!.id } }, amexCardCadence: s.cadence },
    });
    await db.insert(allowancePlansTable).values({ householdId: s.base.householdId, memberUserId: null, period: "monthly", amount: "620.00", effectiveFrom: "2026-09-01", source: "owner" });
    const t = await s.rows([
      { on: "2026-09-10", desc: "TRAIL OUTFITTERS", amt: "-120.00", acct: "card", monthly: true },
      { on: "2026-10-06", desc: "CORNER BAKERY", amt: "-75.00", acct: "card", monthly: true },
      { on: "2026-10-08", desc: "CORNER BAKERY", amt: "-45.50", acct: "checking", monthly: true },
      { on: "2026-10-13", desc: "AMEX EPAYMENT ACH PMT", amt: "-85.00", acct: "checking" },
    ]);
    const partialTxnId = t[3]!.id;
    await db.insert(forecastResolutionsTable).values([
      // (b) October's occurrence, moved by the household to Nov 1.
      { ...s.base, recurringItemId: ms!.id, occurrenceDate: "2026-10-01", status: "rescheduled", rescheduledTo: "2026-11-01" },
      // (a) November's own, answered "partial" with the $85 payment.
      { ...s.base, recurringItemId: ms!.id, occurrenceDate: "2026-11-01", status: "partial", matchedTxnId: partialTxnId },
    ]);
    N = { owner: s.owner, itemId: ms!.id, partialTxnId };
  }

  // ── Household W: the Weekly Spend hook with no weekly plan (c).
  {
    const s = await seedBase("wk", { name: "Amex Gold", mask: "3311", cadence: "weekly" });
    const [ws] = await db
      .insert(recurringItemsTable)
      .values({ ...s.base, name: "Weekly Spend", kind: "bill", amount: "300", frequency: "weekly", anchorDate: "2026-10-17", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
      .returning();
    await db.insert(settingsTable).values({
      ...s.base,
      preferences: { everydayHooks: { weekly: { recurringItemId: ws!.id }, monthly: null }, amexCardCadence: s.cadence },
    });
    await s.rows([
      { on: "2026-10-12", desc: "GREEN GROCER", amt: "-90.00", acct: "card", weekly: true },
      { on: "2026-10-13", desc: "AMERICAN EXPRESS ACH PMT", amt: "-40.00", acct: "checking" },
    ]);
    W = { owner: s.owner, itemId: ws!.id };
  }

  // ── Household P (Task 4): nov-gap's purchases, October moved to Nov 1, and a legacy partial on
  // October's own occurrence naming the $45.50 allowance purchase from checking — a row the
  // balance already holds and that already took $45.50 off October's left to spend.
  {
    const s = await seedBase("par", { name: "Amex Green", mask: "6406", cadence: "monthly" });
    const [ms] = await db
      .insert(recurringItemsTable)
      .values({ ...s.base, name: "Monthly Spend", kind: "bill", amount: "400", frequency: "monthly", dayOfMonth: 1, anchorDate: "2026-09-01", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") })
      .returning();
    await db.insert(settingsTable).values({
      ...s.base,
      preferences: { everydayHooks: { weekly: null, monthly: { recurringItemId: ms!.id } }, amexCardCadence: s.cadence },
    });
    await db.insert(allowancePlansTable).values({ householdId: s.base.householdId, memberUserId: null, period: "monthly", amount: "620.00", effectiveFrom: "2026-09-01", source: "owner" });
    const t = await s.rows([
      { on: "2026-09-10", desc: "TRAIL OUTFITTERS", amt: "-120.00", acct: "card", monthly: true },
      { on: "2026-10-06", desc: "CORNER BAKERY", amt: "-75.00", acct: "card", monthly: true },
      { on: "2026-10-08", desc: "CORNER BAKERY", amt: "-45.50", acct: "checking", monthly: true },
    ]);
    await db.insert(forecastResolutionsTable).values([
      { ...s.base, recurringItemId: ms!.id, occurrenceDate: "2026-10-01", status: "rescheduled", rescheduledTo: "2026-11-01" },
      { ...s.base, recurringItemId: ms!.id, occurrenceDate: "2026-10-01", status: "partial", matchedTxnId: t[2]!.id },
    ]);
    P = { owner: s.owner, itemId: ms!.id };
  }

  // ── Household M (Task 4): both hooks, a $45 gym bill on the 13th, and a checking row of the
  // Weekly Spend's exact figure — the matcher pairs the bill, never a hook.
  {
    const s = await seedBase("pin", { name: "Amex Gold", mask: "3311", cadence: "weekly" });
    const items = await db
      .insert(recurringItemsTable)
      .values([
        { ...s.base, name: "Weekly Spend", kind: "bill", amount: "300", frequency: "weekly", anchorDate: "2026-10-17", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") },
        { ...s.base, name: "Monthly Spend", kind: "bill", amount: "500", frequency: "monthly", dayOfMonth: 1, anchorDate: "2026-09-01", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") },
        { ...s.base, name: "Gym", kind: "bill", amount: "45", frequency: "monthly", dayOfMonth: 13, anchorDate: "2026-09-13", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") },
      ])
      .returning();
    const [ws, ms, gym] = items;
    await db.insert(settingsTable).values({
      ...s.base,
      preferences: { everydayHooks: { weekly: { recurringItemId: ws!.id }, monthly: { recurringItemId: ms!.id } }, amexCardCadence: s.cadence },
    });
    const t = await s.rows([
      { on: "2026-10-13", desc: "WEEKLY SPEND TRANSFER", amt: "-300.00", acct: "checking" },
      { on: "2026-10-13", desc: "GYM", amt: "-45.00", acct: "checking" },
    ]);
    M = { owner: s.owner, weeklyId: ws!.id, monthlyId: ms!.id, gymId: gym!.id, exactRowId: t[0]!.id, gymRowId: t[1]!.id };
  }

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  if (owners.length === 0) return;
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.userId, owners));
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, owners));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, owners));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, owners));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, owners));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, owners));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, owners));
  await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, households));
});

/**
 * ⭐ (Task 4, D) The register's rows for a hook item, built by the web's own
 * `buildLineRegister` from the bundle with the cash signal's figures
 * (`hookCurveOf`) — exactly as the Forecast page builds them.
 */
async function registerRows(bundle: Bundle, sig: Signal, itemId: string): Promise<RegisterRow[]> {
  const [{ buildLineRegister }, { hookCurveOf }] = await Promise.all([loadRegister(), loadWords()]);
  const register = buildLineRegister({
    events: bundle.events.map((e) => ({ ...e, amount: Number(e.amount) })),
    txns: [],
    resolutions: bundle.resolutions,
    closedMonths: new Set<string>(),
    startBalance: 0,
    fromISO: bundle.fromDate,
    toISO: bundle.toDate,
    today: new Date(2026, 9, 14),
    snapshotISO: "2026-10-14",
    matches: sig.matches ?? [],
    hookCurve: hookCurveOf(sig),
  });
  return register.allPlan.filter((p) => p.itemId === itemId);
}

describe("(C4) nov-gap — the Nov 1 Monthly Spend rows: amount and words agree to the cent", () => {
  it("⭐ (Task 4) the curve's hook events: October's (moved) 574.50; November's whole 620.00 — the legacy partial is read as not given; the $85 pays September by evidence", async () => {
    const sig = await get<Signal>("/forecast/cash-signal?horizonDays=30", N.owner);
    expect(() => GetForecastCashSignalResponse.parse(sig)).not.toThrow();
    const hook = sig.events.filter((e) => e.itemId === N.itemId).map((e) => `${e.date} ${e.amount} ${e.occurrenceKey!.split("|")[1]}`);
    expect(hook).toEqual([
      // September's purchases, less the $85 payment the evidence allocates to them: the next business day.
      "2026-10-15 -35.00 2026-09-01",
      "2026-11-01 -574.50 2026-10-01",
      "2026-11-01 -620.00 2026-11-01",
    ]);
    const r = (d: string) => sig.hookReserves!.find((x) => x.occurrenceDate === d)!;
    expect([r("2026-09-01").incurred, r("2026-09-01").paid]).toEqual(["35.00", "85.00"]);
    expect([r("2026-10-01").incurred, r("2026-10-01").carried, r("2026-10-01").allowanceLeft, r("2026-10-01").amount]).toEqual(["75.00", "0.00", "499.50", "574.50"]);
    expect([r("2026-11-01").incurred, r("2026-11-01").carried, r("2026-11-01").allowanceLeft, r("2026-11-01").amount]).toEqual(["0.00", "0.00", "620.00", "620.00"]);
    // ⭐ Every hook event = its own reserve's parts, by its OWN occurrence key — no partial taken off anywhere.
    for (const e of sig.events.filter((x) => x.itemId === N.itemId)) {
      const res = sig.hookReserves!.find((x) => x.planKey === e.occurrenceKey)!;
      expect(-cents(e.amount), e.occurrenceKey).toBe(cents(res.incurred) + cents(res.carried) + cents(res.allowanceLeft));
    }
  });

  it("⭐ (Task 4) the register's two Nov 1 rows headline the curve's figures and say what they hold; neither names the partial", async () => {
    const [sig, bundle, hooks] = await Promise.all([
      get<Signal>("/forecast/cash-signal?horizonDays=30", N.owner),
      get<Bundle>("/forecast?days=30", N.owner),
      loadWords(),
    ]);
    // The stored legacy answer is still there, untouched: the app reads it as not given.
    expect(bundle.resolutions.some((x) => x.status === "partial" && x.recurringItemId === N.itemId)).toBe(true);
    const rows = (await registerRows(bundle, sig, N.itemId)).filter((r) => r.date === "2026-11-01");
    expect(rows.map((r) => [r.originalDate ?? r.date, r.status, r.amount, r.hookCurve])).toEqual([
      ["2026-10-01", "future", -574.5, { itemAmount: -400, onCurve: true }],
      ["2026-11-01", "future", -620, { itemAmount: -400, onCurve: true }],
    ]);
    // ⭐ For every hook row, the headline is the curve's figure for its own occurrence.
    const all = await registerRows(bundle, sig, N.itemId);
    for (const row of all.filter((x) => x.hookCurve)) {
      const own = sig.events.filter((e) => e.occurrenceKey === `${N.itemId}|${row.originalDate ?? row.date}`).reduce((t, e) => t + cents(e.amount), 0);
      expect(Math.round(row.amount * 100), `${row.itemId}|${row.originalDate ?? row.date}`).toBe(own);
    }
    const lines = hooks.hookPayoffsOf(sig, (id) => bundle.transactions.find((t) => t.id === id)?.description ?? null);
    const words = rows.map((r) => hooks.hookPayoffWords(hooks.hookLineOf(lines, r)!, { face: Math.abs(r.amount) }));
    expect(words).toEqual([
      "October's Monthly Spend, due Nov 1: card purchases $75.00 + left to spend $499.50",
      "Monthly Spend: card purchases $0.00 + left to spend $620.00",
    ]);
    // The item's stored $400 is said once, behind the row's Details, as a template; the saved item is unchanged.
    expect(hooks.itemAmountWords(hooks.hookLineOf(lines, rows[1]!), rows[1]!.hookCurve!.itemAmount)).toBe(
      "Item amount $400 — a template; the forecast uses the monthly plan",
    );
    const [item] = await db.select({ amount: recurringItemsTable.amount }).from(recurringItemsTable).where(eq(recurringItemsTable.id, N.itemId));
    expect(item!.amount).toBe("400.00");
    expect(hooks.hookLineOf(lines, rows[0]!)!.planKey).toBe(`${N.itemId}|2026-10-01`);
  });
});

// ⭐ (Task 4, D) THE REGRESSION (nov-gap): a partial answer on a hook counts its row
// ONCE — in the balance, and as the card payment the evidence allocates — and never
// again off an occurrence's reserve.
describe("(Task 4) nov-gap: a legacy partial on a hook — its row counts once", () => {
  const shape = (x: Signal) => ({ bankToday: x.bankToday, endingBalance: x.endingBalance, daily: x.daily, events: x.events, hookReserves: x.hookReserves });
  /** The same household's signal with its stored partial deleted for the read, then put back as it was. */
  async function withoutThePartial(owner: string): Promise<Signal> {
    const [partial] = await db.select().from(forecastResolutionsTable).where(and(eq(forecastResolutionsTable.userId, owner), eq(forecastResolutionsTable.status, "partial")));
    expect(partial).toBeDefined();
    await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.id, partial!.id));
    try {
      return await get<Signal>("/forecast/cash-signal?horizonDays=30", owner);
    } finally {
      await db.insert(forecastResolutionsTable).values(partial!);
    }
  }

  it("⭐ the answer moves nothing: the curve, the reserves and the balance equal the same household's with the answer deleted", async () => {
    const withIt = await get<Signal>("/forecast/cash-signal?horizonDays=30", N.owner);
    expect(shape(withIt)).toEqual(shape(await withoutThePartial(N.owner)));
  });

  it("⭐ the $85 row: in Checking today once (the reading holds it), paying September's purchases once — never also off November's reserve", async () => {
    const sig = await get<Signal>("/forecast/cash-signal?horizonDays=30", N.owner);
    // The reading (07:00 on 10/14) holds the 10/13 row: Checking today is the reading, the row inside it once.
    expect(sig.bankToday).toBe("2400.00");
    const r = (d: string) => sig.hookReserves!.find((x) => x.occurrenceDate === d)!;
    // The evidence allocation pays the oldest owed purchases: $85 of September's $120.
    expect(r("2026-09-01").paid).toBe("85.00");
    expect([r("2026-10-01").paid, r("2026-11-01").paid]).toEqual(["0.00", "0.00"]);
    // November's event is its whole reserve: the row is not taken off it (before: −535.00).
    const nov = sig.events.find((e) => e.occurrenceKey === `${N.itemId}|2026-11-01`)!;
    expect(nov.amount).toBe("-620.00");
    // Σ the hook's curve = its purchases + what is left of each plan − the one $85 payment.
    const hook = sig.events.filter((e) => e.itemId === N.itemId);
    expect(hook.reduce((t, e) => t + cents(e.amount), 0)).toBe(-(12000 + 7500 + 49950 + 62000 - 8500));
  });

  it("⚠️ (the guard's limit, pinned) a partial naming an allowance purchase: the forecast reads lower than with no answer — never higher", async () => {
    const withIt = await get<Signal>("/forecast/cash-signal?horizonDays=30", P.owner);
    const without = await withoutThePartial(P.owner);
    const oct = (x: Signal) => x.events.find((e) => e.occurrenceKey === `${P.itemId}|2026-10-01`)!.amount;
    // The spending side still reads the stored answer (October's spent leaves the $45.50 out); the ledger no longer takes it off.
    expect([oct(withIt), oct(without)]).toEqual(["-620.00", "-574.50"]);
    // Never higher, on any day of the curve.
    for (const [i, d] of (withIt.daily ?? []).entries()) expect(cents(d.balance), d.date).toBeLessThanOrEqual(cents(without.daily![i]!.balance));
  });
});

// ⭐ (Task 4, D) THE WRITE IS CLOSED, AND NO SCREEN COULD SEND IT.
describe("(Task 4) POST /forecast/resolutions refuses a partial on a hook; the ledger never pairs one", () => {
  const post = (as: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/forecast/resolutions`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": as }, body: JSON.stringify(body) });

  it("partial on Weekly / Monthly Spend → 400 with the one-line reason; nothing written", async () => {
    const countOf = async () => (await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, M.owner))).length;
    const n = await countOf();
    for (const itemId of [M.weeklyId, M.monthlyId]) {
      const r = await post(M.owner, { status: "partial", recurringItemId: itemId, occurrenceDate: "2026-10-17", matchedTxnId: M.exactRowId });
      expect(r.status, itemId).toBe(400);
      expect(await r.json()).toEqual({ error: "Weekly and Monthly Spend are paid by card payments, not partial matches" });
    }
    expect(await countOf()).toBe(n);
  });

  it("a partial on a bill, and a match on a hook, are written as before", async () => {
    const bill = await post(M.owner, { status: "partial", recurringItemId: M.gymId, occurrenceDate: "2026-10-13", matchedTxnId: M.gymRowId });
    expect(bill.status).toBe(200);
    const matched = await post(M.owner, { status: "matched", recurringItemId: M.weeklyId, occurrenceDate: "2026-10-17", matchedTxnId: M.exactRowId });
    expect(matched.status).toBe(200);
    await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, M.owner));
  });

  it("⭐ the ledger never pairs a hook (forecastLedger: 'a hook is a date, not a bill'), even with a row of its exact figure — so the register never offers Partial on one", async () => {
    const sig = await get<Signal>("/forecast/cash-signal?horizonDays=30", M.owner);
    const weekly = sig.events.find((e) => e.occurrenceKey === `${M.weeklyId}|2026-10-17`)!;
    // The tempting row is the hook's figure to the cent.
    expect(weekly.amount).toBe("-300.00");
    expect((sig.matches ?? []).some((m) => m.planItemId === M.gymId)).toBe(true);
    expect((sig.matches ?? []).filter((m) => m.planItemId === M.weeklyId || m.planItemId === M.monthlyId)).toEqual([]);
  });
});

describe("(C4) no plan — the words name what the curve took off, never 'reserve $300' over $260", () => {
  it("Oct 17: the row reads $260 (the curve's) — card purchases $50 + left to spend $210 · $40 already paid", async () => {
    const [sig, bundle, hooks] = await Promise.all([
      get<Signal>("/forecast/cash-signal?horizonDays=30", W.owner),
      get<Bundle>("/forecast?days=30", W.owner),
      loadWords(),
    ]);
    const ev = sig.events.find((e) => e.itemId === W.itemId && e.occurrenceKey === `${W.itemId}|2026-10-17`)!;
    expect(ev.amount).toBe("-260.00");
    const res = sig.hookReserves!.find((x) => x.planKey === ev.occurrenceKey)!;
    expect([res.basis, res.incurred, res.paid, res.carried, res.allowanceLeft]).toEqual(["stored_amount", "50.00", "40.00", "0.00", "210.00"]);
    const rows = await registerRows(bundle, sig, W.itemId);
    const row = rows.find((r) => r.date === "2026-10-17")!;
    // (Task 4, D) The row headlines the curve's $260, never the stored $300.
    expect([row.amount, row.hookCurve]).toEqual([-260, { itemAmount: -300, onCurve: true }]);
    const line = hooks.hookLineOf(hooks.hookPayoffsOf(sig), row)!;
    expect(hooks.hookPayoffWords(line, { face: Math.abs(row.amount) })).toBe(
      "Weekly Spend reserve: card purchases $50.00 + left to spend $210.00 · $40.00 already paid · no weekly plan set",
    );
    // No plan: the item's amount IS the reserve — no template note.
    expect(hooks.itemAmountWords(line, row.hookCurve!.itemAmount)).toBeNull();
    // (C5) No plan for this week or later: the owner's way to one.
    expect(line.planLink).toBe("week");
    // A later week with nothing bought or paid keeps the short words.
    const next = rows.find((r) => r.date === "2026-10-24")!;
    expect(next.amount).toBe(-300);
    expect(hooks.hookPayoffWords(hooks.hookLineOf(hooks.hookPayoffsOf(sig), next)!, { face: Math.abs(next.amount) })).toBe("Assumed $300 · no weekly plan set");
  });
});
