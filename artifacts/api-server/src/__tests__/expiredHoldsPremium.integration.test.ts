// ⭐ (F6 ⇄ premium merge) EVERY PREMIUM READER HONOURS AN EXPIRED HOLD.
//
// The owner's rule (2026-10-15): a row still pending more than 7 days after its
// date counts nowhere; its reversal credit (up to 31 days later) goes with it;
// computed at read time; nothing deleted; the row stays visible with its label.
// Kill switch EXPIRED_HOLDS_RULE=off = the behaviour before the rule.
//
// The readers the F6 line never saw (Q1 week contract, history / usual, Banking
// review in/out per bucket, inbox and outcome, bank confidence; Q2 proposals,
// dry run, apply, undo; Q5/Q6 Amex summary and Afford) read through the same
// answer (`supersededPending`: expiredIds / countsNowhere / notCountedIdsOf).
//
// THE PROOF: two synthetic households, seeded the same, except that HOLDS also
// carries six expired holds (two with their reversals, one answered for a bill).
// With the rule on, every premium figure of HOLDS equals CONTROL's (the holds
// count nowhere). With the kill switch, HOLDS reads its old figures — stated
// below, so each check is shown to bite. Every name and amount is made up.
//
// Clock: Thu 2026-10-15 12:00 Central; the week is Sun 10/11 – Sat 10/17; a row
// dated 10/07 or before is more than 7 days old. Weekly plan 300, monthly 400.
// Checking ••5526 (the forecast's): 2,000.00 read Thu 10/01 08:00 Central.
//
//   both   checking 09/29 SOME TAVERN 0042     −40.00  posted   Dining, weekly (the usual's one prior week)
//   both   checking 10/09 ACME CORP PAYROLL  +1,500.00  posted
//   both   checking 10/12 SOME TAVERN 0042     −30.00  posted   Dining, weekly (this week, known)
//   both   checking 10/13 PEAR GS SAVINGS      −20.00  pending  Subscriptions, Plaid "transfer out" → a transfer proposal
//   both   checking 10/14 CORNER CAFE          −12.00  pending  this week
//   both   card     10/10 BOOKSHOP             −25.00  posted
//   both   card     10/13 LUNCH SPOT           −40.00  posted   Dining, weekly
//   HOLDS  checking 10/02 CITY WATER AUTOPAY  −100.00  pending  never posted; answered "matched" for City Water 10/02
//   HOLDS  checking 10/05 SOME TAVERN 0042     −64.18  pending  Dining, weekly — never posted
//   HOLDS  checking 10/13 SOME TAVERN 0042     +64.18  pending  Dining, weekly — its reversal (2 days old)
//   HOLDS  checking 10/03 PEAR GS SAVINGS      −20.00  pending  Subscriptions, "transfer out"
//   HOLDS  card     10/02 PARKING GARAGE        −30.00  pending  no category
//   HOLDS  card     10/05 HARBOR HOTEL HOLD     −80.00  pending  Dining, weekly
//   HOLDS  card     10/13 HARBOR HOTEL          +80.00  pending  Dining, weekly — its reversal (a card credit: base netted it this week)
//   HOLDS  card     10/04 HOME GOODS            −45.00  pending  Home, monthly
//
// Last: a hold the snapshot held (09/30 −80.00) and its reversal (10/08 +80.00) —
// counted in the money (net 0, the reversal is money back), not "pending".
//
// Bills (both): City Water 100.00 monthly on the 2nd.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const HOLDS = `f6prem-h-${tag}`;
const CONTROL = `f6prem-c-${tag}`;
type Hh = { householdId: string; ownerUserId: string };
const HH: Record<string, Hh> = {};
const as = { owner: HOLDS };

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const h = HH[as.owner]!;
    req.userId = h.ownerUserId;
    req.actualUserId = h.ownerUserId;
    req.householdId = h.householdId;
    req.householdOwnerId = h.ownerUserId;
    next();
  },
}));
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => {
      throw new Error("no Plaid calls in this test");
    },
  };
});

