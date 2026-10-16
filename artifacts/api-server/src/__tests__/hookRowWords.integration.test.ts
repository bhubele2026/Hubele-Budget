// ⭐ (C4) THE MONTHLY SPEND ROW'S WORDS TIE TO ITS AMOUNT — the `nov-gap` scenario.
//
// The owner saw a Monthly Spend row on Nov 1 whose words read "card purchases
// $0.00 + left to spend $X" over an amount that was not X. Three causes the code
// could produce, each built here from synthetic rows (no live figure):
//   (a) a PARTIAL answer: the curve takes the plan less the row that paid part
//       of it, and the words printed the whole reserve;
//   (b) a MOVED occurrence (October's, moved to Nov 1): the register looked its
//       words up by the day it is shown on — November's reserve — not by its own
//       occurrence key;
//   (c) a part the words skipped: with no plan, "reserve $300" over a curve that
//       had already taken a payment off;
// and (d) the register row's own amount is the item's STORED amount (WP8, the
// owner's open decision), not the curve's: the words now say what the forecast
// takes. The curve's AMOUNTS are right and are pinned here unchanged; only the
// words moved (`artifacts/h2budget/src/lib/forecastHooks.ts`).
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
import { inArray } from "drizzle-orm";

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
  events: Array<{ date: string; amount: string; itemId?: string; occurrenceKey?: string; occurrenceDate?: string; originalDate?: string }>;
  hookReserves?: Array<{ planKey: string; occurrenceDate: string; amount: string; basis: string; incurred?: string; paid?: string; carried?: string; allowanceLeft?: string; carriedTo?: string | null }>;
} & Record<string, unknown>;
type Bundle = {
  events: Array<{ date: string; amount: number | string; itemId: string }>;
  resolutions: Array<{ recurringItemId: string | null; occurrenceDate: string | null; status: string; rescheduledTo: string | null; matchedTxnId: string | null }>;
  transactions: Array<{ id: string; description: string | null; amount: string | number }>;
};

