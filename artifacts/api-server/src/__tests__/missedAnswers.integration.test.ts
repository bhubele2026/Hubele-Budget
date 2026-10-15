// ⭐ (F5) A REVIEW ANSWER NEVER ERASES A PURCHASE — the live shape, synthetic.
//
// The household (`_fixtures/missedAnswersScenario.ts`) answered every Weekly
// Spend, Monthly Spend and Blue minimum that was due — Mark missed / Skip, given
// to the pre-F1 stored reserve. F1 read those answers as "settled", so on real
// data every unpaid in_full purchase left the curve, every Amex payment paid
// nothing, nothing carried, and the fates read missed / skipped (2026-10-14).
// The owner's rule: every expected cash obligation appears exactly once;
// exhausting an allowance never erases the obligation to pay existing
// purchases; purchases, card payments, minimums and the one-time "Amex" bill are
// never counted twice.
//
// "Before F5" figures in the titles are the same fixture on fin2/integration
// (8c80ed3a); "round 1" is F5's first, uncommitted pass. The dated table is in
// docs/reviews/2026-10-14-f5-missed.md.
//
// (F5 round 2) Every defect the round-1 reviews found has a test here: the card
// balance cap, a payment used once (pairing guard, wider window), a matched
// answer's leftover, the card-ledger minimum window, debt "paid down this month"
// on the card's own ledger, and the banking review placing a payment against
// what it actually paid. (Round 3) And the round-2 reviews': the balance read
// by the instant (pending at the read, stored after it, pending credits), a
// payment mis-tagged to another debt, a payment from before the window.
// (Round 4) And the round-3 reviews': the balance read through the REAL liability
// fetch — a leftover pending copy never moves its posted twin, and only a read
// right after a transactions sync reads rows by the instant; a loan payment never
// pairs as a card's. (Round 5) And the round-4 reviews': never over after a read
// that is not a Sync (a payment credit stored after it is outside), and a
// mis-tagged card payment is one payment whatever the bank's text.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

// (F5 round 4) Plaid's two liability reads, for the real liability fetch below.
type PlaidAcct = { account_id: string; type: string; subtype: string; balances: { current: number | null } };
let plaidAccounts: PlaidAcct[] = [];
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      accountsGet: async () => ({ data: { accounts: plaidAccounts } }),
      liabilitiesGet: async () => ({ data: { accounts: plaidAccounts, liabilities: { credit: [], student: [], mortgage: [] } } }),
    }),
  };
});

import { db, debtsTable, forecastResolutionsTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import { GetForecastCashSignalResponse } from "@workspace/api-zod";
import { fetchLiabilitiesForItem } from "../lib/plaidLiabilities";
import { computeCashSignalDetailed, type CashSignal } from "../lib/cashSignal";
import { buildBankingReview } from "../lib/bankingReview";
import { computeDebtHeadline } from "../lib/debtPlan";
import type { ForecastLedger } from "../lib/forecastLedger";
import {
  MISSED_NOW,
  MISSED_ROWS,
  cleanupMissedHouseholds,
  seedMissedHousehold,
  type MissedHousehold,
  type MissedRow,
} from "./_fixtures/missedAnswersScenario";

const owners: string[] = [];
const households: string[] = [];

async function household(answered: boolean, more: Omit<Parameters<typeof seedMissedHousehold>[1] & object, "answered"> = {}): Promise<MissedHousehold> {
  const owner = `f5-missed-${process.pid}-${randomUUID().slice(0, 8)}`;
  const h = await seedMissedHousehold(owner, { answered, ...more });
  owners.push(owner);
  households.push(h.householdId);
  return h;
}
/** Re-answer one occurrence (the household's own Review answer). */
async function answer(h: MissedHousehold, itemId: string, occurrenceDate: string, status: string, matchedTxnId: string | null = null): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(and(eq(forecastResolutionsTable.householdId, h.householdId), eq(forecastResolutionsTable.recurringItemId, itemId), eq(forecastResolutionsTable.occurrenceDate, occurrenceDate)));
  await db.insert(forecastResolutionsTable).values({ userId: h.ownerUserId, householdId: h.householdId, recurringItemId: itemId, occurrenceDate, status, matchedTxnId });
}

const read = async (h: MissedHousehold): Promise<{ sig: CashSignal; ledger: ForecastLedger }> => {
  const d = await computeCashSignalDetailed(h.householdId, h.ownerUserId, { horizonDays: 30 });
  return { sig: d.signal, ledger: d.ledger };
};
const legacy = async <T>(f: () => Promise<T>): Promise<T> => {
  process.env.HOOK_OBLIGATIONS = "off";
  try {
    return await f();
  } finally {
    delete process.env.HOOK_OBLIGATIONS;
  }
};
const cents = (v: string | number) => Math.round(Number(v) * 100);
const events = (sig: CashSignal) =>
  (sig.events ?? []).map((e) => `${e.date} ${e.label} ${e.amount}${e.originalDate !== e.date ? ` (${e.originalDate} ${e.assumption})` : ""}`);
const moves = (sig: CashSignal) => (sig.daily ?? []).filter((d, i, a) => i === 0 || d.balance !== a[i - 1]!.balance).map((d) => `${d.date} ${d.balance}`);
const weeklyReserves = (sig: CashSignal) =>
  (sig.hookReserves ?? [])
    .filter((r) => r.hook === "weekly")
    .map((r) => `${r.occurrenceDate} ${r.amount} = incurred ${r.incurred} + paid ${r.paid} + carried ${r.carried} + left ${r.allowanceLeft}${r.carriedTo ? ` → ${r.carriedTo}` : ""}`);
/** Each occurrence's fate, with the row behind it by fixture key. */
const fates = (h: MissedHousehold, ledger: ForecastLedger, itemId: string) => {
  const key = (id: string | null) => (id ? (Object.entries(h.txn).find(([, v]) => v === id)?.[0] ?? id) : null);
  return ledger.planOccurrences
    .filter((o) => o.itemId === itemId && o.dueDate <= "2026-10-17")
    .map((o) => [o.dueDate, o.fate, o.onCurve, key(o.txnId), o.evidence, o.answer ?? null, o.remainder]);
};

const keyOf = (h: MissedHousehold, id: string) => Object.entries(h.txn).find(([, v]) => v === id)?.[0] ?? id;
const LIABILITY_READ_AT = new Date("2026-10-14T07:00:00-05:00");
/**
 * (F5 round 4) The REAL liability fetch (Plaid mocked) reading Platinum's balance
 * at Wed 10/14 07:00 Central: `afterSync`, as POST /plaid/sync runs it (right
 * after the item's transactions sync); otherwise as a debt's Refresh or a link
 * does. Returns the pending rows it kept, by fixture key, sorted (null: none kept;
 * round 6: every read keeps them, flagged `liabilityPendingAfterSync`).
 */
async function liabilityRead(h: MissedHousehold, platinum: number, afterSync: boolean): Promise<string[] | null> {
  const [plat] = await db.select().from(plaidAccountsTable).where(eq(plaidAccountsTable.accountId, h.accounts.platinum));
  // The token guards want a well-formed sandbox token (the suite runs PLAID_ENV=sandbox).
  await db.update(plaidItemsTable).set({ accessToken: `access-sandbox-${randomUUID()}` }).where(eq(plaidItemsTable.id, plat!.itemId));
  plaidAccounts = [
    { account_id: h.accounts.platinum, type: "credit", subtype: "credit card", balances: { current: platinum } },
    { account_id: h.accounts.blue, type: "credit", subtype: "credit card", balances: { current: null } },
  ];
  vi.setSystemTime(LIABILITY_READ_AT);
  try {
    await fetchLiabilitiesForItem(h.ownerUserId, plat!.itemId, { afterTxnSync: afterSync });
  } finally {
    vi.setSystemTime(MISSED_NOW);
  }
  const [after] = await db.select().from(plaidAccountsTable).where(eq(plaidAccountsTable.accountId, h.accounts.platinum));
  expect(after!.liabilityBalance).toBe(platinum.toFixed(2));
  // (F5 round 6) Every read keeps its pending list, flagged with the kind of read it was.
  expect(after!.liabilityPendingAfterSync).toBe(afterSync);
  return after!.liabilityPendingTxnIds == null ? null : after!.liabilityPendingTxnIds.map((id) => keyOf(h, id)).sort();
}

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(MISSED_NOW);
});
afterEach(() => {
  delete process.env.HOOK_OBLIGATIONS;
});
afterAll(async () => {
  vi.useRealTimers();
  await cleanupMissedHouseholds(owners, households);
});