import {
  db,
  allowancePlansTable,
  budgetCategoriesTable,
  categoryDecisionsTable,
  correctionApplicationsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  merchantMemoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import moneyRouter from "../routes/money";
import bankingRouter from "../routes/banking";
import budgetRouter from "../routes/budget";
import spineRouter from "../routes/spine";
import amexRouter from "../routes/amex";
import reviewProposalsRouter from "../routes/reviewProposals";
import transactionsRouter from "../routes/transactions";
import { findSupersededPending } from "../lib/supersededPending";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-15T12:00:00-05:00");
const WEEK = "2026-10-11";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
for (const r of [moneyRouter, bankingRouter, budgetRouter, spineRouter, amexRouter, reviewProposalsRouter, transactionsRouter]) app.use(r);

let server: Server;
let baseUrl: string;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
async function get(path: string): Promise<Json> {
  const r = await call("GET", path);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
/** Read as one household, with the rule on (default) or off (the kill switch). */
async function read<T>(owner: string, fn: () => Promise<T>, ruleOn = true): Promise<T> {
  const was = as.owner;
  as.owner = owner;
  if (!ruleOn) vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
  try {
    return await fn();
  } finally {
    if (!ruleOn) vi.unstubAllEnvs();
    as.owner = was;
  }
}

type Seeded = { checking: { rowId: string; ext: string }; card: { rowId: string; ext: string }; ids: Record<string, string>; cats: Record<string, string>; water: string };
const S: Record<string, Seeded> = {};

async function seed(owner: string, withHolds: boolean): Promise<void> {
  HH[owner] = await createTestHousehold(owner);
  const base = { userId: owner, householdId: HH[owner]!.householdId };
  const [bank, amex] = await db
    .insert(plaidItemsTable)
    .values([
      { ...base, itemId: `item-${randomUUID()}`, accessToken: "t", institutionName: "Lakeside Bank", institutionSlug: "lakeside", lastSyncedAt: new Date("2026-10-15T09:00:00-05:00") },
      { ...base, itemId: `item-${randomUUID()}`, accessToken: "t", institutionName: "American Express", institutionSlug: "amex", lastSyncedAt: new Date("2026-10-15T09:00:00-05:00") },
    ])
    .returning();
  const chkExt = `acct-f6prem-chk-${randomUUID()}`;
  const cardExt = `acct-f6prem-card-${randomUUID()}`;
  const [chk, card] = await db
    .insert(plaidAccountsTable)
    .values([
      { ...base, itemId: bank!.id, accountId: chkExt, name: "Everyday Checking", mask: "5526", type: "depository", subtype: "checking" },
      { ...base, itemId: amex!.id, accountId: cardExt, name: "Travel Card", mask: "7101", type: "credit", subtype: "credit card" },
    ])
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2000.00",
    bankSnapshotAt: new Date("2026-10-01T08:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chk!.id,
    bankSnapshotMask: "5526",
  });
  const cats: Record<string, string> = {};
  for (const [key, name, kind, ex] of [
    ["dining", "Dining", "expense", false],
    ["subs", "Subscriptions", "expense", false],
    ["utilities", "Utilities", "expense", false],
    ["home", "Home", "expense", false],
    // The system-managed Transfer category, as the app seeds it (a transfer proposal's target).
    ["transfer", "Transfer", "expense", true],
  ] as const) {
    const [c] = await db.insert(budgetCategoriesTable).values({ ...base, name, kind, groupName: "F6P", excludeFromBudget: ex }).returning();
    cats[key] = c!.id;
  }
  await db.insert(allowancePlansTable).values([
    { householdId: base.householdId, memberUserId: null, period: "weekly", amount: "300.00", effectiveFrom: "2026-05-01", source: "owner" },
    { householdId: base.householdId, memberUserId: null, period: "monthly", amount: "400.00", effectiveFrom: "2026-05-01", source: "owner" },
  ]);
  const [water] = await db
    .insert(recurringItemsTable)
    .values({ ...base, name: "City Water", kind: "bill", amount: "100", frequency: "monthly", dayOfMonth: 2, anchorDate: "2026-10-02", active: "true", categoryId: cats.utilities })
    .returning();
  type Spec = [key: string, on: string, desc: string, amount: string, o?: { card?: boolean; pending?: boolean; cat?: string; weekly?: boolean; monthly?: boolean; pfc?: [string, string] }];
  const common: Spec[] = [
    ["tavernOld", "2026-09-29", "SOME TAVERN 0042", "-40.00", { cat: "dining", weekly: true }],
    ["payroll", "2026-10-09", "ACME CORP PAYROLL", "1500.00"],
    ["tavernNow", "2026-10-12", "SOME TAVERN 0042", "-30.00", { cat: "dining", weekly: true }],
    ["pear", "2026-10-13", "PEAR GS SAVINGS", "-20.00", { pending: true, cat: "subs", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_SAVINGS"] }],
    ["cafe", "2026-10-14", "CORNER CAFE", "-12.00", { pending: true }],
    ["bookshop", "2026-10-10", "BOOKSHOP", "-25.00", { card: true }],
    ["lunch", "2026-10-13", "LUNCH SPOT", "-40.00", { card: true, cat: "dining", weekly: true }],
  ];
  const holds: Spec[] = [
    ["water", "2026-10-02", "CITY WATER AUTOPAY", "-100.00", { pending: true }],
    ["tavernHold", "2026-10-05", "SOME TAVERN 0042", "-64.18", { pending: true, cat: "dining", weekly: true }],
    ["tavernBack", "2026-10-13", "SOME TAVERN 0042", "64.18", { pending: true, cat: "dining", weekly: true }],
    ["pearOld", "2026-10-03", "PEAR GS SAVINGS", "-20.00", { pending: true, cat: "subs", pfc: ["TRANSFER_OUT", "TRANSFER_OUT_SAVINGS"] }],
    ["parking", "2026-10-02", "PARKING GARAGE", "-30.00", { card: true, pending: true }],
    ["hotelHold", "2026-10-05", "HARBOR HOTEL HOLD", "-80.00", { card: true, pending: true, cat: "dining", weekly: true }],
    ["hotelBack", "2026-10-13", "HARBOR HOTEL", "80.00", { card: true, pending: true, cat: "dining", weekly: true }],
    ["homeHold", "2026-10-04", "HOME GOODS", "-45.00", { card: true, pending: true, cat: "home", monthly: true }],
  ];
  const specs = withHolds ? [...common, ...holds] : common;
  const out = await db
    .insert(transactionsTable)
    .values(
      specs.map(([key, on, description, amount, o = {}]) => ({
        ...base,
        occurredOn: on,
        createdAt: createdAtStartOfHouseholdDay(on),
        description,
        amount,
        pending: o.pending ?? false,
        plaidAccountId: o.card ? cardExt : chkExt,
        source: o.card ? "plaid:amex" : "plaid:lakeside",
        plaidTransactionId: `f6prem-${key}-${randomUUID().slice(0, 8)}`,
        categoryId: o.cat ? cats[o.cat]! : null,
        weeklyAllowance: o.weekly ?? false,
        monthlyAllowance: o.monthly ?? false,
        pfcPrimary: o.pfc?.[0] ?? null,
        pfcDetailed: o.pfc?.[1] ?? null,
      })),
    )
    .returning({ id: transactionsTable.id });
  const ids: Record<string, string> = {};
  specs.forEach(([key], i) => (ids[key] = out[i]!.id));
  if (withHolds) {
    // The household answered City Water's 10/02 occurrence with the payment that never posted.
    await db.insert(forecastResolutionsTable).values({
      ...base,
      recurringItemId: water!.id,
      occurrenceDate: "2026-10-02",
      status: "matched",
      matchedTxnId: ids.water!,
    });
  }
  S[owner] = { checking: { rowId: chk!.id, ext: chkExt }, card: { rowId: card!.id, ext: cardExt }, ids, cats, water: water!.id };
}

async function cleanup(): Promise<void> {
  const hhIds = Object.values(HH).map((h) => h.householdId);
  const owners = Object.keys(HH);
  if (hhIds.length === 0) return;
  await db.delete(correctionApplicationsTable).where(inArray(correctionApplicationsTable.householdId, hhIds));
  await db.delete(categoryDecisionsTable).where(inArray(categoryDecisionsTable.householdId, hhIds));
  await db.delete(merchantMemoryTable).where(inArray(merchantMemoryTable.householdId, hhIds));
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.householdId, hhIds));
  await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, hhIds));
  await db.delete(transactionsTable).where(inArray(transactionsTable.householdId, hhIds));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.householdId, hhIds));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.householdId, hhIds));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, owners));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.householdId, hhIds));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.householdId, hhIds));
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  await seed(HOLDS, true);
  await seed(CONTROL, false);
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
});

