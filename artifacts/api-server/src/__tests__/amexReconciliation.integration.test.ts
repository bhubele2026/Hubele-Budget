// ⭐ (Task 5) GET /amex/summary's `reconciliation`: every Amex purchase of the
// period in ONE group, and the groups add up to the purchases to the cent.
//
// A household seeded directly (no Plaid). Today: Mon 2026-10-19 12:00 Central.
// THE WEEK is Sun 10/11 – Sat 10/17 (a closed week, so an old pending charge has
// expired). Every name and amount is made up.
//
//   Chase Total Checking ••7001 — the forecast's account.
//   Amex "Platinum Card"      ••7101 — weekly (brand default), not a debt.
//   Amex "Blue Cash Everyday" ••7202 — monthly (brand default), not a debt.
//
// The week (signed as stored: − a charge, + a credit):
//   Platinum
//     PANTRY MART 12      −48.00  weekly, Groceries           → weekly_known
//     CORNER HARDWARE     −22.50  Home, no flag (not filed)   → weekly_known  [not_filed]
//     PAYLATER INC        −35.00  nothing; Plaid LOAN_PAYMENTS → weekly_unresolved [not_filed, no_category]
//     OFFICE DEPOT 9      −64.00  reimbursable, Office        → reimbursable
//     CONCERT TIX         −90.00  unplanned, Fun              → unplanned
//     STREAMFLIX          −15.99  matched to the Streaming bill → bills
//     FUEL STOP 7 pending −40.00  weekly, Gas, by hand — replaced by
//     FUEL STOP 7 posted  −40.00  (nothing; carries weekly + Gas) → weekly_known (once)
//     PRESENT SHOP 4 pending −25.00 Ignore, by hand — replaced by
//     PRESENT SHOP 4 posted  −25.00 (nothing; carries Ignore)     → not_counted
//     HOTEL HOLD pending −100.00  10/11, never posted: an expired hold → nowhere
//     BALANCE TRANSFER    −50.00  transfer                    → otherCharges, no group
//     AIRPORT LOUNGE      −75.00  nothing, marked "not mine"   → notMine, no group
//     PANTRY MART 12      +12.00  Groceries (a refund)         → refunds, no group
//     ONLINE PAYMENT - THANK YOU +200.00                       → payments, no group
//   Blue
//     BOOK NOOK           −30.00  monthly, Books               → monthly_known
//     GARDEN CENTER       −18.00  monthly, Home, pending (3 days) → monthly_known [pending]
//   Chase
//     CITY MARKET         −20.00  weekly, Groceries (checking: the household week, not Amex)
//
//   purchases 388.49 / 10 = weekly_known 110.50/3 + weekly_unresolved 35.00/1
//     + monthly_known 48.00/2 + bills 15.99/1 + unplanned 90.00/1
//     + reimbursable 64.00/1 + not_counted 25.00/1 (monthly_unresolved, no_bucket 0)
//   refunds 12.00/1 beside; net 376.49.
//   householdContribution (the window: refunds netted, "not mine" read):
//     weeklyPlan 48 + 22.50 + 35 + 40 + 75 − 12 = 208.50; unresolved 35.00 →
//     weeklyKnown 173.50 = weekly_known 110.50 + AIRPORT LOUNGE 75.00 − refund 12.00
//     monthlyKnown 48.00 = monthly_known; monthlyUnresolved 0.00; weeklyUnresolved 35.00.
//
// THE WEEK BEFORE (Sun 10/4 – Sat 10/10), Platinum, purchases only:
//     MAPLE BAKERY −20.00 weekly · RIVER CAFE −15.00 not filed · PAYLATER INC
//     −9.00 (LOAN_PAYMENTS) · CANDLE SHOP −11.00 monthly
//   → every plan group = its householdContribution figure, to the cent.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const OWNER = `t5-recon-${tag}`;
const HH: { householdId: string; ownerUserId: string } = { householdId: "", ownerUserId: "" };

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HH.householdId;
    req.householdOwnerId = HH.ownerUserId;
    next();
  },
}));