const EVENTS_AFTER = [
  "2026-10-15 Weekly Spend -210.00 (2026-10-10 overdue_remainder_assumed_unpaid)",
  "2026-10-17 Weekly Spend -300.00",
  "2026-10-24 Weekly Spend -300.00",
  "2026-10-31 Weekly Spend -300.00",
  "2026-11-01 Monthly Spend -400.00",
  "2026-11-04 Amex Blue Cash minimum -45.00",
  "2026-11-07 Weekly Spend -300.00",
];
const WEEKLY_AFTER = [
  "2026-09-05 120.00 = incurred 0.00 + paid 120.00 + carried 0.00 + left 0.00",
  "2026-09-12 240.00 = incurred 0.00 + paid 240.00 + carried 0.00 + left 0.00",
  "2026-09-19 130.00 = incurred 0.00 + paid 130.00 + carried 0.00 + left 0.00",
  "2026-09-26 210.00 = incurred 0.00 + paid 210.00 + carried 0.00 + left 0.00",
  "2026-10-03 180.00 = incurred 0.00 + paid 180.00 + carried 0.00 + left 0.00",
  "2026-10-10 260.00 = incurred 210.00 + paid 50.00 + carried 0.00 + left 0.00",
  "2026-10-17 300.00 = incurred 90.00 + paid 0.00 + carried 0.00 + left 210.00",
  "2026-10-24 300.00 = incurred 0.00 + paid 0.00 + carried 0.00 + left 300.00",
  "2026-10-31 300.00 = incurred 0.00 + paid 0.00 + carried 0.00 + left 300.00",
  "2026-11-07 300.00 = incurred 0.00 + paid 0.00 + carried 0.00 + left 300.00",
];

describe("F5 · every due Weekly Spend answered missed / skipped (the live shape)", () => {
  let h: MissedHousehold;
  beforeAll(async () => {
    h = await household(true);
  });

  it("⭐ the curve: the unpaid 210 lands once, Thu 10/15; low 1,860.00 on 10/17 (before F5: no 10/15 event, low 2,070.00 — real purchases erased; round 1: −270, low 1,800.00 — 60 of payments dropped)", async () => {
    const { sig } = await read(h);
    expect(() => GetForecastCashSignalResponse.parse(sig)).not.toThrow();
    expect(sig.bankToday).toBe("2370.00");
    expect(events(sig)).toEqual(EVENTS_AFTER);
    expect(moves(sig)).toEqual([
      "2026-10-14 2370.00",
      "2026-10-15 2160.00",
      "2026-10-17 1860.00",
      "2026-10-23 3660.00",
      "2026-10-24 3360.00",
      "2026-10-31 3060.00",
      "2026-11-01 2660.00",
      "2026-11-04 2615.00",
      "2026-11-06 4415.00",
      "2026-11-07 4115.00",
    ]);
    expect(`${sig.lowestProjected} @ ${sig.lowestDate}`).toBe("1860.00 @ 2026-10-17");
  });

  it("each week: covered weeks are paid oldest first; a payment's leftover pays the purchases made before it (9/22's 70 → the 9/21 FUEL STOP; 10/2's credit and 10/8's 20 → purchases already made) — nothing carried (before F5: paid 0.00 everywhere; round 1: 10/3 carried 10, 10/10 paid 0)", async () => {
    const { sig } = await read(h);
    expect(weeklyReserves(sig)).toEqual(WEEKLY_AFTER);
    const r = (d: string) => sig.hookReserves!.find((x) => x.hook === "weekly" && x.occurrenceDate === d)!;
    expect(r("2026-10-10").carriedFrom).toEqual([]);
    // 10/10: Platinum 260 — the pending BISTRO 22 its posted row replaced counts once.
    expect(r("2026-10-10").cards.map((c) => `${c.mask} ${c.mode} ${c.amount}`)).toEqual(["7101 in_full 260.00"]);
    expect(sig.hookReserves!.every((x) => x.cards.every((c) => c.mask !== "7102"))).toBe(true);
  });

  it("⭐ never 'missed' while something is owed: answered weeks read paid / carried / on the curve, the answer kept beside the fate (before F5: missed ×5, skipped ×1, all off the curve)", async () => {
    const { ledger } = await read(h);
    expect(fates(h, ledger, h.weeklySpendId)).toEqual([
      ["2026-09-05", "paid_on_evidence", false, "cStmt", "card_payment", "missed", 0],
      ["2026-09-12", "paid_on_evidence", false, "cStmt", "card_payment", "missed", 0],
      ["2026-09-19", "paid_on_evidence", false, "cStmt", "card_payment", "missed", 0],
      ["2026-09-26", "paid_on_evidence", false, "c2", "card_payment", "missed", 0],
      ["2026-10-03", "paid_on_evidence", false, "c3", "card_payment", "skipped", 0],
      ["2026-10-10", "paid_on_evidence", true, "c4", "card_payment", "missed", -210],
      ["2026-10-17", "on_curve", true, null, null, null, null],
    ]);
  });

  it("⭐ exactly once: Σ purchases 1,230 (closed 1,140 + open 90); 930 of the 940 paid allocated, each once (10 of the 9/28 payment found nothing bought by then); the due unpaid 210 is the one dragged event", async () => {
    const { sig } = await read(h);
    const rs = sig.hookReserves!.filter((r) => r.hook === "weekly");
    const own = rs.reduce((s, r) => s + r.cards.reduce((t, c) => t + cents(c.amount), 0), 0);
    expect(own).toBe(123000);
    // 9/14 40 + 9/22 520 + 9/28 140 (of 150) + 10/2 50 (card only) + 10/8 150 + 10/13 30 = 930.
    expect(rs.reduce((s, r) => s + cents(r.paid), 0)).toBe(93000);
    for (const r of rs) expect(cents(r.incurred) + cents(r.paid) + cents(r.cappedByBalance ?? 0), r.occurrenceDate).toBe(r.cards.reduce((t, c) => t + cents(c.amount), 0));
    expect(rs.every((r) => r.cappedByBalance === undefined)).toBe(true); // no live card balance in this fixture: nothing capped
    expect(rs.reduce((s, r) => s + cents(r.amount), 0)).toBe(own + rs.reduce((s, r) => s + cents(r.allowanceLeft), 0));
    const hook = (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId && e.date < "2026-10-17");
    expect(hook.map((e) => `${e.date} ${e.amount}`)).toEqual(["2026-10-15 -210.00"]);
    // Due unpaid on the curve = Σ own (closed) − Σ paid on closed weeks.
    expect(-cents(hook[0]!.amount)).toBe(114000 - 93000);
  });

  it("the answers no longer switch anything: the same household unanswered owes exactly the same weekly figures (only the Monthly Spend reserve, which an answer does close, differs)", async () => {
    const plain = await household(false);
    const a = await read(h);
    const b = await read(plain);
    expect(weeklyReserves(b.sig)).toEqual(weeklyReserves(a.sig));
    const weekly = (sig: CashSignal, id: string) => (sig.events ?? []).filter((e) => e.itemId === id).map((e) => `${e.date} ${e.amount}`);
    expect(weekly(b.sig, plain.weeklySpendId)).toEqual(weekly(a.sig, h.weeklySpendId));
    // Unanswered, October's open Monthly Spend reserve (400 left of the plan, nothing charged) drags as before.
    expect(events(b.sig).filter((e) => e.includes("Monthly Spend"))).toEqual([
      "2026-10-15 Monthly Spend -400.00 (2026-10-01 overdue_assumed_unpaid)",
      "2026-11-01 Monthly Spend -400.00",
    ]);
  });

  it("Monthly Spend: a missed answer closes the reserve (October's 400 left → 0); nothing was owed (Blue is on the debt plan); off the curve as before", async () => {
    const { sig, ledger } = await read(h);
    const m = sig.hookReserves!.filter((r) => r.hook === "monthly").map((r) => `${r.occurrenceDate} ${r.amount} left ${r.allowanceLeft}`);
    expect(m).toEqual(["2026-09-01 0.00 left 0.00", "2026-10-01 0.00 left 0.00", "2026-11-01 400.00 left 400.00"]);
    expect(fates(h, ledger, h.monthlySpendId)).toEqual([
      ["2026-09-01", "missed", false, null, null, "missed", null],
      ["2026-10-01", "missed", false, null, null, "missed", null],
    ]);
  });

  it("⭐ a paid debt minimum reads paid: Blue's own ledger (+300 on 9/23) pays 9/4 late and 10/4 early with the separate 9/22 checking payment — answered missed, still off the curve, now listed paid (card_ledger)", async () => {
    const { sig, ledger } = await read(h);
    const blue = `debt:${h.debts.blue}`;
    expect(fates(h, ledger, blue)).toEqual([
      ["2026-09-04", "paid_on_evidence", false, "cBlue", "card_ledger", "missed", 0],
      ["2026-10-04", "paid_on_evidence", false, "cBlue", "card_ledger", "missed", 0],
    ]);
    expect((sig.overdueAssumedPaid ?? []).filter((p) => p.itemId === blue).map((p) => `${p.dueDate} ${p.planAmount} ← ${p.txnAmount} left ${p.unpaidRemainder} ${p.confidence}`)).toEqual([
      "2026-09-04 -45.00 ← -300.00 left 0.00 card_ledger",
      "2026-10-04 -45.00 ← -300.00 left 0.00 card_ledger",
    ]);
    expect(events(sig).filter((e) => e.includes("minimum"))).toEqual(["2026-11-04 Amex Blue Cash minimum -45.00"]);
  });

  it("nothing counted twice: Blue's payment pays no week; the pre-window 8/25 payment and the one-time 'Amex' bill (8/26) claim nothing and reach no event", async () => {
    const { sig, ledger } = await read(h);
    const hookTxns = (sig.overdueAssumedPaid ?? []).filter((p) => p.itemId === h.weeklySpendId).map((p) => p.txnId);
    expect(hookTxns).not.toContain(h.txn.cBlue);
    expect(hookTxns).not.toContain(h.txn.c0);
    expect(ledger.planOccurrences.filter((o) => o.txnId === h.txn.c0)).toEqual([]);
    expect(ledger.planOccurrences.filter((o) => o.itemId === h.amexBillId)).toEqual([]);
    expect((sig.events ?? []).filter((e) => e.itemId === h.amexBillId)).toEqual([]);
    // Every payment row is evidence for one kind of plan at most.
    const byTxn = new Map<string, Set<string>>();
    for (const o of ledger.planOccurrences) if (o.txnId) byTxn.set(o.txnId, (byTxn.get(o.txnId) ?? new Set()).add(o.itemId));
    expect([...byTxn.values()].every((items) => items.size === 1)).toBe(true);
  });

  it("the banking review lists what the ledger decided: paid weeks and paid minimums, the week still owing on the curve — no 'missed'", async () => {
    const r = await buildBankingReview(h.householdId, h.ownerUserId, { from: "2026-09-01", to: "2026-10-14", rowsPerBucket: 5, limit: 25 });
    const planned = (r.planned as Array<{ label: string; scheduledDate: string; fate: string; onCurve: boolean }>).map((p) => `${p.scheduledDate} ${p.label} ${p.fate}${p.onCurve ? " (on curve)" : ""}`);
    expect(planned).toEqual([
      "2026-09-01 Monthly Spend missed",
      "2026-09-04 Amex Blue Cash minimum paid_on_evidence",
      "2026-09-05 Weekly Spend paid_on_evidence",
      "2026-09-12 Weekly Spend paid_on_evidence",
      "2026-09-19 Weekly Spend paid_on_evidence",
      "2026-09-26 Weekly Spend paid_on_evidence",
      "2026-10-01 Monthly Spend missed",
      "2026-10-03 Weekly Spend paid_on_evidence",
      "2026-10-04 Amex Blue Cash minimum paid_on_evidence",
      "2026-10-10 Weekly Spend paid_on_evidence (on curve)",
    ]);
  });

  it("⭐ (6) the banking review places each payment against what it ACTUALLY paid: the 520 statement payment is as planned (four weeks, 520), Blue's 300 is 210 over its two minimums — never a fake 'different amount' (round 1: 3 rows, 585.00 of differences, the 9/4 minimum counted twice)", async () => {
    const r = await buildBankingReview(h.householdId, h.ownerUserId, { from: "2026-09-01", to: "2026-10-14", rowsPerBucket: 25, limit: 25 });
    type Row = { id: string; amount: string; reason: string; plan: { label: string; planned: string | null; difference: string | null } | null };
    const key = (id: string) => Object.entries(h.txn).find(([, v]) => v === id)?.[0] ?? id;
    const rows = (b: { rows: Row[] }) => b.rows.map((x) => `${key(x.id)} ${x.amount} vs ${x.plan?.planned ?? "-"} (${x.plan?.difference ?? "-"})`).sort();
    const nip = r.notInPlan as Record<string, { rows: Row[]; differenceTotal?: string | null }>;
    expect(rows(nip.amountDifference!)).toEqual([
      "c2 -150.00 vs -140.00 (10.00)", // 10 of it found nothing bought by 9/28: a real difference
      "cBlue -300.00 vs -90.00 (210.00)", // two minimums of 45, 210 more paid down: real
    ]);
    expect(nip.amountDifference!.differenceTotal).toBe("220.00");
    expect(rows(nip.timingDifference!)).toEqual(["c1 -40.00 vs -40.00 (0.00)"]); // paid the 9/5 week nine days late
    // Every Platinum payment is tied to the weeks it paid: none "unmatched".
    expect(nip.unmatched!.rows.map((x) => key(x.id)).filter((k) => ["cStmt", "c2", "c3", "c4", "c1", "cBlue"].includes(k))).toEqual([]);
    const planned = r.planned as Array<{ scheduledDate: string; label: string; txnAmount: string | null; difference: string | null }>;
    // Each week shows what was paid toward it, never the whole statement payment.
    expect(planned.filter((p) => p.label === "Weekly Spend").map((p) => `${p.scheduledDate} ${p.txnAmount} (${p.difference})`)).toEqual([
      "2026-09-05 -120.00 (0.00)",
      "2026-09-12 -240.00 (0.00)",
      "2026-09-19 -130.00 (0.00)",
      "2026-09-26 -210.00 (0.00)",
      "2026-10-03 -180.00 (0.00)",
      "2026-10-10 -50.00 (-210.00)",
    ]);
    expect(planned.filter((p) => p.label.includes("minimum")).map((p) => `${p.scheduledDate} ${p.txnAmount} (${p.difference})`)).toEqual([
      "2026-09-04 -45.00 (0.00)",
      "2026-10-04 -45.00 (0.00)",
    ]);
  });

  it("the kill switch (HOOK_OBLIGATIONS=off) keeps the pre-F1 model whole: every answer settles, as before F1", async () => {
    const { sig, ledger } = await legacy(() => read(h));
    expect(events(sig)).toEqual(EVENTS_AFTER.slice(1));
    expect(events(sig)).toEqual([
      "2026-10-17 Weekly Spend -300.00",
      "2026-10-24 Weekly Spend -300.00",
      "2026-10-31 Weekly Spend -300.00",
      "2026-11-01 Monthly Spend -400.00",
      "2026-11-04 Amex Blue Cash minimum -45.00",
      "2026-11-07 Weekly Spend -300.00",
    ]);
    expect(`${sig.lowestProjected} @ ${sig.lowestDate}`).toBe("2070.00 @ 2026-10-17");
    expect(fates(h, ledger, h.weeklySpendId).map((f) => f[1])).toEqual(["missed", "missed", "missed", "missed", "skipped", "missed", "on_curve"]);
    expect(fates(h, ledger, `debt:${h.debts.blue}`).map((f) => f[1])).toEqual(["missed", "missed"]);
  });
});