// ── The premium figures, as each screen's own endpoint serves them ─────────

const WEEK_KEYS = ["spentWeekDiscretionary", "knownWeek", "unresolvedWeek", "provisional", "remainingWeek", "remainingWeekKnown", "withinPlan"] as const;
const pick = (o: Json, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const position = async () => pick(await get("/money/position"), WEEK_KEYS);
/** The spine's position carries the week contract (not the discretionary total, which it names `spentWeek`). */
const SPINE_WEEK_KEYS = WEEK_KEYS.filter((k) => k !== "spentWeekDiscretionary");
const spinePosition = async () => {
  const s = await get("/spine");
  return { position: pick(s.position, SPINE_WEEK_KEYS), pendingCount: s.bankConfidence.pendingCount };
};
const breakdown = async (period: "week" | "month", start: string) => {
  const b = await get(`/money/period-breakdown?period=${period}&start=${start}&rowsPerGroup=50`);
  return {
    actual: b.actual,
    known: b.known,
    unresolved: b.unresolved.amount,
    unresolvedCount: b.unresolved.count,
    provisional: b.provisional,
    remaining: b.remaining,
    categories: b.categories
      .map((c: Json) => ({ name: c.name, amount: c.amount, count: c.count, usual: c.usual, usualFullPeriod: c.usualFullPeriod, aboveUsual: c.aboveUsual, historyPeriods: c.historyPeriods }))
      .sort((a: Json, b: Json) => String(a.name).localeCompare(String(b.name))),
  };
};
const bucketOf = (x: Json) => ({ count: x.count, moneyIn: x.moneyIn, moneyOut: x.moneyOut, net: x.net });
const banking = async () => {
  const r = await get("/banking/review?from=2026-10-01&to=2026-10-15&rowsPerBucket=25");
  return {
    buckets: Object.fromEntries(["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"].map((k) => [k, bucketOf(r.notInPlan[k])])),
    asPlanned: { count: r.asPlanned.count, net: r.asPlanned.net },
    planned: r.planned.map((p: Json) => `${p.plan?.label ?? p.label} ${p.plan?.scheduledDate ?? p.scheduledDate} ${p.fate} ${p.outcome}`).sort(),
    unresolvedInRange: r.reviewInbox.unresolvedInRange,
    badgeCount: r.reviewInbox.badgeCount,
    money: { moneyIn: r.cashFlow.moneyIn, moneyOut: r.cashFlow.moneyOut, net: r.cashFlow.net, pendingNet: r.cashFlow.pendingNet, pendingCount: r.cashFlow.pendingCount },
    household: pick(r.household, ["spentWeek", "knownWeek", "unresolvedWeek", "provisional", "remainingWeekKnown"]),
    reconciliation: r.reconciliation,
    balanceToday: r.balance.today,
  };
};
const amexSummary = async (from: string, to: string) => {
  const s = await get(`/amex/summary?accountId=${S[as.owner]!.card.ext}&from=${from}&to=${to}`);
  const tallyOf = (t: Json) => ({ amount: t.amount, count: t.count });
  const attention = (g: Json) => ({ count: g.count, amount: g.amount });
  return {
    purchases: tallyOf(s.purchases),
    payments: tallyOf(s.payments),
    credits: tallyOf(s.creditsAndRefunds ?? s.refunds),
    needsAttention: {
      unplanned: attention(s.needsAttention.unplanned),
      unfiled: attention(s.needsAttention.unfiled),
      uncategorized: attention(s.needsAttention.uncategorized),
    },
    household: s.householdContribution,
  };
};
const afford = async () => {
  const r = await call("POST", "/money/afford", { amount: 20 });
  if (r.status !== 200) throw new Error(`afford -> ${r.status} ${JSON.stringify(r.body)}`);
  return { remainingWeekKnown: r.body.baseline.remainingWeekKnown, after: r.body.after?.remainingWeekKnown ?? null };
};
/** Proposals, keyed by what they do — row ids differ between households, so rows are read by name and amount. */
const proposals = async () =>
  ((await get("/review/proposals")).items as Json[])
    .map((p) => `${p.kind} → ${p.action.target.label}: ${p.rows.map((r: Json) => `${r.description ?? r.merchant} ${r.date ?? r.occurredOn} ${r.amount}`).sort().join(", ")}`)
    .sort();

/** The same figure from CONTROL, from HOLDS with the rule, and from HOLDS with the kill switch. */
async function threeWays<T>(fn: () => Promise<T>): Promise<{ control: T; on: T; off: T }> {
  return { control: await read(CONTROL, fn), on: await read(HOLDS, fn), off: await read(HOLDS, fn, false) };
}
const EXPIRED_KEYS = ["water", "tavernHold", "tavernBack", "pearOld", "parking", "hotelHold", "hotelBack", "homeHold"];

describe("⭐ F6 ⇄ premium · expired holds count nowhere in the premium readers (HOLDS with the rule = CONTROL)", () => {
  it("one answer first: HOLDS's six holds and their two reversals are expired; CONTROL has none; the kill switch names none", async () => {
    const h = S[HOLDS]!.ids;
    expect([...(await findSupersededPending(HH[HOLDS]!.householdId)).expiredIds].sort()).toEqual(EXPIRED_KEYS.map((k) => h[k]!).sort());
    expect((await findSupersededPending(HH[CONTROL]!.householdId)).expiredIds.size).toBe(0);
    expect((await read(HOLDS, () => findSupersededPending(HH[HOLDS]!.householdId), false)).expiredIds.size).toBe(0);
  });

  it("⭐ Q1 week contract — GET /money/position and the spine: known / unresolved / provisional / left on the known figure = CONTROL (82.00 · 20.00 · 218.00); base: the card's 10/13 reversal netted the week to 42.00 known, 258.00 left", async () => {
    const pos = await threeWays(position);
    expect(pos.control).toEqual({
      spentWeekDiscretionary: "102.00",
      knownWeek: "82.00",
      unresolvedWeek: "20.00",
      provisional: false,
      remainingWeek: "198.00",
      remainingWeekKnown: "218.00",
      withinPlan: "yes",
    });
    expect(pos.on).toEqual(pos.control);
    expect(pos.off).toMatchObject({ spentWeekDiscretionary: "62.00", knownWeek: "42.00", unresolvedWeek: "20.00", remainingWeekKnown: "258.00" });
    // The spine's position is the position's own (spine parity), both ways.
    const spine = await threeWays(spinePosition);
    expect(spine.on.position).toEqual(pick(pos.on, Object.keys(spine.on.position)));
    expect(spine.off.position).toEqual(pick(pos.off, Object.keys(spine.off.position)));
    expect(spine.on.position).toEqual(spine.control.position);
  });

  it("⭐ Q1 bank confidence — spine.bankConfidence.pendingCount: an expired hold is not \"pending\" (2 = CONTROL: PEAR 10/13 + CAFE 10/14); base 6 (the four checking holds on top)", async () => {
    const spine = await threeWays(spinePosition);
    expect(spine.control.pendingCount).toBe(2);
    expect(spine.on.pendingCount).toBe(2);
    expect(spine.off.pendingCount).toBe(6);
  });

  it("⭐ Q1 period breakdown — this week: known / unresolved and Dining's history: 1 prior week holds Dining rows → usual is null (\"Not enough history\") = CONTROL; base counted the 10/05 hold's week (2 weeks: usual 0.00 until final #10, null now — 2 of 8 is below half)", async () => {
    const week = await threeWays(() => breakdown("week", WEEK));
    expect(week.control).toMatchObject({ actual: "102.00", known: "82.00", unresolved: "20.00", unresolvedCount: 1, provisional: false });
    expect(week.control.categories).toEqual([
      { name: "Dining", amount: "70.00", count: 2, usual: null, usualFullPeriod: null, aboveUsual: null, historyPeriods: 1 },
    ]);
    expect(week.on).toEqual(week.control);
    expect(week.off).toMatchObject({ actual: "62.00", known: "42.00", unresolved: "20.00" });
    expect(week.off.categories).toEqual([
      // (Final #10) 2 of the 8 weeks is below half: no usual (Q1 quoted 0.00).
      { name: "Dining", amount: "-10.00", count: 3, usual: null, usualFullPeriod: null, aboveUsual: null, historyPeriods: 2 },
    ]);
    // The position and the breakdown are one split (Q1 parity), both ways.
    const pos = await threeWays(position);
    expect([pos.on.knownWeek, pos.on.unresolvedWeek]).toEqual([week.on.known, week.on.unresolved]);
    expect([pos.off.knownWeek, pos.off.unresolvedWeek]).toEqual([week.off.known, week.off.unresolved]);
  });

  it("⭐ Q1 period breakdown — past weeks and the month: the holds are in no known, no unresolved, no category (= CONTROL); base: 169.18 · 90.00 (20.00 unresolved) · month 45.00", async () => {
    const last = await threeWays(() => breakdown("week", "2026-10-04"));
    expect(last.control).toMatchObject({ actual: "25.00", known: "25.00", unresolved: "0.00", categories: [] });
    expect(last.on).toEqual(last.control);
    expect(last.off).toMatchObject({ actual: "169.18", known: "169.18", unresolved: "0.00" });
    const before = await threeWays(() => breakdown("week", "2026-09-27"));
    expect(before.control).toMatchObject({ actual: "40.00", known: "40.00", unresolved: "0.00", unresolvedCount: 0 });
    expect(before.on).toEqual(before.control);
    // Base: the expired PEAR (Plaid "transfer out") read as unconfirmed, the parking hold as known.
    expect(before.off).toMatchObject({ actual: "90.00", known: "70.00", unresolved: "20.00", unresolvedCount: 1 });
    const month = await threeWays(() => breakdown("month", "2026-10-01"));
    expect(month.control).toMatchObject({ actual: "0.00", known: "0.00", unresolved: "0.00", categories: [] });
    expect(month.on).toEqual(month.control);
    expect(month.off).toMatchObject({ actual: "45.00", known: "45.00" });
  });

  it("⭐ Q1 Banking review — buckets' money in / out, the inbox, the planned outcome and the household block = CONTROL; City Water's answer named a hold that never posted: not paid yet (base: paid)", async () => {
    const b = await threeWays(banking);
    expect(b.control.planned).toEqual(["City Water 2026-10-02 on_curve not_paid_yet"]);
    // (Task 6, A2) Rule 2u: the pending PEAR −20.00 (Plaid "transfer out", filed under Subscriptions) is
    // Unconfirmed on Spending (`unresolvedWeek` 20.00), so Banking lists it under Unclear, not Unplanned
    // activity — before: count 4, out 62.00.
    expect(b.control.buckets.unmatched).toEqual({ count: 3, moneyIn: "1500.00", moneyOut: "42.00", net: "1458.00" });
    expect(b.control).toMatchObject({ unresolvedInRange: 4, badgeCount: 4, balanceToday: "3438.00", reconciliation: { rowsUnexplained: 0, unexplained: "0.00" } });
    expect(b.control.money).toEqual({ moneyIn: "1500.00", moneyOut: "62.00", net: "1438.00", pendingNet: "-32.00", pendingCount: 2 });
    expect(b.on).toEqual(b.control);
    // Base: the answer paid City Water; the holds sat in "Not on the plan" and the inbox.
    expect(b.off.planned).toEqual(["City Water 2026-10-02 matched paid"]);
    // (Task 6, A2) Rule 2u in the base reading too: the two PEAR holds (−20.00 each, "transfer out") and the
    // +64.18 credit filed under an expense category are unresolved by the evidence rule → Unclear — before:
    // count 7, in 1564.18, out 146.18.
    expect(b.off.buckets.unmatched).toEqual({ count: 4, moneyIn: "1500.00", moneyOut: "106.18", net: "1393.82" });
    expect(b.off).toMatchObject({ unresolvedInRange: 7, badgeCount: 7, balanceToday: "3318.00", asPlanned: { count: 1, net: "-100.00" } });
    expect(b.off.money).toMatchObject({ pendingCount: 6, pendingNet: "-152.00" });
    // The household block is the position's own week contract.
    const pos = await read(HOLDS, position);
    expect(b.on.household).toEqual({ spentWeek: pos.spentWeekDiscretionary, knownWeek: pos.knownWeek, unresolvedWeek: pos.unresolvedWeek, provisional: pos.provisional, remainingWeekKnown: pos.remainingWeekKnown });
    // The bank confidence count = the review's (one rule).
    expect(b.on.money.pendingCount).toBe((await read(HOLDS, spinePosition)).pendingCount);
  });

  it("⭐ Q5/Q6 Amex summary — purchases, credits, Needs attention (N to review) and the household line's known / unconfirmed = CONTROL; base: 220.00 · 80.00 credit · 2 unfiled · this week 0.00", async () => {
    const month = await threeWays(() => amexSummary("2026-10-01", "2026-10-15"));
    expect(month.control).toMatchObject({
      purchases: { amount: "65.00", count: 2 },
      credits: { amount: "0.00", count: 0 },
      needsAttention: { unfiled: { count: 1, amount: "25.00" }, uncategorized: { count: 0, amount: "0.00" }, unplanned: { count: 0, amount: "0.00" } },
    });
    expect(month.control.household).toMatchObject({ weeklyPlan: "65.00", weeklyKnown: "65.00", weeklyUnresolved: "0.00", monthlyPlan: "0.00", unfiled: "25.00" });
    expect(month.on).toEqual(month.control);
    expect(month.off).toMatchObject({ purchases: { amount: "220.00", count: 5 }, credits: { amount: "80.00", count: 1 }, needsAttention: { unfiled: { count: 2, amount: "55.00" } } });
    expect(month.off.household).toMatchObject({ weeklyPlan: "95.00", monthlyPlan: "45.00", monthlyKnown: "45.00" });
    const week = await threeWays(() => amexSummary(WEEK, "2026-10-17"));
    expect(week.control).toMatchObject({ purchases: { amount: "40.00", count: 1 }, credits: { amount: "0.00", count: 0 } });
    expect(week.control.household).toMatchObject({ weeklyPlan: "40.00", weeklyKnown: "40.00", weeklyUnresolved: "0.00" });
    expect(week.on).toEqual(week.control);
    expect(week.off).toMatchObject({ credits: { amount: "80.00", count: 1 } });
    expect(week.off.household).toMatchObject({ weeklyPlan: "0.00", weeklyKnown: "0.00" });
  });

  it("⭐ Q5 Afford — the week's plan left on the known figure = CONTROL's 218.00 (= the position's); base 258.00", async () => {
    const a = await threeWays(afford);
    expect(a.control.remainingWeekKnown).toBe("218.00");
    expect(a.on.remainingWeekKnown).toBe("218.00");
    expect(a.off.remainingWeekKnown).toBe("258.00");
    expect(a.on.remainingWeekKnown).toBe((await read(HOLDS, position)).remainingWeekKnown);
  });

  it("⭐ Q1 ways back — the trims' history: Dining 1 prior week, Subscriptions 0 → usual null (= CONTROL); base counted the 10/03 PEAR as Subscriptions history and netted Dining off the list", async () => {
    const w = await threeWays(() => get("/money/ways-back"));
    expect(byName(w.control)).toMatchObject({
      hold: { perDay: 6600 },
      trims: [
        { name: "Dining", spentWeek: 7000, usualWeek: null, usualFullWeek: null, historyPeriods: 1 },
        { name: "Subscriptions", spentWeek: 2000, usualWeek: null, usualFullWeek: null, historyPeriods: 0 },
      ],
    });
    expect(byName(w.on)).toEqual(byName(w.control));
    expect(byName(w.off)).toMatchObject({
      hold: { perDay: 7933 },
      trims: [{ name: "Subscriptions", spentWeek: 2000, usualWeek: null, historyPeriods: 1 }],
    });
  });

  it("⭐ Q2 proposals never target an expired hold: the transfer fix lists PEAR 10/13 only (= CONTROL); base listed the expired 10/03 PEAR too", async () => {
    const p = await threeWays(proposals);
    expect(p.control).toEqual(["transfer → Transfer: PEAR GS SAVINGS 2026-10-13 -20.00"]);
    expect(p.on).toEqual(p.control);
    expect(p.off).toEqual(["transfer → Transfer: PEAR GS SAVINGS 2026-10-03 -20.00, PEAR GS SAVINGS 2026-10-13 -20.00"]);
    const listed = JSON.stringify(await read(HOLDS, () => get("/review/proposals")));
    for (const k of EXPIRED_KEYS) expect(listed.includes(S[HOLDS]!.ids[k]!), k).toBe(false);
  });
});

// ── Q2: the dry run is still the applied result, with expired holds in the household ──

const periodOf = (b: Json) => ({ start: b.start, end: b.end, plan: b.plan.amount, actual: b.actual, known: b.known, unresolved: b.unresolved.amount, remaining: b.remaining, over: b.over });
async function figuresNow(dry: Json): Promise<Json> {
  const [week, month] = await Promise.all([
    get(`/money/period-breakdown?period=week&start=${dry.figures.week.before.start}&rowsPerGroup=1`),
    get(`/money/period-breakdown?period=month&start=${dry.figures.month.before.start}&rowsPerGroup=1`),
  ]);
  const budgetMonths = await Promise.all(
    dry.figures.budgetMonths.map(async (m: Json) => {
      const v = await get(`/budget/months/${m.monthStart}`);
      const want = new Set([...m.before.lines, ...m.after.lines].map((l: Json) => l.categoryId));
      return {
        monthStart: m.monthStart,
        income: v.summary.income.actual,
        expenses: v.summary.expenses.actual,
        net: v.summary.net.actual,
        lines: v.lines.filter((l: Json) => want.has(l.categoryId)).map((l: Json) => ({ categoryId: l.categoryId, name: l.categoryName, kind: l.kind, actual: l.actualAmount })),
      };
    }),
  );
  const bankingNow = await Promise.all(
    dry.figures.banking.map(async (b: Json) => {
      const r = await get(`/banking/review?account=${b.account.id}&from=${b.from}&to=${b.to}&rowsPerBucket=1`);
      return {
        buckets: Object.fromEntries(["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"].map((k) => [k, bucketOf(r.notInPlan[k])])),
        asPlanned: { count: r.asPlanned.count, net: r.asPlanned.net },
        unresolvedInRange: r.reviewInbox.unresolvedInRange,
      };
    }),
  );
  return { week: periodOf(week), month: periodOf(month), budgetMonths, banking: bankingNow };
}
const side = (dry: Json, which: "before" | "after") => ({
  week: dry.figures.week[which],
  month: dry.figures.month[which],
  budgetMonths: dry.figures.budgetMonths.map((m: Json) => ({ monthStart: m.monthStart, ...m[which] })),
});
/** Without ids (they differ between the two households): the figures by name. */
const byName = (x: Json) =>
  JSON.parse(JSON.stringify(x, (k, v) => (k === "categoryId" || k === "id" ? undefined : v)));

describe("⭐ F6 ⇄ Q2 · preview, apply, undo with expired holds in the household", () => {
  it("the dry run lists no hold; its figures are CONTROL's; the applied result = the dry run (week, month, Budget, Banking); undo restores", async () => {
    const proposalIn = async (owner: string) => read(owner, async () => ((await get("/review/proposals")).items as Json[]).find((x) => x.kind === "transfer")!);
    const bodyOf = (p: Json) => ({ rowIds: p.rows.map((r: Json) => r.id), proposalHash: p.proposalHash });
    const dryIn = async (owner: string, p: Json) =>
      read(owner, async () => {
        const r = await call("POST", `/review/proposals/${encodeURIComponent(p.key)}/apply?dryRun=1`, bodyOf(p));
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return r.body;
      });
    const pH = await proposalIn(HOLDS);
    const pC = await proposalIn(CONTROL);
    // A client holding the proposal as the kill switch read it (the expired 10/03 PEAR among its rows):
    // the rule's read refuses it, nothing written.
    const stale = await read(HOLDS, async () => ((await get("/review/proposals")).items as Json[]).find((x) => x.kind === "transfer")!, false);
    expect(stale.rows.map((r: Json) => r.id)).toContain(S[HOLDS]!.ids.pearOld);
    const refused = await read(HOLDS, () => call("POST", `/review/proposals/${encodeURIComponent(stale.key)}/apply`, bodyOf(stale)));
    expect(refused).toMatchObject({ status: 409, body: { code: "proposal_changed" } });
    expect(await db.select().from(correctionApplicationsTable).where(eq(correctionApplicationsTable.householdId, HH[HOLDS]!.householdId))).toEqual([]);
    expect(pH.rows.map((r: Json) => r.id)).toEqual([S[HOLDS]!.ids.pear]);
    const dryH = await dryIn(HOLDS, pH);
    const dryC = await dryIn(CONTROL, pC);
    expect(dryH.rows.map((r: Json) => r.id)).toEqual([S[HOLDS]!.ids.pear]);
    // The holds count nowhere in the preview either: before and after = CONTROL's.
    expect(byName(side(dryH, "before"))).toEqual(byName(side(dryC, "before")));
    expect(byName(side(dryH, "after"))).toEqual(byName(side(dryC, "after")));
    expect(dryH.figures.week.before).toMatchObject({ actual: "102.00", known: "82.00", unresolved: "20.00" });
    expect(dryH.figures.week.after).toMatchObject({ actual: "82.00", known: "82.00", unresolved: "0.00" });
    for (const [i, b] of dryH.figures.banking.entries()) expect(byName(b.after)).toEqual(byName(dryC.figures.banking[i].after));

    // Apply in HOLDS: the screens now read exactly the dry run's "after".
    const applied = await read(HOLDS, async () => {
      const r = await call("POST", `/review/proposals/${encodeURIComponent(pH.key)}/apply`, bodyOf(pH));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    });
    const now = await read(HOLDS, () => figuresNow(dryH));
    expect({ week: now.week, month: now.month, budgetMonths: now.budgetMonths }).toEqual(side(dryH, "after"));
    for (const [i, b] of dryH.figures.banking.entries()) {
      expect({ buckets: b.after.buckets, asPlanned: b.after.asPlanned, unresolvedInRange: b.after.unresolvedInRange }).toEqual(now.banking[i]);
    }
    // The expired PEAR was never touched: still pending, still Subscriptions, still an expired hold.
    const [old] = await db
      .select({ categoryId: transactionsTable.categoryId, isTransfer: transactionsTable.isTransfer, pending: transactionsTable.pending })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, S[HOLDS]!.ids.pearOld!));
    expect(old).toEqual({ categoryId: S[HOLDS]!.cats.subs, isTransfer: false, pending: true });
    expect((await findSupersededPending(HH[HOLDS]!.householdId)).expiredIds.has(S[HOLDS]!.ids.pearOld!)).toBe(true);

    // Undo: the screens are back to "before".
    const u = await read(HOLDS, () => call("POST", `/review/proposals/applied/${applied.applicationId}/undo`));
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const back = await read(HOLDS, () => figuresNow(dryH));
    expect({ week: back.week, month: back.month, budgetMonths: back.budgetMonths }).toEqual(side(dryH, "before"));
    expect(await read(HOLDS, proposals)).toEqual(["transfer → Transfer: PEAR GS SAVINGS 2026-10-13 -20.00"]);
  });
});