import {
  db,
  allowancePlansTable,
  budgetCategoriesTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { GetAmexSummaryResponse } from "@workspace/api-zod";
import amexRouter from "../routes/amex";
import moneyRouter from "../routes/money";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { findSupersededPendingForRange } from "../lib/supersededPending";

const NOW = new Date("2026-10-19T12:00:00-05:00");
const WEEK = { from: "2026-10-11", to: "2026-10-17" } as const;
const PREV = { from: "2026-10-04", to: "2026-10-10" } as const;

const ACCOUNTS = {
  chase: { accountId: `t5-chase-7001-${tag}`, mask: "7001", name: "Total Checking", slug: "chase", type: "depository", subtype: "checking" },
  plat: { accountId: `t5-amex-plat-7101-${tag}`, mask: "7101", name: "Platinum Card", slug: "amex", type: "credit", subtype: "credit card" },
  blue: { accountId: `t5-amex-blue-7202-${tag}`, mask: "7202", name: "Blue Cash Everyday", slug: "amex", type: "credit", subtype: "credit card" },
} as const;
type AccountKey = keyof typeof ACCOUNTS;

const CATEGORIES = ["Groceries", "Home", "Office", "Fun", "Subscriptions", "Gas", "Ignore", "Books"] as const;
type Cat = (typeof CATEGORIES)[number];

type Row = {
  key: string;
  account: AccountKey;
  on: string;
  desc: string;
  amount: string;
  category?: Cat;
  weekly?: boolean;
  monthly?: boolean;
  unplanned?: boolean;
  reimbursable?: boolean;
  transfer?: boolean;
  pending?: boolean;
  byHand?: boolean;
  pfc?: string;
};

// A pending row is created before the posted row that replaces it (created_at = the start of its own day).
const ROWS: readonly Row[] = [
  { key: "pantry", account: "plat", on: "2026-10-12", desc: "PANTRY MART 12", amount: "-48.00", category: "Groceries", weekly: true },
  { key: "hardware", account: "plat", on: "2026-10-12", desc: "CORNER HARDWARE", amount: "-22.50", category: "Home" },
  { key: "paylater", account: "plat", on: "2026-10-13", desc: "PAYLATER INC", amount: "-35.00", pfc: "LOAN_PAYMENTS_OTHER_PAYMENT" },
  { key: "office", account: "plat", on: "2026-10-13", desc: "OFFICE DEPOT 9", amount: "-64.00", category: "Office", reimbursable: true },
  { key: "concert", account: "plat", on: "2026-10-14", desc: "CONCERT TIX", amount: "-90.00", category: "Fun", unplanned: true },
  { key: "stream", account: "plat", on: "2026-10-14", desc: "STREAMFLIX", amount: "-15.99", category: "Subscriptions" },
  { key: "fuelPending", account: "plat", on: "2026-10-15", desc: "FUEL STOP 7", amount: "-40.00", category: "Gas", weekly: true, pending: true, byHand: true },
  { key: "fuelPosted", account: "plat", on: "2026-10-16", desc: "FUEL STOP 7", amount: "-40.00" },
  { key: "giftPending", account: "plat", on: "2026-10-12", desc: "PRESENT SHOP 4", amount: "-25.00", category: "Ignore", pending: true, byHand: true },
  { key: "giftPosted", account: "plat", on: "2026-10-13", desc: "PRESENT SHOP 4", amount: "-25.00" },
  { key: "hold", account: "plat", on: "2026-10-11", desc: "HOTEL HOLD", amount: "-100.00", pending: true },
  { key: "transfer", account: "plat", on: "2026-10-14", desc: "BALANCE TRANSFER", amount: "-50.00", transfer: true },
  { key: "notMine", account: "plat", on: "2026-10-16", desc: "AIRPORT LOUNGE", amount: "-75.00" },
  { key: "refund", account: "plat", on: "2026-10-15", desc: "PANTRY MART 12", amount: "12.00", category: "Groceries" },
  { key: "payment", account: "plat", on: "2026-10-16", desc: "ONLINE PAYMENT - THANK YOU", amount: "200.00", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
  { key: "book", account: "blue", on: "2026-10-12", desc: "BOOK NOOK", amount: "-30.00", category: "Books", monthly: true },
  { key: "garden", account: "blue", on: "2026-10-16", desc: "GARDEN CENTER", amount: "-18.00", category: "Home", monthly: true, pending: true },
  { key: "cityMarket", account: "chase", on: "2026-10-13", desc: "CITY MARKET", amount: "-20.00", category: "Groceries", weekly: true },
  // The week before: purchases only.
  { key: "bakery", account: "plat", on: "2026-10-05", desc: "MAPLE BAKERY", amount: "-20.00", category: "Groceries", weekly: true },
  { key: "cafe", account: "plat", on: "2026-10-06", desc: "RIVER CAFE", amount: "-15.00", category: "Fun" },
  { key: "paylater2", account: "plat", on: "2026-10-07", desc: "PAYLATER INC", amount: "-9.00", pfc: "LOAN_PAYMENTS_OTHER_PAYMENT" },
  { key: "candle", account: "plat", on: "2026-10-08", desc: "CANDLE SHOP", amount: "-11.00", category: "Home", monthly: true },
];

/** The hand-worked table (the header). "amount/count". */
const EXPECTED_WEEK = {
  weekly_known: "110.50/3",
  weekly_unresolved: "35.00/1",
  monthly_known: "48.00/2",
  monthly_unresolved: "0.00/0",
  bills: "15.99/1",
  unplanned: "90.00/1",
  reimbursable: "64.00/1",
  not_counted: "25.00/1",
  no_bucket: "0.00/0",
} as const;
const MEMBERS: Record<keyof typeof EXPECTED_WEEK, string[]> = {
  weekly_known: ["pantry", "hardware", "fuelPosted"],
  weekly_unresolved: ["paylater"],
  monthly_known: ["book", "garden"],
  monthly_unresolved: [],
  bills: ["stream"],
  unplanned: ["concert"],
  reimbursable: ["office"],
  not_counted: ["giftPosted"],
  no_bucket: [],
};

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
const ext: Record<string, string> = {};
const rowId: Record<string, string> = {};
const ids: Record<string, string> = {};
const keyOf = new Map<string, string>();

async function get<T = any>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  const body = await r.json();
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body as T;
}
const summary = (accountId: string, p: { from: string; to: string } = WEEK, extra = "") =>
  get(`/amex/summary?accountId=${accountId}&from=${p.from}&to=${p.to}${extra}`);
const cents = (v: string | number) => Math.round(Number(v) * 100);
const ac = (t: { amount: string; count: number }) => `${t.amount}/${t.count}`;
const table = (s: any) => Object.fromEntries((s.reconciliation.groups as any[]).map((g) => [g.key, ac(g)]));
const group = (s: any, key: string) => (s.reconciliation.groups as any[]).find((g) => g.key === key)!;
const PLAN_KEYS = [
  ["weekly_known", "weeklyKnown"],
  ["weekly_unresolved", "weeklyUnresolved"],
  ["monthly_known", "monthlyKnown"],
  ["monthly_unresolved", "monthlyUnresolved"],
] as const;

async function cleanup(): Promise<void> {
  if (HH.householdId) {
    await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.householdId, [HH.householdId]));
    await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, [HH.householdId]));
  }
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, [OWNER]));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, [OWNER]));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, [OWNER]));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, [OWNER]));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, [OWNER]));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, [OWNER]));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, [OWNER]));
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  Object.assign(HH, await createTestHousehold(OWNER));
  await cleanup();
  const owned = { userId: OWNER, householdId: HH.householdId };

  const items: Record<string, string> = {};
  for (const [slug, name] of [["chase", "Chase"], ["amex", "American Express"]] as const) {
    const [it] = await db
      .insert(plaidItemsTable)
      .values({ ...owned, itemId: `t5-item-${slug}-${tag}`, accessToken: "t", institutionSlug: slug, institutionName: name })
      .returning();
    items[slug] = it!.id;
  }
  for (const [key, a] of Object.entries(ACCOUNTS) as Array<[AccountKey, (typeof ACCOUNTS)[AccountKey]]>) {
    ext[key] = a.accountId;
    const [row] = await db
      .insert(plaidAccountsTable)
      .values({ ...owned, itemId: items[a.slug]!, accountId: a.accountId, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })
      .returning();
    rowId[key] = row!.id;
  }
  await db.insert(forecastSettingsTable).values({
    ...owned,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "2500.00",
    bankSnapshotAt: new Date("2026-10-18T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: rowId.chase!,
  });
  const cat: Record<string, string> = {};
  for (const n of CATEGORIES) {
    const [c] = await db.insert(budgetCategoriesTable).values({ ...owned, name: n, kind: "expense", groupName: "T5" }).returning();
    cat[n] = c!.id;
  }
  await db.insert(allowancePlansTable).values({ householdId: HH.householdId, memberUserId: null, period: "weekly", amount: "500.00", effectiveFrom: "2026-05-01", source: "owner" });
  const [bill] = await db
    .insert(recurringItemsTable)
    .values({ ...owned, name: "Streaming", kind: "bill", amount: "15.99", frequency: "monthly", dayOfMonth: 14, anchorDate: "2026-10-14", active: "true" })
    .returning();

  for (const r of ROWS) {
    const [t] = await db
      .insert(transactionsTable)
      .values({
        ...owned,
        occurredOn: r.on,
        createdAt: createdAtStartOfHouseholdDay(r.on),
        description: r.desc,
        amount: r.amount,
        plaidAccountId: ext[r.account]!,
        plaidTransactionId: `t5-${r.key}-${tag}`,
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
    keyOf.set(t!.id, r.key);
  }
  // The household confirmed STREAMFLIX as the Streaming bill.
  await db.insert(forecastResolutionsTable).values({ ...owned, recurringItemId: bill!.id, occurrenceDate: "2026-10-14", status: "matched", matchedTxnId: ids.stream! });
  await db.insert(settingsTable).values({ ...owned, preferences: { amexExcludedTxnIds: [ids.notMine] } });

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

describe("(Task 5) GET /amex/summary · reconciliation — the purpose-built week", () => {
  it("the fixture means what it says: the two pending rows are replaced, the hotel hold has expired", async () => {
    const out = await findSupersededPendingForRange(HH.householdId, WEEK.from, WEEK.to);
    expect([out.replacedIds.has(ids.fuelPending!), out.replacedIds.has(ids.giftPending!)]).toEqual([true, true]);
    expect([out.expiredIds.has(ids.hold!), out.expiredIds.has(ids.garden!), out.replacedIds.has(ids.garden!)]).toEqual([true, false, false]);
  });

  it("⭐ every card: each group, worked by hand; Σ groups = purchases to the cent; refunds beside; the schema", async () => {
    const s = await summary("all");
    expect(GetAmexSummaryResponse.safeParse(s).success, JSON.stringify(GetAmexSummaryResponse.safeParse(s).error?.issues?.slice(0, 3))).toBe(true);
    expect(table(s)).toEqual(EXPECTED_WEEK);
    expect((s.reconciliation.groups as any[]).map((g) => g.label)).toEqual([
      "This week's plan",
      "This week's plan, awaiting a decision",
      "Monthly allowance",
      "Monthly allowance, awaiting a decision",
      "Bills",
      "Unplanned",
      "Reimbursable",
      "Not counted",
      "Not placed",
    ]);
    // The partition is of the summary's own purchases: the Amex tile's and the Amex page's figure.
    expect(ac(s.purchases)).toBe("388.49/10");
    expect(s.reconciliation.purchases).toEqual({ amount: s.purchases.amount, count: s.purchases.count });
    const groups = s.reconciliation.groups as any[];
    expect(groups.reduce((a, g) => a + cents(g.amount), 0)).toBe(cents(s.purchases.amount));
    expect(groups.reduce((a, g) => a + g.count, 0)).toBe(s.purchases.count);
    expect(s.reconciliation.ties).toBe(true);
    // Refunds: beside, and the same tally as the top level.
    expect([ac(s.refunds), ac(s.reconciliation.refunds), s.reconciliation.net]).toEqual(["12.00/1", "12.00/1", "376.49"]);
    expect(ac(s.reconciliation.unresolved)).toBe("35.00/1");
    // The other buckets, unchanged by the partition.
    expect([ac(s.payments), ac(s.otherCharges), ac(s.notMine), ac(s.purchases.reimbursable)]).toEqual(["200.00/1", "50.00/1", "75.00/1", "64.00/1"]);
  });

  it("each group lists exactly its purchases; transfer, payment, refund, replaced pending, expired hold and not mine are in no group; the posted fuel row once", async () => {
    const s = await summary("all", WEEK, "&rowsPerGroup=50");
    const listed: Record<string, string[]> = {};
    for (const g of s.reconciliation.groups as any[]) {
      expect(g.truncated, g.key).toBe(false);
      listed[g.key] = (g.rows as any[]).map((r) => keyOf.get(r.id)!).sort();
    }
    expect(listed).toEqual(Object.fromEntries(Object.entries(MEMBERS).map(([k, v]) => [k, [...v].sort()])));
    const all = Object.values(listed).flat();
    for (const k of ["transfer", "payment", "refund", "fuelPending", "giftPending", "hold", "notMine", "cityMarket"]) expect(all, k).not.toContain(k);
    expect(all.filter((k) => k === "fuelPosted")).toHaveLength(1);
  });

  it("rows say their card, and their notes: not filed yet, no category, pending", async () => {
    const s = await summary("all", WEEK, "&rowsPerGroup=50");
    const rows = new Map((s.reconciliation.groups as any[]).flatMap((g) => g.rows as any[]).map((r) => [keyOf.get(r.id)!, r]));
    expect(rows.get("hardware")!.notes).toEqual(["not_filed"]);
    expect(rows.get("paylater")!.notes).toEqual(["not_filed", "no_category"]);
    expect(rows.get("garden")!.notes).toEqual(["pending"]);
    expect(rows.get("garden")!.pending).toBe(true);
    // The posted rows carry their pending row's filing: no note.
    expect([rows.get("fuelPosted")!.notes, rows.get("giftPosted")!.notes]).toEqual([[], []]);
    expect(rows.get("pantry")!).toMatchObject({ date: "2026-10-12", displayName: expect.any(String), amount: "48.00", pending: false, notes: [] });
    expect(rows.get("pantry")!.card).toEqual({ accountId: ext.plat, name: "Platinum", mask: "7101" });
    expect(rows.get("book")!.card).toMatchObject({ accountId: ext.blue, mask: "7202" });
  });

  it("⭐ against householdContribution: three of four plan figures equal; weekly_known differs by exactly the two non-purchase rows the weekly plan holds", async () => {
    const s = await summary("all");
    const hc = s.householdContribution;
    expect([hc.weeklyPlan, hc.weeklyKnown, hc.weeklyUnresolved, hc.monthlyPlan, hc.monthlyKnown, hc.monthlyUnresolved]).toEqual(["208.50", "173.50", "35.00", "48.00", "48.00", "0.00"]);
    expect(group(s, "weekly_unresolved").amount).toBe(hc.weeklyUnresolved);
    expect(group(s, "monthly_known").amount).toBe(hc.monthlyKnown);
    expect(group(s, "monthly_unresolved").amount).toBe(hc.monthlyUnresolved);
    // Find the rows: the weekly plan's own rows on the Platinum (the period breakdown, account scope) that are no purchase.
    const b = await get(`/money/period-breakdown?period=week&start=${WEEK.from}&account=${rowId.plat}&rowsPerGroup=50`);
    expect([b.actual, b.known, b.unresolved.amount]).toEqual([hc.weeklyPlan, hc.weeklyKnown, hc.weeklyUnresolved]);
    const inPlan = [...(b.categories as any[]).flatMap((c) => c.rows as any[]), ...(b.needsClassification.rows as any[])];
    const purchaseIds = new Set((s.reconciliation.groups as any[]).flatMap((g) => g.rows as any[]).map((r) => r.id));
    const extra = [...new Map(inPlan.filter((r) => !purchaseIds.has(r.id)).map((r) => [r.id, r])).values()];
    expect(extra.map((r) => keyOf.get(r.id)).sort()).toEqual(["notMine", "refund"]);
    // "Not mine" (+75.00, the payoff leaves it out; the household window reads it) and the refund (−12.00, B6 netting).
    expect(cents(hc.weeklyKnown) - cents(group(s, "weekly_known").amount)).toBe(7500 - 1200);
  });

  it("⭐ a week that holds only purchases: all four plan groups = householdContribution, to the cent (each card and every card)", async () => {
    for (const scope of ["all", ext.plat!, ext.blue!]) {
      const s = await summary(scope, PREV);
      expect(s.reconciliation.ties, scope).toBe(true);
      for (const [g, f] of PLAN_KEYS) expect(group(s, g).amount, `${scope} ${g}`).toBe(s.householdContribution[f]);
    }
    const s = await summary("all", PREV);
    expect(table(s)).toMatchObject({ weekly_known: "35.00/2", weekly_unresolved: "9.00/1", monthly_known: "11.00/1", monthly_unresolved: "0.00/0" });
    // The Blue card this week: only its two monthly purchases.
    const blue = await summary(ext.blue!);
    for (const [g, f] of PLAN_KEYS) expect(group(blue, g).amount, `blue ${g}`).toBe(blue.householdContribution[f]);
    expect(ac(group(blue, "monthly_known"))).toBe("48.00/2");
  });

  it("the month: Σ groups = purchases; monthly_known = monthlyKnown", async () => {
    const s = await summary("all", { from: "2026-10-01", to: "2026-10-19" });
    expect(s.reconciliation.ties).toBe(true);
    expect((s.reconciliation.groups as any[]).reduce((a, g) => a + cents(g.amount), 0)).toBe(cents(s.purchases.amount));
    expect([group(s, "monthly_known").amount, s.householdContribution.monthlyKnown]).toEqual(["59.00", "59.00"]);
  });

  it("rowsPerGroup bounds each group's rows, largest first; the amount and count still cover every row", async () => {
    const s = await summary("all", WEEK, "&rowsPerGroup=1");
    const g = group(s, "weekly_known");
    expect([g.amount, g.count, g.rows.length, g.truncated]).toEqual(["110.50", 3, 1, true]);
    expect(keyOf.get(g.rows[0].id)).toBe("pantry");
    expect(s.reconciliation.ties).toBe(true);
  });

  it("the household week's Counts toward plan (checking too) can exceed the Amex weekly_known: it is the plan's, not the cards'", async () => {
    const [s, b] = await Promise.all([summary("all"), get(`/money/period-breakdown?period=week&start=${WEEK.from}`)]);
    // Household known = the cards' weeklyKnown + CITY MARKET on checking.
    expect(cents(b.known)).toBe(cents(s.householdContribution.weeklyKnown) + 2000);
    expect(cents(b.known)).toBeGreaterThan(cents(group(s, "weekly_known").amount));
  });
});