describe("F5 · the same household with NO answers — a payment reaches one card", () => {
  it("⭐ Platinum's 10/8 payment pays Platinum, Blue's 9/22 payment pays Blue's minimums (before F5: the 10/8 row paid Blue's 10/4 minimum by the issuer's name, the 8/25 row its 9/4 one, and 10/15 read −420; round 1: −270)", async () => {
    const h = await household(false);
    const { sig, ledger } = await read(h);
    expect(fates(h, ledger, `debt:${h.debts.blue}`)).toEqual([
      ["2026-09-04", "paid_on_evidence", false, "cBlue", "card_ledger", null, 0],
      ["2026-10-04", "paid_on_evidence", false, "cBlue", "card_ledger", null, 0],
    ]);
    expect(events(sig).filter((e) => e.startsWith("2026-10-15"))).toEqual([
      "2026-10-15 Weekly Spend -210.00 (2026-10-10 overdue_remainder_assumed_unpaid)",
      "2026-10-15 Monthly Spend -400.00 (2026-10-01 overdue_assumed_unpaid)",
    ]);
    expect(`${sig.lowestProjected} @ ${sig.lowestDate}`).toBe("1460.00 @ 2026-10-17");
    // The 10/8 row's money is on the 10/3 and 10/10 weeks.
    expect(sig.hookReserves!.filter((r) => r.hook === "weekly").reduce((s, r) => s + cents(r.paid), 0)).toBe(93000);
  });

  it("⭐ (2) payment used once: every checking row pays at most its own amount, never both a minimum and a card week, and a card credit and the checking row that sent it are never both counted", async () => {
    for (const answered of [false, true]) {
      const h = await household(answered);
      const { ledger } = await read(h);
      const used = new Map<string, { cents: number; kinds: Set<string> }>();
      const use = (txnId: string, cents: number, kind: string) => {
        const u = used.get(txnId) ?? { cents: 0, kinds: new Set<string>() };
        u.cents += cents;
        u.kinds.add(kind);
        used.set(txnId, u);
      };
      for (const [txnId, list] of ledger.paymentAllocations) for (const a of list) use(txnId, a.cents, a.planKey.startsWith("debt:") ? "minimum" : "card week");
      // The matcher's and the name rule's evidence on minimums (not the card ledger's, counted above).
      for (const o of ledger.planOccurrences) {
        if (o.txnId && o.itemId.startsWith("debt:") && o.fate === "paid_on_evidence" && o.evidence !== "card_ledger") use(o.txnId, Math.round(Math.abs(o.amount ?? 0) * 100), "minimum");
      }
      for (const [k, id] of Object.entries(h.txn)) {
        const row = { c0: 70000, c1: 4000, cBlue: 30000, cStmt: 52000, c2: 15000, c3: 15000, c4: 3000 }[k];
        const u = used.get(id);
        if (row === undefined || !u) continue;
        expect(u.cents, `${k} answered=${answered}`).toBeLessThanOrEqual(row);
        expect(u.kinds.size, `${k} answered=${answered}`).toBe(1);
      }
      for (const [credit, checking] of [["kP1", "cStmt"], ["kP2", "c2"], ["kP4", "c3"], ["kB", "cBlue"]] as const) {
        expect(used.has(h.txn[credit]!) && used.has(h.txn[checking]!), `${credit} + ${checking}`).toBe(false);
      }
    }
  });

  it("⭐ (2) a weekend payment: Blue's card credit on Fri 10/9, its bank debit Mon 10/12 — they pair (window +5 days): the debit pays Blue's 10/4 minimum and never Platinum's weeks (round 1: unpaired, the debit also paid Platinum's 10/10 week — 10/15 read 0)", async () => {
    const extra: MissedRow[] = [
      { key: "kB2", on: "2026-10-09", desc: "ONLINE PAYMENT - THANK YOU", amt: "300.00", acct: "blue" },
      { key: "cBlue2", on: "2026-10-12", desc: "AMERICAN EXPRESS ACH PMT", amt: "-300.00", acct: "checking", category: "buffer" },
    ];
    const h = await household(false, { rows: (r) => r.key !== "kB" && r.key !== "cBlue", extra });
    const { sig, ledger } = await read(h);
    const blue = `debt:${h.debts.blue}`;
    expect(fates(h, ledger, blue).find((f) => f[0] === "2026-10-04")).toEqual(["2026-10-04", "paid_on_evidence", false, "cBlue2", "card_ledger", null, 0]);
    expect(ledger.paymentAllocations.get(h.txn.cBlue2!)!.map((a) => a.planKey)).toEqual([`${blue}|2026-10-04`]);
    expect(events(sig).filter((e) => e.startsWith("2026-10-15 Weekly"))).toEqual(["2026-10-15 Weekly Spend -210.00 (2026-10-10 overdue_remainder_assumed_unpaid)"]);
  });

  it("⭐ (2) the issuer-name guard: a same-amount transfer to someone else two days after Blue's credit is not Blue's payment — it pays nothing on the card side", async () => {
    const extra: MissedRow[] = [
      { key: "kB2", on: "2026-10-09", desc: "ONLINE PAYMENT - THANK YOU", amt: "300.00", acct: "blue" },
      { key: "zelle", on: "2026-10-11", desc: "ZELLE TO LANDLORD", amt: "-300.00", acct: "checking", category: "buffer" },
    ];
    const h = await household(false, { rows: (r) => r.key !== "kB" && r.key !== "cBlue", extra });
    const { ledger } = await read(h);
    // The credit was paid from elsewhere: it pays Blue's 10/4 minimum by itself.
    expect(fates(h, ledger, `debt:${h.debts.blue}`).find((f) => f[0] === "2026-10-04")).toEqual(["2026-10-04", "paid_on_evidence", false, "kB2", "card_ledger", null, 0]);
    expect(ledger.paymentAllocations.has(h.txn.zelle!)).toBe(false);
  });

  it("⭐ (4) the card-ledger minimum window opens at the statement close: Blue's only payment on 9/6 (two days late for 9/4) never pays the 10/4 minimum too — its −45 drags on 10/15 (round 1: it paid both)", async () => {
    const extra: MissedRow[] = [
      { key: "kB6", on: "2026-09-06", desc: "ONLINE PAYMENT - THANK YOU", amt: "300.00", acct: "blue" },
      { key: "cBlue6", on: "2026-09-06", desc: "AMERICAN EXPRESS ACH PMT", amt: "-300.00", acct: "checking", category: "buffer" },
    ];
    const h = await household(false, { rows: (r) => r.key !== "kB" && r.key !== "cBlue", extra });
    const { sig, ledger } = await read(h);
    const blue = `debt:${h.debts.blue}`;
    // 10/4 stays on the curve (a tier-3 suggestion at most: Platinum's own payments are no evidence for it).
    expect(fates(h, ledger, blue).map((f) => `${f[0]} ${f[1]} ${f[2]} ${f[4] ?? ""}`)).toEqual(["2026-09-04 paid_on_evidence false card_ledger", "2026-10-04 suggested true "]);
    expect(events(sig).filter((e) => e.includes("minimum"))).toEqual([
      "2026-10-15 Amex Blue Cash minimum -45.00 (2026-10-04 overdue_assumed_unpaid)",
      "2026-11-04 Amex Blue Cash minimum -45.00",
    ]);
  });

  it("⭐ (5) debt 'paid down this month' counts a payment the debt's own card received (card_ledger): Blue's 10/2 −300 reads 300 (round 1: 0)", async () => {
    const extra: MissedRow[] = [
      { key: "cBlue3", on: "2026-10-02", desc: "AMERICAN EXPRESS ACH PMT", amt: "-300.00", acct: "checking", category: "buffer" },
      { key: "kB3", on: "2026-10-03", desc: "ONLINE PAYMENT - THANK YOU", amt: "300.00", acct: "blue" },
    ];
    const h = await household(false, { rows: (r) => r.key !== "kB" && r.key !== "cBlue", extra });
    const { sig, ledger } = await read(h);
    expect(fates(h, ledger, `debt:${h.debts.blue}`).map((f) => `${f[0]} ${f[1]} ${f[3]} ${f[4]}`)).toEqual([
      "2026-09-04 paid_on_evidence cBlue3 card_ledger",
      "2026-10-04 paid_on_evidence cBlue3 card_ledger",
    ]);
    const headline = await computeDebtHeadline(h.householdId, h.ownerUserId, sig);
    expect([headline.paidDownMtd, headline.confirmedPaymentsMtd]).toEqual([300, 300]);
  });
});