// ── A held hold and its reversal: counted in the money, not "pending" ─────────

describe("⭐ F6 ⇄ Q1 · a hold the bank snapshot held, and its reversal (expiredPair)", () => {
  it("the register counts the pair (net 0; the reversal's +80.00 is in the money); \"N pending\" leaves it out — the spine and the Banking review agree (2); base 8", async () => {
    const base = { userId: HOLDS, householdId: HH[HOLDS]!.householdId };
    const chk = S[HOLDS]!.checking.ext;
    const pair = await db
      .insert(transactionsTable)
      .values([
        // Dated before the 10/01 08:00 read: the snapshot holds it.
        { ...base, occurredOn: "2026-09-30", createdAt: createdAtStartOfHouseholdDay("2026-09-30"), description: "CITY CAR RENTAL HOLD", amount: "-80.00", pending: true, plaidAccountId: chk, source: "plaid:lakeside", plaidTransactionId: `f6prem-car-${randomUUID().slice(0, 8)}` },
        { ...base, occurredOn: "2026-10-08", createdAt: createdAtStartOfHouseholdDay("2026-10-08"), description: "Car Rental Transaction", amount: "80.00", pending: true, plaidAccountId: chk, source: "plaid:lakeside", plaidTransactionId: `f6prem-carback-${randomUUID().slice(0, 8)}` },
      ])
      .returning({ id: transactionsTable.id });
    try {
      const listed = await read(HOLDS, () => get("/transactions?from=2026-09-30&to=2026-10-15&limit=100"));
      const flags = (id: string) => (listed as Json[]).find((r) => r.id === id);
      for (const { id } of pair) expect(flags(id), id).toMatchObject({ expiredHold: false, expiredPair: true });
      const b = await threeWays(banking);
      // The reversal is money back (the snapshot had the hold): +80.00 in, the balance up 80.00.
      expect(b.on.money).toEqual({ moneyIn: "1580.00", moneyOut: "62.00", net: "1518.00", pendingNet: "48.00", pendingCount: 2 });
      expect(b.on.balanceToday).toBe("3518.00");
      // Neither half is spending, and neither is asked about.
      expect(b.on.unresolvedInRange).toBe(4);
      expect(b.on.reconciliation).toMatchObject({ rowsUnexplained: 0, unexplained: "0.00" });
      expect((await read(HOLDS, spinePosition)).pendingCount).toBe(2);
      expect(b.off.money.pendingCount).toBe(7);
      expect((await read(HOLDS, spinePosition, false)).pendingCount).toBe(8);
    } finally {
      await db.delete(transactionsTable).where(inArray(transactionsTable.id, pair.map((r) => r.id)));
    }
  });
});