/** The web's own words (the same module the Forecast register renders). Loaded by path: it is not part of this package. */
type HooksModule = {
  hookPayoffsOf: (s: unknown, d?: (id: string) => string | null, plans?: unknown[]) => Map<string, Record<string, unknown>>;
  hookLineOf: (m: Map<string, Record<string, unknown>>, row: { itemId: string; date: string; originalDate?: string }) => Record<string, unknown> | undefined;
  hookPayoffWords: (line: Record<string, unknown>, opts?: { face?: number | null }) => string;
};
const loadWords = async (): Promise<HooksModule> => {
  const href = new URL("../../../h2budget/src/lib/forecastHooks.ts", import.meta.url).href;
  return (await import(/* @vite-ignore */ href)) as HooksModule;
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
 * The register's rows for a hook item, the way the page builds them from the
 * bundle (`buildLineRegister`): each occurrence at its stored amount, on its
 * moved-to day when moved; a partial keeps the plan less the paying row.
 */
function registerRows(bundle: Bundle, itemId: string) {
  const amountById = new Map(bundle.transactions.map((t) => [t.id, Number(t.amount)]));
  return bundle.events
    .filter((e) => e.itemId === itemId)
    .map((e) => {
      const moved = bundle.resolutions.find((r) => r.recurringItemId === itemId && r.occurrenceDate === e.date && r.status === "rescheduled");
      const partial = bundle.resolutions.find((r) => r.recurringItemId === itemId && r.occurrenceDate === e.date && r.status === "partial");
      const stored = Number(e.amount);
      const paidAmount = partial?.matchedTxnId ? (amountById.get(partial.matchedTxnId) ?? null) : null;
      const date = moved?.rescheduledTo ?? e.date;
      return {
        itemId,
        date,
        ...(date !== e.date ? { originalDate: e.date } : {}),
        status: partial ? "partial" : "future",
        stored,
        paidAmount,
        matchedTxnId: partial?.matchedTxnId ?? null,
        // What the row shows: the stored amount, or a partial's remainder of it.
        face: Math.abs(partial && paidAmount != null ? Math.round((stored - paidAmount) * 100) / 100 : stored),
      };
    });
}

describe("(C4) nov-gap — the Nov 1 Monthly Spend rows: amount and words agree to the cent", () => {
  it("the curve's Nov 1 events — unchanged amounts: October's (moved) 574.50, November's partial remainder 535.00", async () => {
    const sig = await get<Signal>("/forecast/cash-signal?horizonDays=30", N.owner);
    expect(() => GetForecastCashSignalResponse.parse(sig)).not.toThrow();
    const hook = sig.events.filter((e) => e.itemId === N.itemId).map((e) => `${e.date} ${e.amount} ${e.occurrenceKey!.split("|")[1]}`);
    expect(hook).toEqual([
      // September's purchases, owed: the next business day.
      "2026-10-15 -120.00 2026-09-01",
      "2026-11-01 -574.50 2026-10-01",
      "2026-11-01 -535.00 2026-11-01",
    ]);
    const r = (d: string) => sig.hookReserves!.find((x) => x.occurrenceDate === d)!;
    expect([r("2026-10-01").incurred, r("2026-10-01").carried, r("2026-10-01").allowanceLeft, r("2026-10-01").amount]).toEqual(["75.00", "0.00", "499.50", "574.50"]);
    expect([r("2026-11-01").incurred, r("2026-11-01").carried, r("2026-11-01").allowanceLeft, r("2026-11-01").amount]).toEqual(["0.00", "0.00", "620.00", "620.00"]);
    // ⭐ Every hook event = its own reserve's parts − a partial's row, by its OWN occurrence key.
    const paid = 8500;
    for (const e of sig.events.filter((x) => x.itemId === N.itemId)) {
      const res = sig.hookReserves!.find((x) => x.planKey === e.occurrenceKey)!;
      const parts = cents(res.incurred) + cents(res.carried) + cents(res.allowanceLeft);
      expect(-cents(e.amount), e.occurrenceKey).toBe(parts - (e.occurrenceKey!.endsWith("2026-11-01") ? paid : 0));
    }
  });

  it("⭐ the register's two Nov 1 rows say what they hold: October's by its own key and period; November's names the partial row", async () => {
    const [sig, bundle, hooks] = await Promise.all([
      get<Signal>("/forecast/cash-signal?horizonDays=30", N.owner),
      get<Bundle>("/forecast?days=30", N.owner),
      loadWords(),
    ]);
    const rows = registerRows(bundle, N.itemId).filter((r) => r.date === "2026-11-01");
    expect(rows.map((r) => [r.originalDate ?? r.date, r.status, r.face])).toEqual([
      ["2026-10-01", "future", 400],
      ["2026-11-01", "partial", 315],
    ]);
    const descOf = (id: string) => bundle.transactions.find((t) => t.id === id)?.description ?? null;
    const lines = hooks.hookPayoffsOf(sig, descOf, rows);
    const words = rows.map((r) => hooks.hookPayoffWords(hooks.hookLineOf(lines, r)!, { face: r.face }));
    expect(words).toEqual([
      "October's Monthly Spend, due Nov 1: card purchases $75.00 + left to spend $499.50 = $574.50 on the forecast (item amount $400 not used)",
      "Monthly Spend: card purchases $0.00 + left to spend $620.00 · $85.00 paid by AMEX EPAYMENT ACH PMT · $535.00 still owed (item amount $400 not used)",
    ]);
    // Before C4 both rows were read at "<item>|2026-11-01" and printed November's whole reserve
    // ("card purchases $0.00 + left to spend $620.00") over −$574.50 and −$535.00 on the curve.
    for (const r of rows) expect(lines.get(`${N.itemId}|${r.date}`)).toBeDefined();
    expect(hooks.hookLineOf(lines, rows[0]!)!.planKey).toBe(`${N.itemId}|2026-10-01`);
  });
});

describe("(C4) no plan — the words name what the curve took off, never 'reserve $300' over $260", () => {
  it("Oct 17: card purchases $50 + left to spend $210 = $260 on the forecast · $40 already paid", async () => {
    const [sig, bundle, hooks] = await Promise.all([
      get<Signal>("/forecast/cash-signal?horizonDays=30", W.owner),
      get<Bundle>("/forecast?days=30", W.owner),
      loadWords(),
    ]);
    const ev = sig.events.find((e) => e.itemId === W.itemId && e.occurrenceKey === `${W.itemId}|2026-10-17`)!;
    expect(ev.amount).toBe("-260.00");
    const res = sig.hookReserves!.find((x) => x.planKey === ev.occurrenceKey)!;
    expect([res.basis, res.incurred, res.paid, res.carried, res.allowanceLeft]).toEqual(["stored_amount", "50.00", "40.00", "0.00", "210.00"]);
    const row = registerRows(bundle, W.itemId).find((r) => r.date === "2026-10-17")!;
    expect(row.face).toBe(300);
    const line = hooks.hookLineOf(hooks.hookPayoffsOf(sig), row)!;
    expect(hooks.hookPayoffWords(line, { face: row.face })).toBe(
      "Weekly Spend reserve: card purchases $50.00 + left to spend $210.00 = $260.00 on the forecast · $40.00 already paid · no weekly plan set",
    );
    // (C5) No plan for this week or later: the owner's way to one.
    expect(line.planLink).toBe("week");
    // A later week with nothing bought or paid keeps the short words.
    const next = registerRows(bundle, W.itemId).find((r) => r.date === "2026-10-24")!;
    expect(hooks.hookPayoffWords(hooks.hookLineOf(hooks.hookPayoffsOf(sig), next)!, { face: next.face })).toBe("Weekly Spend reserve $300 · no weekly plan set");
  });
});