describe("⭐ F5 round 2 · (7) a week still owing after its payments is CARRIED, never missed", () => {
  it("without the 10/2 credit and the pending 10/13 payment, 10/3 owes 30 after 10/8's 150: it is carried into 10/10 and lands with it on Thu 10/15 (−290); the banking review lists it 'carried' to 10/15, the answer kept", async () => {
    const h = await household(true, { rows: (r) => r.key !== "kP3" && r.key !== "c4" });
    const { sig, ledger } = await read(h);
    expect(events(sig)[0]).toBe("2026-10-15 Weekly Spend -290.00 (2026-10-10 overdue_assumed_unpaid)");
    const o = ledger.planOccurrences.find((x) => x.itemId === h.weeklySpendId && x.occurrenceDate === "2026-10-03")!;
    expect([o.fate, o.answer, o.remainder, o.carriedTo]).toEqual(["carried", "skipped", -30, "2026-10-15"]);
    const r = await buildBankingReview(h.householdId, h.ownerUserId, { from: "2026-09-01", to: "2026-10-14", rowsPerBucket: 5, limit: 25 });
    const planned = (r.planned as Array<{ scheduledDate: string; label: string; fate: string; carriedTo: string | null }>).filter((p) => p.label === "Weekly Spend");
    expect(planned.find((p) => p.scheduledDate === "2026-10-03")).toMatchObject({ fate: "carried", carriedTo: "2026-10-15" });
    expect(planned.every((p) => p.fate !== "missed" && p.fate !== "skipped")).toBe(true);
  });
});

describe("⭐ F5 round 2 · (3) a matched answer never erases purchases nor throws away the rest of its payment", () => {
  it("9/19 matched with the 520 statement payment: the row pays 9/19 first, the rest pays 9/5, 9/12 and the 9/21 purchase — the same weeks as unanswered; 10/15 −210 (round 1: −590, 390 of that payment counted again as unpaid)", async () => {
    const h = await household(true);
    await answer(h, h.weeklySpendId, "2026-09-19", "matched", h.txn.cStmt!);
    const { sig, ledger } = await read(h);
    expect(weeklyReserves(sig)).toEqual(WEEKLY_AFTER);
    expect(events(sig)).toEqual(EVENTS_AFTER);
    expect(fates(h, ledger, h.weeklySpendId).find((f) => f[0] === "2026-09-19")).toEqual(["2026-09-19", "matched", false, "cStmt", null, null, null]);
    expect(ledger.paymentAllocations.get(h.txn.cStmt!)!.reduce((s, a) => s + a.cents, 0)).toBe(52000);
    // The banking review compares the confirmed row with all it paid: as planned.
    const r = await buildBankingReview(h.householdId, h.ownerUserId, { from: "2026-09-01", to: "2026-10-14", rowsPerBucket: 25, limit: 25 });
    const nip = r.notInPlan as Record<string, { rows: Array<{ id: string }> }>;
    expect(Object.values(nip).flatMap((b) => b.rows.map((x) => x.id))).not.toContain(h.txn.cStmt);
  });

  it("10/10 matched with the 30 pending payment: the row pays 30 of it; the other 210 of purchases stay owed and drag on 10/15 (round 1: the whole week erased — no 10/15 event)", async () => {
    const h = await household(true);
    await answer(h, h.weeklySpendId, "2026-10-10", "matched", h.txn.c4!);
    const { sig, ledger } = await read(h);
    expect(events(sig)[0]).toBe("2026-10-15 Weekly Spend -210.00 (2026-10-10 overdue_remainder_assumed_unpaid)");
    expect(fates(h, ledger, h.weeklySpendId).find((f) => f[0] === "2026-10-10")).toEqual(["2026-10-10", "paid_on_evidence", true, "c4", "card_payment", "matched", -210]);
  });
});

describe("⭐ F5 round 2 · (1) a card's carried + current unpaid never exceeds what the card owes", () => {
  const at = (iso: string) => new Date(iso);
  const weekly = (sig: CashSignal, h: MissedHousehold) =>
    (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId && e.date <= "2026-10-17").map((e) => `${e.date} ${e.amount}`);

  it("Platinum's live balance 320.00 (read today), less the pending 10/13 −30 it has not received: at most 290 held for it — the 10/10 week's 210 is cut to 200, oldest first; this week's 90 stays (without a balance: 210 + 90 = 300)", async () => {
    const h = await household(true, { platinumBalance: { balance: "320.00", at: at("2026-10-14T07:00:00-05:00") } });
    const { sig } = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
    const r = (d: string) => sig.hookReserves!.find((x) => x.hook === "weekly" && x.occurrenceDate === d)!;
    expect([r("2026-10-10").incurred, r("2026-10-10").cappedByBalance, r("2026-10-17").incurred, r("2026-10-17").cappedByBalance]).toEqual(["200.00", "10.00", "90.00", undefined]);
    expect(`${sig.lowestProjected} @ ${sig.lowestDate}`).toBe("1870.00 @ 2026-10-17");
    // Never over: carried + this week's purchases on the card = its balance less what is in flight.
    const held = sig.hookReserves!.filter((x) => x.hook === "weekly").reduce((s, x) => s + cents(x.incurred) + (x.carriedTo ? 0 : cents(x.carried)), 0);
    expect(held).toBe(32000 - 3000);
  });

  it("⭐ the live shape — the evidence holds MORE than the card owes (balance 150.00): the cut takes the oldest unpaid first; the curve holds 120 for the card, never more", async () => {
    const h = await household(true, { platinumBalance: { balance: "150.00", at: at("2026-10-14T07:00:00-05:00") } });
    const { sig } = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-15 -30.00", "2026-10-17 -300.00"]);
    const held = sig.hookReserves!.filter((x) => x.hook === "weekly").reduce((s, x) => s + cents(x.incurred), 0);
    expect(held).toBe(15000 - 3000);
    expect(`${sig.lowestProjected} @ ${sig.lowestDate}`).toBe("2040.00 @ 2026-10-17");
  });

  it("a balance read before this week's purchases is rolled forward with the card's own rows (230.00 read Sun 10/11 + 55 + 35 bought since = 320): the same 290", async () => {
    const h = await household(true, { platinumBalance: { balance: "230.00", at: at("2026-10-11T07:00:00-05:00") } });
    const { sig } = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
  });

  it("a cap only lowers: a balance above what the evidence holds changes nothing; the kill switch never caps", async () => {
    const h = await household(true, { platinumBalance: { balance: "900.00", at: at("2026-10-14T07:00:00-05:00") } });
    const { sig } = await read(h);
    expect(events(sig)).toEqual(EVENTS_AFTER);
    expect(sig.hookReserves!.every((x) => x.cappedByBalance === undefined)).toBe(true);
    const low = await household(true, { platinumBalance: { balance: "10.00", at: at("2026-10-14T07:00:00-05:00") } });
    const legacySig = (await legacy(() => read(low))).sig;
    expect(events(legacySig)[0]).toBe("2026-10-17 Weekly Spend -300.00");
  });
});

// ⭐ (F5 round 3) The round-2 reviews' defects, each on the fixture. Platinum's
// balance below is read Wed 10/14 07:00 Central, posted rows only (Plaid's
// current balance); its truth on this fixture is 320 with every purchase posted.
describe("⭐ F5 round 3 · (1)(2) which rows the card's balance held is decided by the instant, one rule for purchases and credits", () => {
  const at = (iso: string) => new Date(iso);
  const READ = at("2026-10-14T07:00:00-05:00");
  const fuelPending: MissedRow = { key: "p11", on: "2026-10-13", desc: "FUEL STOP", amt: "-35.00", acct: "platinum", pending: true };
  const weekly = (sig: CashSignal, h: MissedHousehold) =>
    (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId && e.date <= "2026-10-17").map((e) => `${e.date} ${e.amount}`);
  const withoutFuel = (r: MissedRow) => r.key !== "p11";

  it("the 10/13 FUEL STOP 35 pending at the read (balance 285): outside it — 285 + 35 − 30 in flight = 290, 10/15 −200", async () => {
    const h = await household(true, { rows: withoutFuel, extra: [fuelPending], platinumBalance: { balance: "285.00", at: READ } });
    expect(weekly((await read(h)).sig, h)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
  });

  it("⭐ it posts LATER THE SAME DAY, dated the read day, as a new row stored after a read the Sync made (the real fetch): still outside — 290, 10/15 −200 (round 2: −165, H2 held 255 against 290 owed until the next Sync; round 3 through this real fetch: −210, the leftover p8pending put 60 back); (round 4) after a read with no transactions sync first (a debt's Refresh) the day decides: −165 until the next Sync", async () => {
    const more = {
      rows: withoutFuel,
      extra: [fuelPending, { key: "p11b", on: "2026-10-14", desc: "FUEL STOP", amt: "-35.00", acct: "platinum" as const, createdAt: at("2026-10-14T10:30:00-05:00") }],
    };
    const h = await household(true, more);
    // What the Sync's fetch keeps: every row pending on the card (the fixture's leftover p8pending too).
    expect(await liabilityRead(h, 285, true)).toEqual(["p11", "p8pending"]);
    const { sig } = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
    expect(`${sig.lowestProjected} @ ${sig.lowestDate}`).toBe("1870.00 @ 2026-10-17");
    const refreshed = await household(true, more);
    // (Round 6) The Refresh keeps its list too; a purchase on it keeps the day rule.
    expect(await liabilityRead(refreshed, 285, false)).toEqual(["p11", "p8pending"]);
    expect(weekly((await read(refreshed)).sig, refreshed)).toEqual(["2026-10-15 -165.00", "2026-10-17 -300.00"]);
  });

  it("⭐ Plaid's re-key posts it IN PLACE (same row, dated 10/14, stored 10/13): the ids pending at the read, kept with the balance, say it was outside — 10/15 −200; a read that kept none (before 0210) falls back to the day: −165 until the next Sync", async () => {
    const rekeyed: MissedRow = { key: "p11", on: "2026-10-14", desc: "FUEL STOP", amt: "-35.00", acct: "platinum", createdAt: at("2026-10-13T09:00:00-05:00") };
    const kept = await household(true, { rows: withoutFuel, extra: [rekeyed], platinumBalance: { balance: "285.00", at: READ, pendingAtRead: ["p11"] } });
    expect(weekly((await read(kept)).sig, kept)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
    const none = await household(true, { rows: withoutFuel, extra: [rekeyed], platinumBalance: { balance: "285.00", at: READ } });
    expect(weekly((await read(none)).sig, none)).toEqual(["2026-10-15 -165.00", "2026-10-17 -300.00"]);
  });

  it("control: a posted row H2 already held at the read is inside it (the 285 holds it) — 255 owed, 10/15 −165", async () => {
    const h = await household(true, {
      rows: withoutFuel,
      extra: [fuelPending, { key: "p11b", on: "2026-10-14", desc: "FUEL STOP", amt: "-35.00", acct: "platinum", createdAt: at("2026-10-14T05:00:00-05:00") }],
      platinumBalance: { balance: "285.00", at: READ },
    });
    expect(weekly((await read(h)).sig, h)).toEqual(["2026-10-15 -165.00", "2026-10-17 -300.00"]);
  });

  it("⭐ (2) the in-flight 10/13 −30 shows on the card as a PENDING credit: subtracted like a pending purchase is added — 320 − 30 = 290, 10/15 −200 (round 2: the credit read as inside the balance and the row as not in flight: 320, −210)", async () => {
    const h = await household(true, {
      extra: [{ key: "kP5", on: "2026-10-13", desc: "MOBILE PAYMENT - THANK YOU", amt: "30.00", acct: "platinum", pending: true }],
      platinumBalance: { balance: "320.00", at: READ },
    });
    const { sig, ledger } = await read(h);
    expect(weekly(sig, h)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
    // The pending checking row and its pending credit are one payment, allocated once.
    expect(ledger.paymentAllocations.get(h.txn.c4!)!.map((a) => a.cents)).toEqual([3000]);
    expect(ledger.paymentAllocations.has(h.txn.kP5!)).toBe(false);
  });

  it("⭐ (2) Platinum's 10/8 +150 credit still pending at the read (balance 300, posted only): 300 − 150 − 30 = 120, the same −30 on 10/15 as once it posts (balance 150) — round 2 held 270, 150 over", async () => {
    const pending = await household(true, {
      rows: (r) => r.key !== "kP4",
      extra: [{ key: "kP4", on: "2026-10-08", desc: "MOBILE PAYMENT - THANK YOU", amt: "150.00", acct: "platinum", pending: true }],
      platinumBalance: { balance: "300.00", at: READ },
    });
    const posted = await household(true, { platinumBalance: { balance: "150.00", at: READ } });
    for (const h of [pending, posted]) {
      const { sig } = await read(h);
      expect(weekly(sig, h)).toEqual(["2026-10-15 -30.00", "2026-10-17 -300.00"]);
      expect(sig.hookReserves!.filter((x) => x.hook === "weekly").reduce((s, x) => s + cents(x.incurred), 0)).toBe(12000);
    }
  });
});

describe("⭐ F5 round 3 · (4) a payment tagged to a debt not linked to the card that received it is counted once", () => {
  const MISSED_ROWS_C3 = MISSED_ROWS.find((r) => r.key === "c3")!;
  it("Platinum's 10/8 −150 tagged to Blue's debt (Blue's own 9/22 payment removed): the card's ledger wins — it pays Platinum's weeks, never Blue's 10/4 minimum; the same curve as untagged (round 2: it paid both, 10/15 had no Blue −45)", async () => {
    const noBluePayment = (r: MissedRow) => r.key !== "kB" && r.key !== "cBlue";
    const untagged = await household(false, { rows: noBluePayment });
    const tagged = await household(false, {
      rows: (r) => noBluePayment(r) && r.key !== "c3",
      extra: [{ ...MISSED_ROWS_C3, tag: "blue" }],
    });
    const a = await read(untagged);
    const b = await read(tagged);
    expect(events(b.sig)).toEqual(events(a.sig));
    expect(events(b.sig).filter((e) => e.startsWith("2026-10-15"))).toEqual([
      "2026-10-15 Weekly Spend -210.00 (2026-10-10 overdue_remainder_assumed_unpaid)",
      "2026-10-15 Monthly Spend -400.00 (2026-10-01 overdue_assumed_unpaid)",
      "2026-10-15 Amex Blue Cash minimum -45.00 (2026-10-04 overdue_assumed_unpaid)",
    ]);
    const blue = fates(tagged, b.ledger, `debt:${tagged.debts.blue}`).find((f) => f[0] === "2026-10-04")!;
    expect([blue[1], blue[2], blue[4]]).toEqual(["suggested", true, null]);
    expect(b.ledger.paymentAllocations.get(tagged.txn.c3!)!.map((x) => `${x.planKey.split("|")[1]} ${x.cents}`)).toEqual(["2026-10-03 13000", "2026-10-10 2000"]);
    expect(`${b.sig.lowestProjected} @ ${b.sig.lowestDate}`).toBe("1415.00 @ 2026-10-17");
  });
});

describe("⭐ F5 round 3 · (6) a payment dated before the window's first sized week paid the statement before it", () => {
  it("an 8/20 purchase paid on 9/1 (credit + checking row) never pays the 8/31 purchase of the 9/5 week: the curve is the same as without them — 10/15 −300 (round 2: −210, the 8/31 purchase read paid)", async () => {
    const pIn: MissedRow = { key: "pIn", on: "2026-08-31", desc: "CORNER MARKET", amt: "-100.00", acct: "platinum" };
    const pre: MissedRow[] = [
      { key: "pPre", on: "2026-08-20", desc: "AIRLINE", amt: "-600.00", acct: "platinum" },
      { key: "kPre", on: "2026-09-01", desc: "ONLINE PAYMENT - THANK YOU", amt: "600.00", acct: "platinum" },
      { key: "cPre", on: "2026-09-01", desc: "AMERICAN EXPRESS ACH PMT", amt: "-600.00", acct: "checking", category: "buffer" },
    ];
    const without = await household(false, { extra: [pIn] });
    const withPre = await household(false, { extra: [pIn, ...pre] });
    const a = await read(without);
    const b = await read(withPre);
    expect(events(b.sig)).toEqual(events(a.sig));
    expect(events(b.sig)[0]).toBe("2026-10-15 Weekly Spend -300.00 (2026-10-10 overdue_assumed_unpaid)");
    expect(b.ledger.paymentAllocations.has(withPre.txn.cPre!)).toBe(false);
    expect(b.ledger.paymentAllocations.has(withPre.txn.kPre!)).toBe(false);
  });
});

// ⭐ (F5 round 4) The round-3 reviews' defects, each through the REAL liability
// fetch (Plaid mocked), never a hand-set snapshot. Platinum's balance is read Wed
// 10/14 07:00; its truth on this fixture is 320 with every purchase posted (290
// owed after the 30 in flight) — 150 when it is read as the live shape.
describe("⭐ F5 round 4 · the balance the card read holds, through the real liability fetch", () => {
  const at = (iso: string) => new Date(iso);
  const weekly = (sig: CashSignal, h: MissedHousehold) =>
    (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId && e.date <= "2026-10-17").map((e) => `${e.date} ${e.amount}`);
  const held = (sig: CashSignal) => sig.hookReserves!.filter((x) => x.hook === "weekly").reduce((s, x) => s + cents(x.incurred), 0);
  const low = (sig: CashSignal) => `${sig.lowestProjected} @ ${sig.lowestDate}`;
  const kP4pend: MissedRow = { key: "kP4pend", on: "2026-10-07", desc: "MOBILE PAYMENT - THANK YOU", amt: "150.00", acct: "platinum", pending: true };

  it("⭐ (review defect 1) the Sync's fetch keeps the fixture's leftover pending copy (p8pending, beside its posted twin p8 of 10/9): p8 stays inside the balance — 320: 10/15 −200, 290 held; 150: −30, 120 held (round 3: −210 and −90, 60 over what the card owes)", async () => {
    for (const [balance, first, owed, lowPoint] of [
      [320, "2026-10-15 -200.00", 29000, "1870.00 @ 2026-10-17"],
      [150, "2026-10-15 -30.00", 12000, "2040.00 @ 2026-10-17"],
    ] as const) {
      const h = await household(true);
      expect(await liabilityRead(h, balance, true)).toEqual(["p8pending"]);
      const { sig } = await read(h);
      expect(weekly(sig, h)).toEqual([first, "2026-10-17 -300.00"]);
      expect(held(sig)).toBe(owed);
      expect(low(sig)).toBe(lowPoint);
      // Only the capped 10/15 figure moves; every later event is the main fixture's.
      expect(events(sig)).toEqual([`2026-10-15 Weekly Spend ${first.split(" ")[1]} (2026-10-10 overdue_remainder_assumed_unpaid)`, ...EVENTS_AFTER.slice(1)]);
    }
  });

  it("⭐ (review defect 1, credit) a leftover pending copy of the 10/8 +150 payment credit (10/7) kept at the read never subtracts the posted credit a second time — 320: −200, low 1,870 (round 3: −50, low 2,020: 150 of unpaid purchases gone); with p8pending too at 150: −30, low 2,040 (round 3: no 10/15 event, low 2,130)", async () => {
    const h = await household(true, { rows: (r) => r.key !== "p8pending", extra: [kP4pend] });
    expect(await liabilityRead(h, 320, true)).toEqual(["kP4pend"]);
    const a = (await read(h)).sig;
    expect(weekly(a, h)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
    expect(held(a)).toBe(29000);
    expect(low(a)).toBe("1870.00 @ 2026-10-17");
    const both = await household(true, { extra: [kP4pend] });
    expect(await liabilityRead(both, 150, true)).toEqual(["kP4pend", "p8pending"]);
    const b = (await read(both)).sig;
    expect(weekly(b, both)).toEqual(["2026-10-15 -30.00", "2026-10-17 -300.00"]);
    expect(held(b)).toBe(12000);
    expect(low(b)).toBe("2040.00 @ 2026-10-17");
  });

  it("⭐ (review defect 2; round 5) a debt's Refresh reads the balance with no transactions sync first: it keeps nothing; a payment credit stored before the read is inside it — 10/15 −30, 120 held, low 1,890; (round 5, never over) one stored AFTER it is outside, even when that balance already held it — the cap reads low until the next Sync: 0 held, 10/17 −210, low 2,010 (round 4: inside, −30; round 3: no 10/15 event, 10/17 −240)", async () => {
    // The 10/8 payment moved to 10/14: checking −150 stored 06:30, the card credit +150 stored 09:00.
    const moved = (credit: Date): MissedRow[] => [
      { key: "c5", on: "2026-10-14", desc: "American Express payment", amt: "-150.00", acct: "checking", category: "buffer", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", createdAt: at("2026-10-14T06:30:00-05:00") },
      { key: "kP5", on: "2026-10-14", desc: "MOBILE PAYMENT - THANK YOU", amt: "150.00", acct: "platinum", createdAt: credit },
    ];
    const without108 = (r: MissedRow) => r.key !== "kP4" && r.key !== "c3";
    // Stored before the read: the balance holds it — 10/15 −30, 120 held.
    const before = await household(true, { rows: without108, extra: moved(at("2026-10-14T06:45:00-05:00")) });
    expect(await liabilityRead(before, 150, false)).toEqual(["p8pending"]); // (round 6) kept, flagged not a Sync
    const a = (await read(before)).sig;
    expect(weekly(a, before)).toEqual(["2026-10-15 -30.00", "2026-10-17 -300.00"]);
    expect(held(a)).toBe(12000);
    expect(low(a)).toBe("1890.00 @ 2026-10-17");
    // ⚠️ (Round 5, both round-4 reviews: "never over") Stored after a read that kept no list, a payment credit is
    // OUTSIDE it: H2 cannot tell this one (the balance held it) from a payment made after the read. The cap reads
    // LOW until the next Sync — the side the owner allows: 10/15 no event, 10/17 −210 (0 held; round 4: −30, 120).
    const after = await household(true, { rows: without108, extra: moved(at("2026-10-14T09:00:00-05:00")) });
    expect(await liabilityRead(after, 150, false)).toEqual(["p8pending"]);
    const b = (await read(after)).sig;
    expect(weekly(b, after)).toEqual(["2026-10-17 -210.00"]);
    expect(held(b)).toBe(0);
    expect(low(b)).toBe("2010.00 @ 2026-10-17");
  });

  it("⭐ (round 4; round 5) after a read the Sync made — and (round 5) after a debt's Refresh too — a payment made LATER that day is outside the balance: read 470 at 07:00 (the 10/8 payment not made), then −150 from checking and +150 on the card stored 10:00 / 10:30 — 470 − 150 − 30 = 290 held, 10/15 −200 (round 3: −210, the leftover p8pending put 60 back; round 4 after a Refresh, by the day alone: 300 held, −210)", async () => {
    const later: MissedRow[] = [
      { key: "c5", on: "2026-10-14", desc: "American Express payment", amt: "-150.00", acct: "checking", category: "buffer", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", createdAt: at("2026-10-14T10:00:00-05:00") },
      { key: "kP5", on: "2026-10-14", desc: "MOBILE PAYMENT - THANK YOU", amt: "150.00", acct: "platinum", createdAt: at("2026-10-14T10:30:00-05:00") },
    ];
    const more = { rows: (r: MissedRow) => r.key !== "kP4" && r.key !== "c3", extra: later };
    const synced = await household(true, more);
    expect(await liabilityRead(synced, 470, true)).toEqual(["p8pending"]);
    const a = (await read(synced)).sig;
    expect(weekly(a, synced)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
    expect(held(a)).toBe(29000);
    // (Round 5, both reviews) after a debt's Refresh too: the credit stored after the read is outside — 290, −200
    // (round 4: by the day alone it read inside, 300 held against 290 owed, −210 until the next Sync).
    const refreshed = await household(true, more);
    expect(await liabilityRead(refreshed, 470, false)).toEqual(["p8pending"]);
    const b = (await read(refreshed)).sig;
    expect(weekly(b, refreshed)).toEqual(["2026-10-15 -200.00", "2026-10-17 -300.00"]);
    expect(held(b)).toBe(29000);
  });

  it("⭐ (review defect 5; round 6) a stale pending flag on a fetch with no transactions sync first: the 10/8 +150 credit still pending in H2 while the 320 already holds it, then posted in place by the next webhook sync — (round 6) it was pending at that read, so it reads outside: the cap reads LOW until the next Sync, the side the owner allows — 10/15 −50, low 2,020 (rounds 4–5: −200, low 1,870, at the cost of round 5's P1 over; round 3: the same −50)", async () => {
    const h = await household(true, {
      rows: (r) => r.key !== "p8pending" && r.key !== "kP4",
      extra: [{ key: "kP4", on: "2026-10-08", desc: "MOBILE PAYMENT - THANK YOU", amt: "150.00", acct: "platinum", pending: true }],
    });
    expect(await liabilityRead(h, 320, false)).toEqual(["kP4"]);
    // The next webhook sync posts it in place: same row, same store time.
    await db.update(transactionsTable).set({ pending: false }).where(eq(transactionsTable.id, h.txn.kP4!));
    const { sig } = await read(h);
    // 320 − 150 − 30 = 140 held (the card owes 290): low, never over.
    expect(weekly(sig, h)).toEqual(["2026-10-15 -50.00", "2026-10-17 -300.00"]);
    expect(held(sig)).toBe(14000);
    expect(low(sig)).toBe("2020.00 @ 2026-10-17");
  });
});

// ⭐ (F5 round 5) The round-4 reviews' two defects (both reviewers), each on the
// fixture: a payment made after a read that is not a Sync never puts the paid
// amount back ("never over"), and a mis-tagged card payment whose bank text does
// not name the issuer is still one payment.
describe("⭐ F5 round 5 · never over after any read; one payment, one obligation whatever the bank's text", () => {
  const at = (iso: string) => new Date(iso);
  const weekly = (sig: CashSignal, h: MissedHousehold) =>
    (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId && e.date <= "2026-10-17").map((e) => `${e.date} ${e.amount}`);
  const held = (sig: CashSignal) => sig.hookReserves!.filter((x) => x.hook === "weekly").reduce((s, x) => s + cents(x.incurred), 0);
  const low = (sig: CashSignal) => `${sig.lowestProjected} @ ${sig.lowestDate}`;

  it("⭐ (MEDIUM) a debt's Refresh reads Platinum at 150 at 07:00 (120 owed after the 30 in flight); the household pays 100 at 10:00 — checking −100 stored 10:00, card +100 stored 10:30: H2 holds 20, what the card owes — no 10/15 event, 10/17 −230, low 2,040, the same as after a Sync (round 4: 120 held, 10/15 −30, low 1,940 — the paid 100 came back until the next Sync)", async () => {
    const pay: MissedRow = { key: "c5", on: "2026-10-14", desc: "AMERICAN EXPRESS ACH PMT", amt: "-100.00", acct: "checking", category: "buffer", createdAt: at("2026-10-14T10:00:00-05:00") };
    const credit: MissedRow = { key: "kP5", on: "2026-10-14", desc: "ONLINE PAYMENT - THANK YOU", amt: "100.00", acct: "platinum", createdAt: at("2026-10-14T10:30:00-05:00") };
    for (const [afterSync, extra] of [
      [false, [pay, credit]],
      [true, [pay, credit]],
      [false, [pay]], // before the card credit arrives: the payment is in flight — the same 20
    ] as const) {
      const h = await household(true, { extra: [...extra] });
      await liabilityRead(h, 150, afterSync);
      const { sig, ledger } = await read(h);
      expect([afterSync, extra.length, weekly(sig, h)]).toEqual([afterSync, extra.length, ["2026-10-17 -230.00"]]);
      expect(held(sig)).toBe(2000);
      expect(low(sig)).toBe("2040.00 @ 2026-10-17");
      // The 100 is allocated once, to the oldest week still owing.
      expect(ledger.paymentAllocations.get(h.txn.c5!)!.map((x) => `${x.planKey.split("|")[1]} ${x.cents}`)).toEqual(["2026-10-10 10000"]);
    }
  });

  it("⭐ (LOW) Platinum's 10/8 −150 written 'ONLINE PMT CARD 7101' (no issuer name) and tagged to Blue's debt, Blue's own payment removed: Blue's ledger, read and without that credit, is the evidence — it pairs with Platinum's +150, pays Platinum's weeks and never Blue's 10/4 minimum; the same curve as untagged, low 1,415 (round 4: Blue's −45 left 10/15, low 1,460 — one payment counted twice)", async () => {
    const noBluePayment = (r: MissedRow) => r.key !== "kB" && r.key !== "cBlue";
    const c3 = MISSED_ROWS.find((r) => r.key === "c3")!;
    const untagged = await household(false, { rows: noBluePayment });
    const a = await read(untagged);
    for (const desc of ["ONLINE PMT CARD 7101", "AMERICAN EXP CO PMT"]) {
      const tagged = await household(false, { rows: (r) => noBluePayment(r) && r.key !== "c3", extra: [{ ...c3, desc, tag: "blue" }] });
      const b = await read(tagged);
      expect([desc, events(b.sig)]).toEqual([desc, events(a.sig)]);
      expect(events(b.sig)).toContain("2026-10-15 Amex Blue Cash minimum -45.00 (2026-10-04 overdue_assumed_unpaid)");
      expect(b.ledger.paymentAllocations.get(tagged.txn.c3!)!.map((x) => `${x.planKey.split("|")[1]} ${x.cents}`)).toEqual(["2026-10-03 13000", "2026-10-10 2000"]);
      expect(low(b.sig)).toBe("1415.00 @ 2026-10-17");
    }
  });
});

// ⭐ (F5 round 6) The round-5 reviews' defects, each on the fixture through the
// real liability fetch: a credit pending at a read that is not a Sync and posted
// in place after it (P1 / B), a refund after such a read (P2 / A), a correctly
// tagged payment still on its way (P3 / C), and a payment the bank writes with
// an issuer abbreviation still on its way (P4). Never over what the card owes.
describe("⭐ F5 round 6 · never over: credits pending at any read, refunds, payments still on their way", () => {
  const at = (iso: string) => new Date(iso);
  const weekly = (sig: CashSignal, h: MissedHousehold) =>
    (sig.events ?? []).filter((e) => e.itemId === h.weeklySpendId && e.date <= "2026-10-17").map((e) => `${e.date} ${e.amount}`);
  const held = (sig: CashSignal) => sig.hookReserves!.filter((x) => x.hook === "weekly").reduce((s, x) => s + cents(x.incurred), 0);
  const low = (sig: CashSignal) => `${sig.lowestProjected} @ ${sig.lowestDate}`;
  const paidBy = (h: MissedHousehold, ledger: ForecastLedger, key: string) =>
    (ledger.paymentAllocations.get(h.txn[key]!) ?? []).map((x) => `${x.planKey.split("|")[1]} ${x.cents}`);

  it("⭐ (MEDIUM, P1 / B) a payment credit PENDING at a debt's Refresh, posted in place after it (dated 10/14 or 10/13): still outside the 150 — 20 held, what the card owes; no 10/15 event, 10/17 −230, low 2,040 (round 5: once posted, 120 held vs 20 owed — 10/15 −30, 10/17 −300, low 1,940 until the next Sync)", async () => {
    const pay: MissedRow = { key: "c5", on: "2026-10-13", desc: "AMERICAN EXPRESS ACH PMT", amt: "-100.00", acct: "checking", category: "buffer", createdAt: at("2026-10-13T09:00:00-05:00") };
    const credit: MissedRow = { key: "kP5", on: "2026-10-13", desc: "ONLINE PAYMENT - THANK YOU", amt: "100.00", acct: "platinum", pending: true, createdAt: at("2026-10-13T15:00:00-05:00") };
    for (const postedOn of ["2026-10-14", "2026-10-13"]) {
      const h = await household(true, { extra: [pay, credit] });
      expect(await liabilityRead(h, 150, false)).toEqual(["kP5", "p8pending"]);
      const pendingStill = (await read(h)).sig;
      expect(weekly(pendingStill, h)).toEqual(["2026-10-17 -230.00"]);
      expect(held(pendingStill)).toBe(2000);
      // The webhook sync posts it in place: same row, same store time (10/13 15:00), dated the posting day.
      await db.update(transactionsTable).set({ pending: false, occurredOn: postedOn }).where(eq(transactionsTable.id, h.txn.kP5!));
      const { sig, ledger } = await read(h);
      expect([postedOn, weekly(sig, h)]).toEqual([postedOn, ["2026-10-17 -230.00"]]);
      expect(held(sig)).toBe(2000);
      expect(low(sig)).toBe("2040.00 @ 2026-10-17");
      expect(paidBy(h, ledger, "c5")).toEqual(["2026-10-10 10000"]);
    }
  });

  it("⭐ (LOW + MEDIUM, P2 / A) a REFUND stored after a debt's Refresh is outside the 150: +20 dated 10/14 (or 10/12) stored 10:30 — 100 held (150 − 20 − 30), 10/15 −30, low 2,040, as after a Sync (round 5: 120 held, 20 over — 10/15 −50, low 2,020); probe A's 40 stored 11:30 — 80 held, 10/15 −30, low 2,040 (round 5: −70, low 2,000)", async () => {
    for (const [afterSync, amt, on, stored, owed, first, lowPoint] of [
      [false, "20.00", "2026-10-14", "10:30", 10000, "2026-10-15 -30.00", "2040.00 @ 2026-10-17"],
      [false, "20.00", "2026-10-12", "10:30", 10000, "2026-10-15 -30.00", "2040.00 @ 2026-10-17"],
      [false, "40.00", "2026-10-14", "11:30", 8000, "2026-10-15 -30.00", "2040.00 @ 2026-10-17"],
      [true, "20.00", "2026-10-14", "10:30", 10000, "2026-10-15 -30.00", "2040.00 @ 2026-10-17"],
    ] as const) {
      const refund: MissedRow = { key: "rf2", on, desc: "GREEN GROCER REFUND", amt, acct: "platinum", createdAt: at(`2026-10-14T${stored}:00-05:00`) };
      const h = await household(true, { extra: [refund] });
      expect(await liabilityRead(h, 150, afterSync)).toEqual(["p8pending"]);
      const { sig } = await read(h);
      expect([afterSync, amt, on, weekly(sig, h)]).toEqual([afterSync, amt, on, [first, "2026-10-17 -300.00"]]);
      expect(held(sig)).toBe(owed);
      expect(low(sig)).toBe(lowPoint);
    }
  });

  it("⭐ (LOW, P3 / C) a payment correctly tagged to Platinum's debt, still on its way, is never Blue's same-cents credit: −100 on 10/13 tagged to Platinum, Blue +100 on 10/12 from an account H2 does not see, Sync read 150 — it pays the 10/10 week and is in flight: 20 held, 10/17 −230, low 2,040 (round 5: Blue's credit took it — 120 held vs 20 owed, 10/15 −30, low 1,940); probe C, unanswered, 330 — 150 held, 10/15 −60, low 1,460 (round 5: 300 held, −210, low 1,310)", async () => {
    for (const desc of ["ONLINE PMT CARD 7101", "AMERICAN EXPRESS ACH PMT"]) {
      const h = await household(true, {
        extra: [
          { key: "c5", on: "2026-10-13", desc, amt: "-100.00", acct: "checking", category: "buffer", tag: "platinum" },
          { key: "kB5", on: "2026-10-12", desc: "ONLINE PAYMENT - THANK YOU", amt: "100.00", acct: "blue" },
        ],
      });
      expect(await liabilityRead(h, 150, true)).toEqual(["p8pending"]);
      const { sig, ledger } = await read(h);
      expect([desc, weekly(sig, h)]).toEqual([desc, ["2026-10-17 -230.00"]]);
      expect(held(sig)).toBe(2000);
      expect(low(sig)).toBe("2040.00 @ 2026-10-17");
      expect(paidBy(h, ledger, "c5")).toEqual(["2026-10-10 10000"]);
    }
    // Probe C: the unanswered household, −150 'ONLINE PMT CARD 7101' on 10/12 tagged to Platinum, Blue +150 the same day; Sync 330.
    const c = await household(false, {
      extra: [
        { key: "c5", on: "2026-10-12", desc: "ONLINE PMT CARD 7101", amt: "-150.00", acct: "checking", category: "buffer", tag: "platinum" },
        { key: "kB5", on: "2026-10-12", desc: "ONLINE PAYMENT - THANK YOU", amt: "150.00", acct: "blue" },
      ],
    });
    expect(await liabilityRead(c, 330, true)).toEqual(["p8pending"]);
    const sc = (await read(c)).sig;
    expect(weekly(sc, c)).toEqual(["2026-10-15 -60.00", "2026-10-17 -300.00"]);
    expect(held(sc)).toBe(15000);
    expect(low(sc)).toBe("1460.00 @ 2026-10-17");
  });

  it("⭐ (LOW, P4) a payment the bank writes with an issuer abbreviation, still on its way to the card, pays its week and counts in flight: −100 'AMERICAN EXP CO PMT' / 'AMER EXP PMT' on 10/14, no card credit yet, Sync read 150 — 20 held, 10/17 −230, low 2,040, as 'AMERICAN EXPRESS ACH PMT' (round 5: it paid nothing and was not in flight — 120 held vs 20 owed, 10/15 −30, low 1,940)", async () => {
    for (const desc of ["AMERICAN EXPRESS ACH PMT", "AMERICAN EXP CO PMT", "AMER EXP PMT"]) {
      const h = await household(true, {
        extra: [{ key: "c5", on: "2026-10-14", desc, amt: "-100.00", acct: "checking", category: "buffer", createdAt: at("2026-10-14T08:00:00-05:00") }],
      });
      expect(await liabilityRead(h, 150, true)).toEqual(["p8pending"]);
      const { sig, ledger } = await read(h);
      expect([desc, weekly(sig, h)]).toEqual([desc, ["2026-10-17 -230.00"]]);
      expect(held(sig)).toBe(2000);
      expect(low(sig)).toBe("2040.00 @ 2026-10-17");
      expect(paidBy(h, ledger, "c5")).toEqual(["2026-10-10 10000"]);
    }
  });
});

describe("⭐ F5 round 4 · a loan payment never pairs as a card's payment (review defect 3)", () => {
  it("Platinum +450 on 10/8 paid from an account H2 does not see, and 'AUTO FINANCE PMT' −450 on 10/9 tagged to the car loan: the row pays the loan's 10/10 minimum and no card week — one payment, one outflow, low 1,550 (round 3: paired with Platinum's credit, the loan's minimum dragged −450 on 10/15, low 1,100)", async () => {
    const h = await household(false, {
      extra: [
        { key: "kLoanLike", on: "2026-10-08", desc: "ONLINE PAYMENT - THANK YOU", amt: "450.00", acct: "platinum" },
        { key: "cLoan", on: "2026-10-09", desc: "AUTO FINANCE PMT", amt: "-450.00", acct: "checking", category: "buffer" },
      ],
    });
    const [loan] = await db
      .insert(debtsTable)
      .values({
        userId: h.ownerUserId, householdId: h.householdId, name: "Car Loan", balance: "9000.00", originalBalance: "15000.00", apr: "0.0599",
        minPayment: "450.00", payment: "450.00", type: "auto_loan", status: "active", sortOrder: 2, dueDay: 10, createdAt: new Date("2026-08-01T12:00:00-05:00"),
      })
      .returning();
    await db.update(transactionsTable).set({ debtId: loan!.id }).where(eq(transactionsTable.id, h.txn.cLoan!));
    const { sig, ledger } = await read(h);
    const loanFate = fates(h, ledger, `debt:${loan!.id}`).find((f) => f[0] === "2026-10-10")!;
    expect([loanFate[1], loanFate[2], loanFate[3], loanFate[4]]).toEqual(["paid_on_evidence", false, "cLoan", "debt_tag"]);
    // Only next month's minimum is ahead; the 10/10 one is paid (round 3 also dragged "2026-10-15 Car Loan minimum -450.00 (2026-10-10 overdue_assumed_unpaid)").
    expect(events(sig).filter((e) => e.includes("Car Loan"))).toEqual(["2026-11-10 Car Loan minimum -450.00"]);
    expect(`${sig.lowestProjected} @ ${sig.lowestDate}`).toBe("1550.00 @ 2026-10-17");
    expect(ledger.paymentAllocations.get(h.txn.cLoan!)?.some((a) => a.planKey.startsWith(h.weeklySpendId)) ?? false).toBe(false);
  });
});
