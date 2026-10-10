// (PR-A) Categorization engine v2 — the batch, the queue, corrections, undo,
// learned rules, household isolation. Synthetic data only.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";

const OWNER = `pra-owner-${process.pid}-${randomUUID().slice(0, 8)}`;
const MEMBER = `pra-member-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `pra-other-${process.pid}-${randomUUID().slice(0, 8)}`;
const who = { userId: OWNER, householdId: "", ownerId: OWNER };

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = who.userId;
    req.actualUserId = who.userId;
    req.householdId = who.householdId;
    req.householdOwnerId = who.ownerId;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  categoryDecisionsTable,
  householdMembersTable,
  mappingRulesTable,
  merchantMemoryTable,
  plaidAccountsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import transactionsRouter from "../routes/transactions";
import categorizationRouter from "../routes/categorization";
import learnedRulesRouter from "../routes/learnedRules";
import { applyDecision, engineMayWrite, runCategorizationBatch, type HistoryRow } from "../lib/categorizer";
import { bandFor } from "../lib/categorizer/bands";
import { compareRules, loadUserRules, matchRule, type RuleRow } from "../lib/autoCategorize";
import { merchantSignature } from "../lib/merchantNameExtract";
import { effectiveFiling, type Filing } from "../lib/pendingFiling";
import { findSupersededPending } from "../lib/supersededPending";
import { isExcludedCategory, isTransferCategory } from "../lib/excludedCategory";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const api = Router();
api.use(transactionsRouter);
api.use(categorizationRouter);
api.use(learnedRulesRouter);
const { request } = createTestApp(api);

let HH = "";
let HH_OTHER = "";
const cats: Record<string, string> = {};

async function makeCat(hh: string, user: string, name: string, kind = "expense"): Promise<string> {
  const [c] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: user, householdId: hh, name: `${name} ${randomUUID().slice(0, 6)}`, kind })
    .returning({ id: budgetCategoriesTable.id });
  return c!.id;
}

let seq = 0;
async function txn(o: Partial<typeof transactionsTable.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const [r] = await db
    .insert(transactionsTable)
    .values({
      userId: OWNER,
      householdId: HH,
      occurredOn: "2026-09-10",
      description: `PRA ROW ${seq}`,
      amount: "-10.00",
      source: "plaid:bank",
      plaidAccountId: "acct-a",
      ...o,
    })
    .returning({ id: transactionsTable.id });
  return r!.id;
}

async function row(id: string) {
  const [r] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
  return r!;
}
async function decisionsOf(id: string) {
  return db
    .select()
    .from(categoryDecisionsTable)
    .where(eq(categoryDecisionsTable.transactionId, id))
    .orderBy(categoryDecisionsTable.createdAt, categoryDecisionsTable.id);
}
async function rule(pattern: string, categoryId: string, priority = 0, createdAt?: Date): Promise<string> {
  const [r] = await db
    .insert(mappingRulesTable)
    .values({ userId: OWNER, householdId: HH, pattern, matchType: "contains", categoryId, priority, ...(createdAt ? { createdAt } : {}) })
    .returning({ id: mappingRulesTable.id });
  return r!.id;
}
const run = (o: Parameters<typeof runCategorizationBatch>[1] = { trigger: "test", since: "2026-01-01" }) =>
  runCategorizationBatch(HH, o);

async function wipe(): Promise<void> {
  for (const h of [HH, HH_OTHER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.householdId, h));
    await db.delete(mappingRulesTable).where(eq(mappingRulesTable.householdId, h));
    await db.delete(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, h));
  }
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  await db
    .insert(householdMembersTable)
    .values({ userId: MEMBER, householdId: HH, role: "member" })
    .onConflictDoNothing();
  who.householdId = HH;
  for (const n of ["Groceries", "Dining", "Coffee", "Shopping", "Utilities"]) cats[n] = await makeCat(HH, OWNER, n);
  // (WP5c) An income category, for the direction guard.
  cats.Paycheck = await makeCat(HH, OWNER, "Paycheck", "income");
  // System Transfer category, created by the OWNER (member-session test).
  const [t] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: OWNER, householdId: HH, name: "Transfer", kind: "expense", excludeFromBudget: true })
    .onConflictDoNothing()
    .returning({ id: budgetCategoriesTable.id });
  cats.Transfer = t?.id ?? (await db.select().from(budgetCategoriesTable).where(and(eq(budgetCategoriesTable.householdId, HH), eq(budgetCategoriesTable.name, "Transfer"))))[0]!.id;
  cats.Other = await makeCat(HH_OTHER, OTHER, "Other household");
});

beforeEach(async () => {
  who.userId = OWNER;
  who.householdId = HH;
  who.ownerId = OWNER;
  await wipe();
});

describe("bands and tie-break (pure)", () => {
  it("auto ≥ 0.9, provisional 0.6–0.9, queue < 0.6", () => {
    expect(bandFor(1)).toBe("auto");
    expect(bandFor(0.9)).toBe("auto");
    expect(bandFor(0.8999)).toBe("provisional");
    expect(bandFor(0.6)).toBe("provisional");
    expect(bandFor(0.5999)).toBe("queue");
    expect(bandFor(0)).toBe("queue");
  });

  it("equal priorities: longer pattern, then older, then id — whatever order they arrive in", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-02-01T00:00:00Z");
    const rules: RuleRow[] = [
      { id: "b", pattern: "COFFEE", matchType: "contains", categoryId: "c-short", priority: 5, createdAt: t0 },
      { id: "a", pattern: "COFFEE BAR", matchType: "contains", categoryId: "c-long-new", priority: 5, createdAt: t1 },
      { id: "c", pattern: "BAR COFFEE", matchType: "contains", categoryId: "c-long-old", priority: 5, createdAt: t0 },
      { id: "d", pattern: "ZZZ", matchType: "contains", categoryId: "c-high", priority: 9, createdAt: t1 },
    ];
    for (let i = 0; i < 6; i += 1) {
      const shuffled = [...rules].sort(() => (i % 2 ? 1 : -1) * ((i * 7) % 3 - 1)).reverse();
      const sorted = [...shuffled].sort(compareRules);
      expect(sorted.map((r) => r.id)).toEqual(["d", "c", "a", "b"]);
      expect(matchRule("COFFEE BAR COFFEE 22", sorted)).toBe("c-long-old");
    }
  });

  it("loadUserRules returns the deterministic order from the database", async () => {
    const older = new Date("2026-01-01T00:00:00Z");
    await rule("SAME LEN B", cats.Dining!, 3, new Date("2026-03-01T00:00:00Z"));
    await rule("SAME LEN A", cats.Coffee!, 3, older);
    await rule("SAME", cats.Shopping!, 3, older);
    const rules = await loadUserRules(HH);
    expect(rules.map((r) => r.pattern)).toEqual(["SAME LEN A", "SAME LEN B", "SAME"]);
  });
});

describe("runCategorizationBatch", () => {
  it("writes auto, provisional and queue bands as specified", async () => {
    await rule("GREEN GROCER", cats.Groceries!); // 2 tokens → 0.95 auto
    await rule("NOODLE", cats.Dining!); // 1 token → 0.85 provisional
    const auto = await txn({ description: "GREEN GROCER 0042" });
    const prov = await txn({ description: "NOODLE HOUSE" });
    const queue = await txn({ description: "CAPITAL ONE MOBILE PYMT", amount: "-200.00" });
    const none = await txn({ description: "MYSTERY SHOP" });
    const out = await run();
    expect((await row(auto)).categoryId).toBe(cats.Groceries);
    expect((await row(auto)).categoryProvisional).toBe(false);
    expect((await row(prov)).categoryId).toBe(cats.Dining);
    expect((await row(prov)).categoryProvisional).toBe(true);
    expect((await row(queue)).categoryId).toBeNull();
    expect((await decisionsOf(queue))[0]!.band).toBe("queue");
    expect((await decisionsOf(none))).toHaveLength(0);
    expect(new Set(out.ambiguous)).toEqual(new Set([queue, none]));
    const review = await request("GET", "/categorization/review?limit=20");
    const items = (review.json as { items: { transactionId: string; band: string }[] }).items;
    expect(items.map((i) => i.transactionId).sort()).toEqual([prov, queue].sort());
    // is_transfer is never written by the engine (owner #666).
    expect((await row(queue)).isTransfer).toBe(false);
  });

  it("is idempotent: a second run records nothing and moves nothing", async () => {
    await rule("GREEN GROCER", cats.Groceries!);
    await rule("NOODLE", cats.Dining!);
    const ids = [
      await txn({ description: "GREEN GROCER 1" }),
      await txn({ description: "NOODLE BAR" }),
      await txn({ description: "AMEX EPAYMENT ACH PMT", amount: "-90.00" }),
      await txn({ description: "UNKNOWN PLACE" }),
      await txn({ description: "LOCKED ONE", categoryId: cats.Coffee, categoryLockedByUser: true }),
    ];
    await run();
    const snap = async () => ({
      cats: (await db.select().from(transactionsTable).where(inArray(transactionsTable.id, ids))).map((r) => [r.id, r.categoryId, r.categoryProvisional]).sort(),
      decisions: (await db.select().from(categoryDecisionsTable).where(inArray(categoryDecisionsTable.transactionId, ids))).length,
    });
    const first = await snap();
    const again = await run();
    expect(again.decisions).toHaveLength(0);
    expect(await snap()).toEqual(first);
    // (Round 2) A locked row is skipped entirely: no decision rows.
    expect(await decisionsOf(ids[4]!)).toHaveLength(0);
  });

  it("applyDecision refuses a locked row", async () => {
    const id = await txn({ description: "LOCKED", categoryId: cats.Coffee, categoryLockedByUser: true });
    const out = await applyDecision(
      HH,
      { id, categoryId: cats.Coffee!, refundOfTxnId: null },
      { source: "rule", categoryId: cats.Dining!, confidence: 0.95, explanation: "x" },
      "hash-locked",
    );
    expect(out).toEqual({ refused: "locked" });
    expect((await row(id)).categoryId).toBe(cats.Coffee);
    expect(await decisionsOf(id)).toHaveLength(0);
  });

  it("(round 2) a correction beats a rule for that merchant, but only for rows that arrive after it", async () => {
    await rule("MOSS", cats.Dining!); // a broad 1-word rule
    const older = await txn({ description: "MOSS CAFE", amount: "-4.00" });
    const corrected = await txn({ description: "MOSS CAFE", amount: "-5.00" });
    await run({ trigger: "test", txnIds: [older] });
    expect((await row(older)).categoryId).toBe(cats.Dining);
    expect((await request("PATCH", `/transactions/${corrected}`, { categoryId: cats.Coffee })).status).toBe(200);
    const fresh = await txn({ description: "MOSS CAFE", amount: "-6.00" });
    const otherMerchant = await txn({ description: "MOSS GARDEN SUPPLY", amount: "-30.00" });
    await run();
    const [d] = await decisionsOf(fresh);
    expect(d).toMatchObject({ source: "memory", categoryId: cats.Coffee, band: "provisional" });
    expect((await row(fresh)).categoryId).toBe(cats.Coffee);
    // The rule still files other merchants; the older row of this merchant is untouched.
    expect((await row(otherMerchant)).categoryId).toBe(cats.Dining);
    expect((await row(older)).categoryId).toBe(cats.Dining);
  });

  it("never moves a legacy category it has no decision for; re-decides its own only after 30 days", async () => {
    await rule("PIZZA PLACE", cats.Dining!);
    const legacy = await txn({ description: "PIZZA PLACE 9", categoryId: cats.Shopping });
    await run();
    expect((await row(legacy)).categoryId).toBe(cats.Shopping);
    const now = new Date("2026-10-07T12:00:00Z");
    const h = (daysAgo: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({
      id: "d", source: "rule", categoryId: "c1", band: "auto", resolution: null, undoneAt: null,
      createdAt: new Date(now.getTime() - daysAgo * 86_400_000), inputHash: "h", ...extra,
    });
    const r = { id: "t", categoryId: "c1", categoryLockedByUser: false };
    expect(engineMayWrite(r, [], { now })).toBe(false); // legacy
    expect(engineMayWrite(r, [h(10)], { now })).toBe(false); // too recent
    expect(engineMayWrite(r, [h(31)], { now })).toBe(true);
    expect(engineMayWrite(r, [h(31, { resolution: "accepted" })], { now })).toBe(false);
    expect(engineMayWrite(r, [h(31, { source: "user" })], { now })).toBe(false);
    expect(engineMayWrite({ ...r, categoryLockedByUser: true }, [h(31)], { now })).toBe(false);
    expect(engineMayWrite({ ...r, categoryId: null }, [], { now })).toBe(true);
    expect(engineMayWrite(r, [], { now, freshIds: new Set(["t"]) })).toBe(true);
  });

  it("links a refund to the purchase it returns, queue only", async () => {
    const buy = await txn({ description: "SHOPCO STORE 0101", amount: "-40.00", occurredOn: "2026-09-01", categoryId: cats.Shopping });
    const back = await txn({ description: "SHOPCO STORE 0101", amount: "15.00", occurredOn: "2026-09-20" });
    const tooBig = await txn({ description: "SHOPCO STORE 0101", amount: "55.00", occurredOn: "2026-09-21" });
    // (B6) The window is 90 days: 11/30 is the last day a 9/01 purchase is refunded.
    const tooLate = await txn({ description: "SHOPCO STORE 0101", amount: "5.00", occurredOn: "2026-12-01" });
    await run();
    expect((await row(back)).refundOfTxnId).toBe(buy);
    expect((await row(back)).categoryId).toBeNull();
    const [d] = await decisionsOf(back);
    expect(d).toMatchObject({ source: "refund", band: "queue", categoryId: cats.Shopping, explanation: "Refund of SHOPCO STORE 0101 on 2026-09-01" });
    expect((await row(tooBig)).refundOfTxnId).toBeNull();
    expect((await row(tooLate)).refundOfTxnId).toBeNull();
  });

  it("inherited: the stored filing equals the read-time effectiveFiling (write ≡ read)", async () => {
    await rule("CAFE LUMA", cats.Dining!);
    const t0 = new Date(Date.now() - 3_600_000);
    // Pair 1: pending filed BY HAND (Coffee, weekly); posted got the rule's Dining at insert.
    const q1 = await txn({ description: "CAFE LUMA", amount: "-8.00", pending: true, occurredOn: "2026-09-01", categoryId: cats.Coffee, isTransferUserOverridden: true, categoryLockedByUser: true, weeklyAllowance: true, weeklyBucket: "fun", createdAt: t0 });
    const p1 = await txn({ description: "CAFE LUMA", amount: "-9.50", occurredOn: "2026-09-02", categoryId: cats.Dining });
    // Pair 2: pending filed automatically (Groceries, monthly); posted bare, no rule.
    const q2 = await txn({ description: "FARM STAND 7", amount: "-20.00", pending: true, occurredOn: "2026-09-03", categoryId: cats.Groceries, monthlyAllowance: true, reimbursable: true, createdAt: t0, plaidAccountId: "acct-b" });
    const p2 = await txn({ description: "FARM STAND 7", amount: "-20.00", occurredOn: "2026-09-04", plaidAccountId: "acct-b" });
    // Pair 3: pending by hand, posted locked to something else → the posted row's own.
    const q3 = await txn({ description: "BOOK NOOK", amount: "-12.00", pending: true, occurredOn: "2026-09-05", categoryId: cats.Shopping, isTransferUserOverridden: true, createdAt: t0, plaidAccountId: "acct-c" });
    const p3 = await txn({ description: "BOOK NOOK", amount: "-12.00", occurredOn: "2026-09-05", categoryId: cats.Coffee, categoryLockedByUser: true, isTransferUserOverridden: true, plaidAccountId: "acct-c" });
    void q1; void q2; void q3;
    const posted = [p1, p2, p3];
    const readTime = async () => {
      const sup = await findSupersededPending(HH);
      const rows = await db.select().from(transactionsTable).where(inArray(transactionsTable.id, posted));
      return new Map(
        rows.map((r) => {
          const e = effectiveFiling(r as Filing & typeof r, sup.replacedBy.get(r.id), { uncategorizedIds: new Set() });
          return [r.id, [e.categoryId, e.weeklyAllowance, e.monthlyAllowance, e.unplannedAllowance, e.weeklyBucket, e.reimbursable, e.debtId, e.isTransfer]] as const;
        }),
      );
    };
    const before = await readTime();
    await run({ trigger: "sync", txnIds: posted, freshIds: new Set([p1, p2]) });
    const stored = new Map(
      (await db.select().from(transactionsTable).where(inArray(transactionsTable.id, posted))).map((r) => [
        r.id,
        [r.categoryId, r.weeklyAllowance, r.monthlyAllowance, r.unplannedAllowance, r.weeklyBucket, r.reimbursable, r.debtId, before.get(r.id)![7]],
      ] as const),
    );
    expect(stored).toEqual(before); // write ≡ read
    expect(await readTime()).toEqual(before); // and reading the written rows changes nothing
    expect((await row(p1)).categoryLockedByUser).toBe(true); // the lock travelled with the hand filing
    expect((await row(p1)).isTransfer).toBe(false);
    expect((await decisionsOf(p1)).map((d) => d.source)).toEqual(["inherited"]);
  });
});

describe("corrections, memory, undo", () => {
  it("PATCH with a category: a `user` decision + memory; no mapping rule; candidates reported, never applied", async () => {
    const older = await txn({ description: "LANTERN TEA 0001", amount: "-6.00" });
    const engineFiled = await txn({ description: "LANTERN TEA 0002", amount: "-7.00" });
    await rule("LANTERN TEA", cats.Dining!);
    await run({ trigger: "test", txnIds: [engineFiled] });
    expect((await row(engineFiled)).categoryId).toBe(cats.Dining);
    await db.delete(mappingRulesTable).where(eq(mappingRulesTable.householdId, HH));
    const target = await txn({ description: "LANTERN TEA 0003", amount: "-5.00" });
    const res = await request("PATCH", `/transactions/${target}`, { categoryId: cats.Coffee });
    expect(res.status).toBe(200);
    const body = res.json as { ruleAction: { kind: string }; repointedRules: unknown[]; retroactiveCandidates: { count: number; sample: { id: string }[] } };
    expect(body.ruleAction.kind).toBe("none");
    expect(body.repointedRules).toEqual([]);
    expect(body.retroactiveCandidates.count).toBe(2);
    expect(body.retroactiveCandidates.sample.map((s) => s.id).sort()).toEqual([older, engineFiled].sort());
    expect(await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.householdId, HH))).toHaveLength(0);
    const mem = await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, HH));
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({ signature: merchantSignature("LANTERN TEA 0003"), scope: "merchant", categoryId: cats.Coffee, count: 1 });
    expect((await decisionsOf(target)).map((d) => [d.source, d.categoryId])).toEqual([["user", cats.Coffee]]);
    // Retroactive is never implicit: not now, not after a run.
    await run();
    expect((await row(older)).categoryId).toBeNull();
    expect((await row(engineFiled)).categoryId).toBe(cats.Dining);
    // A NEW row of the merchant does follow the memory.
    const fresh = await txn({ description: "LANTERN TEA 0004", amount: "-6.50" });
    await run();
    expect((await row(fresh)).categoryId).toBe(cats.Coffee);
    expect((await row(fresh)).categoryProvisional).toBe(true); // count 1 → 0.75
    // Explicit request applies it, as user decisions.
    const applied = await request("POST", `/learned-rules/${mem[0]!.id}/apply-retroactively`);
    expect(applied.json).toEqual({ updated: 2 });
    expect((await row(older)).categoryId).toBe(cats.Coffee);
    expect((await row(older)).categoryLockedByUser).toBe(true);
    expect((await decisionsOf(older)).at(-1)!.source).toBe("user");
  });

  it("memory scope evolves: two accounts → merchant_account; two amount clusters → merchant_amount", async () => {
    const a1 = await txn({ description: "HARBOR DELI", amount: "-5.00", plaidAccountId: "acct-a" });
    const b1 = await txn({ description: "HARBOR DELI", amount: "-6.00", plaidAccountId: "acct-b" });
    await request("PATCH", `/transactions/${a1}`, { categoryId: cats.Coffee });
    await request("PATCH", `/transactions/${b1}`, { categoryId: cats.Dining });
    const deli = await db.select().from(merchantMemoryTable).where(and(eq(merchantMemoryTable.householdId, HH), eq(merchantMemoryTable.signature, "harbor deli")));
    expect(deli.filter((m) => m.scope === "merchant_account").map((m) => [m.plaidAccountId, m.categoryId]).sort()).toEqual(
      [["acct-a", cats.Coffee], ["acct-b", cats.Dining]].sort(),
    );
    const s1 = await txn({ description: "CORNER MART", amount: "-5.00" });
    const s2 = await txn({ description: "CORNER MART", amount: "-80.00" });
    await request("PATCH", `/transactions/${s1}`, { categoryId: cats.Coffee });
    await request("PATCH", `/transactions/${s2}`, { categoryId: cats.Groceries });
    const mart = await db.select().from(merchantMemoryTable).where(and(eq(merchantMemoryTable.householdId, HH), eq(merchantMemoryTable.signature, "corner mart"), eq(merchantMemoryTable.scope, "merchant_amount")));
    expect(mart.map((m) => [m.amountBandLo, m.categoryId]).sort()).toEqual([["0.00", cats.Coffee], ["42.51", cats.Groceries]].sort());
    // New rows follow the most specific memory.
    const nb = await txn({ description: "HARBOR DELI", amount: "-7.00", plaidAccountId: "acct-b" });
    const small = await txn({ description: "CORNER MART", amount: "-6.00" });
    const big = await txn({ description: "CORNER MART", amount: "-95.00" });
    await run();
    expect((await row(nb)).categoryId).toBe(cats.Dining);
    expect((await row(small)).categoryId).toBe(cats.Coffee);
    expect((await row(big)).categoryId).toBe(cats.Groceries);
    // Same account, overlapping amounts: the latest correction wins.
    const o1 = await txn({ description: "VALLEY KIOSK", amount: "-10.00" });
    const o2 = await txn({ description: "VALLEY KIOSK", amount: "-11.00" });
    await request("PATCH", `/transactions/${o1}`, { categoryId: cats.Coffee });
    await request("PATCH", `/transactions/${o2}`, { categoryId: cats.Dining });
    const kiosk = await db.select().from(merchantMemoryTable).where(and(eq(merchantMemoryTable.householdId, HH), eq(merchantMemoryTable.signature, "valley kiosk")));
    expect(kiosk.map((m) => [m.scope, m.categoryId])).toEqual([["merchant", cats.Dining]]);
  });

  it("undo is exact: an engine decision, and a correction (lock, provisional and memory restored)", async () => {
    await rule("ORBIT FUEL", cats.Utilities!);
    await rule("MOSS", cats.Dining!);
    const a = await txn({ description: "ORBIT FUEL 12" });
    const p = await txn({ description: "MOSS CAFE" });
    const shape = async (id: string) => {
      const r = await row(id);
      return { categoryId: r.categoryId, categoryProvisional: r.categoryProvisional, categoryLockedByUser: r.categoryLockedByUser };
    };
    const beforeA = await shape(a);
    await run();
    const [da] = await decisionsOf(a);
    expect((await request("POST", `/category-decisions/${da!.id}/undo`)).status).toBe(200);
    expect(await shape(a)).toEqual(beforeA);
    expect((await decisionsOf(a))[0]!.undoneAt).not.toBeNull();
    expect((await request("POST", `/category-decisions/${da!.id}/undo`)).status).toBe(409);
    // Provisional row corrected through the queue, then the correction undone.
    const beforeCorrection = await shape(p);
    expect(beforeCorrection).toEqual({ categoryId: cats.Dining, categoryProvisional: true, categoryLockedByUser: false });
    const [dp] = await decisionsOf(p);
    const corr = await request("POST", `/categorization/review/${dp!.id}/correct`, { categoryId: cats.Coffee });
    expect(corr.status).toBe(200);
    const userDecisionId = (corr.json as { userDecisionId: string }).userDecisionId;
    expect(await shape(p)).toEqual({ categoryId: cats.Coffee, categoryProvisional: false, categoryLockedByUser: true });
    const [mem] = await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, HH));
    expect(mem!.disabledAt).toBeNull();
    expect((await request("POST", `/category-decisions/${userDecisionId}/undo`)).status).toBe(200);
    expect(await shape(p)).toEqual({ ...beforeCorrection, categoryProvisional: false });
    const [memAfter] = await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.id, mem!.id));
    expect(memAfter!.disabledAt).not.toBeNull();
    // An automatic decision cannot be undone on a row a person has since locked.
    const b = await txn({ description: "ORBIT FUEL 13" });
    await run();
    const [db1] = await decisionsOf(b);
    await request("PATCH", `/transactions/${b}`, { categoryId: cats.Shopping });
    expect((await request("POST", `/category-decisions/${db1!.id}/undo`)).status).toBe(409);
    expect((await row(b)).categoryId).toBe(cats.Shopping);
  });

  it("accept locks the suggestion; skip writes nothing; a resolved decision answers 409", async () => {
    await rule("MOSS", cats.Dining!);
    const p = await txn({ description: "MOSS CAFE" });
    const q = await txn({ description: "MOSS BAR" });
    await run();
    const [dp] = await decisionsOf(p);
    const [dq] = await decisionsOf(q);
    expect((await request("POST", `/categorization/review/${dp!.id}/accept`)).status).toBe(200);
    expect(await row(p)).toMatchObject({ categoryId: cats.Dining, categoryLockedByUser: true, categoryProvisional: false });
    expect((await request("POST", `/categorization/review/${dq!.id}/skip`)).status).toBe(200);
    expect(await row(q)).toMatchObject({ categoryId: cats.Dining, categoryLockedByUser: false });
    expect((await request("POST", `/categorization/review/${dq!.id}/accept`)).status).toBe(409);
    const left = (await request("GET", "/categorization/review")).json as { items: unknown[]; total: number };
    expect(left.total).toBe(0);
  });

  it("locked rows never move under a random sequence of corrections, runs, undos and retroactive applies", async () => {
    await rule("RIVER", cats.Dining!);
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(await txn({ description: `RIVER STORE ${i % 3}`, amount: `-${5 + i}.00` }));
    const choices = [cats.Groceries!, cats.Dining!, cats.Coffee!, cats.Shopping!];
    let seed = 20261007;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    const expected = new Map<string, string>();
    for (let step = 0; step < 40; step += 1) {
      const op = rnd(5);
      const id = ids[rnd(ids.length)]!;
      if (op === 0) {
        const c = choices[rnd(choices.length)]!;
        await request("PATCH", `/transactions/${id}`, { categoryId: c });
        expected.set(id, c);
      } else if (op === 1) {
        await run();
      } else if (op === 2) {
        const auto = (await decisionsOf(id)).filter((d) => d.source !== "user" && d.source !== "locked" && !d.undoneAt);
        if (auto.length) await request("POST", `/category-decisions/${auto[0]!.id}/undo`);
      } else if (op === 3) {
        const mem = await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, HH));
        if (mem.length) await request("POST", `/learned-rules/${mem[rnd(mem.length)]!.id}/apply-retroactively`);
        for (const r of await db.select().from(transactionsTable).where(inArray(transactionsTable.id, ids))) {
          if (r.categoryLockedByUser && !expected.has(r.id)) expected.set(r.id, r.categoryId!);
        }
      } else {
        const open = (await request("GET", "/categorization/review?limit=50")).json as { items: { decisionId: string; transactionId: string }[] };
        const item = open.items[rnd(Math.max(open.items.length, 1))];
        if (item) {
          const c = choices[rnd(choices.length)]!;
          await request("POST", `/categorization/review/${item.decisionId}/correct`, { categoryId: c });
          expected.set(item.transactionId, c);
        }
      }
      for (const [lockedId, c] of expected) {
        const r = await row(lockedId);
        expect(r.categoryLockedByUser).toBe(true);
        expect(r.categoryId).toBe(c);
      }
    }
    expect(expected.size).toBeGreaterThan(0);
  });
});

describe("households and members", () => {
  it("another household's decision ids and learned rules answer 404", async () => {
    await rule("GREEN GROCER", cats.Groceries!);
    const id = await txn({ description: "GREEN GROCER 5" });
    await run();
    const [d] = await decisionsOf(id);
    who.householdId = HH_OTHER;
    who.userId = OTHER;
    who.ownerId = OTHER;
    expect((await request("POST", `/category-decisions/${d!.id}/undo`)).status).toBe(404);
    expect((await request("POST", `/categorization/review/${d!.id}/accept`)).status).toBe(404);
    expect((await request("POST", `/categorization/review/${d!.id}/correct`, { categoryId: cats.Other })).status).toBe(404);
    expect((await request("GET", `/transactions/${id}/splits`)).status).toBe(404);
    expect(((await request("GET", "/categorization/review")).json as { total: number }).total).toBe(0);
    expect((await row(id)).categoryId).toBe(cats.Groceries);
  });

  it("a member can correct; only the owner can run the batch", async () => {
    await rule("MOSS", cats.Dining!);
    const p = await txn({ description: "MOSS CAFE" });
    await run();
    const [dp] = await decisionsOf(p);
    who.userId = MEMBER;
    expect((await request("POST", "/categorization/run", {})).status).toBe(403);
    const res = await request("POST", `/categorization/review/${dp!.id}/correct`, { categoryId: cats.Coffee });
    expect(res.status).toBe(200);
    expect(await row(p)).toMatchObject({ categoryId: cats.Coffee, categoryLockedByUser: true });
    who.userId = OWNER;
    expect((await request("POST", "/categorization/run", { since: "2026-01-01" })).status).toBe(200);
  });

  it("system-category lookups are household-scoped, so a member's pick of the owner's Transfer category works", async () => {
    expect(await isTransferCategory(HH, cats.Transfer)).toBe(true);
    expect(await isExcludedCategory(HH, cats.Transfer)).toBe(true);
    expect(await isTransferCategory(HH_OTHER, cats.Transfer)).toBe(false);
    who.userId = MEMBER;
    const id = await txn({ description: "MOVE TO SAVINGS" });
    const res = await request("PATCH", `/transactions/${id}`, { categoryId: cats.Transfer });
    expect(res.status).toBe(200);
    expect((await row(id)).isTransfer).toBe(true);
    // System categories teach no memory.
    expect(await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, HH))).toHaveLength(0);
  });
});

// ── (WP5c) direction guard ─────────────────────────────────────────────────
// A memory, rule or recurring pick that would file money in under an expense
// category, or money out under an income one, is a QUEUE decision that still
// names the category and the rule / memory / item. Card credits, checking
// refunds, reimbursables, transfers and card payments are unchanged.
describe("(WP5c) the direction guard", () => {
  const CARD = `acct-wp5c-card-${randomUUID().slice(0, 8)}`;
  const MONEY_IN = "Money in, but this would file it under an expense category.";
  const MONEY_OUT = "Money out, but this would file it under an income category.";

  async function memory(signature: string, categoryId: string, count = 3): Promise<string> {
    const [m] = await db
      .insert(merchantMemoryTable)
      .values({ householdId: HH, signature, scope: "merchant", categoryId, count, createdAt: new Date("2026-01-01T00:00:00Z") })
      .returning({ id: merchantMemoryTable.id });
    return m!.id;
  }

  beforeAll(async () => {
    await db
      .insert(plaidAccountsTable)
      .values({ userId: OWNER, householdId: HH, itemId: randomUUID(), accountId: CARD, type: "credit", subtype: "credit card" })
      .onConflictDoNothing();
  });
  beforeEach(async () => {
    await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, HH));
  });

  it("a rule that would file a paycheck under Dining queues it: nothing written, the rule named, the model may still be asked", async () => {
    const ruleId = await rule("BIGCO", cats.Dining!);
    const pay = await txn({ description: "BIGCO PAYROLL PPD ID 4455", amount: "2500.00" });
    const cafe = await txn({ description: "BIGCO CAFE 0042", amount: "-8.50" });
    const out = await run();

    expect((await row(pay)).categoryId).toBeNull();
    const [d] = await decisionsOf(pay);
    expect(d).toMatchObject({ source: "rule", band: "queue", categoryId: cats.Dining, ruleId, explanation: MONEY_IN });
    expect(Number(d!.confidence)).toBeCloseTo(0.5, 3);
    expect(out.ambiguous).toContain(pay);
    // The same rule still files the cafeteria charge: money out, an expense category.
    expect((await row(cafe)).categoryId).toBe(cats.Dining);
    expect((await decisionsOf(cafe))[0]).toMatchObject({ source: "rule", band: "provisional", explanation: "Matched one of your rules." });
    // It waits in the review queue with the rule's category as the suggestion.
    const review = await request("GET", "/categorization/review?limit=20");
    const items = (review.json as { items: { transactionId: string; suggestedCategoryId: string | null; explanation: string }[] }).items;
    expect(items.find((i) => i.transactionId === pay)).toMatchObject({ suggestedCategoryId: cats.Dining, explanation: MONEY_IN });
    // A second run records nothing new.
    expect((await run()).decisions).toHaveLength(0);
  });

  it("a memory that would file a cafeteria charge under the paycheck queues it, naming the memory", async () => {
    const memoryId = await memory(merchantSignature("BIGCO CAFE 0042"), cats.Paycheck!);
    const cafe = await txn({ description: "BIGCO CAFE 0042", amount: "-8.50" });
    await run();
    expect((await row(cafe)).categoryId).toBeNull();
    expect((await decisionsOf(cafe))[0]).toMatchObject({ source: "memory", band: "queue", categoryId: cats.Paycheck, memoryId, explanation: MONEY_OUT });
  });

  it("a recurring income item that would file money out under income queues it, naming the item", async () => {
    const [item] = await db
      .insert(recurringItemsTable)
      .values({ userId: OWNER, householdId: HH, name: "Bigco Payroll", kind: "income", amount: "2500.00", categoryId: cats.Paycheck, active: "true" })
      .returning({ id: recurringItemsTable.id });
    const reversal = await txn({ description: "BIGCO PAYROLL REVERSAL", amount: "-2500.00" });
    const deposit = await txn({ description: "BIGCO PAYROLL", amount: "2500.00" });
    await run();
    expect((await row(reversal)).categoryId).toBeNull();
    expect((await decisionsOf(reversal))[0]).toMatchObject({ source: "recurring", band: "queue", categoryId: cats.Paycheck, recurringItemId: item!.id, explanation: MONEY_OUT });
    // The deposit itself goes where the item says: money in, an income category.
    expect((await row(deposit)).categoryId).toBe(cats.Paycheck);
  });

  it("must not change: a credit on ANY card (not only Amex) filed by memory stays filed; the same credit on checking is queued", async () => {
    await memory(merchantSignature("BIGCO STORE 77"), cats.Shopping!);
    const onCard = await txn({ description: "BIGCO STORE 77", amount: "20.00", source: "plaid:chase", plaidAccountId: CARD });
    const onChecking = await txn({ description: "BIGCO STORE 77", amount: "20.00" });
    await run();
    expect((await row(onCard)).categoryId).toBe(cats.Shopping);
    expect((await decisionsOf(onCard))[0]).toMatchObject({ source: "memory", band: "auto" });
    expect((await row(onChecking)).categoryId).toBeNull();
    expect((await decisionsOf(onChecking))[0]).toMatchObject({ source: "memory", band: "queue", explanation: MONEY_IN });
  });

  it("must not change: a checking refund, a reimbursable credit, a transfer and a card payment are filed as before", async () => {
    await rule("BIGCO", cats.Dining!);
    const refund = await txn({ description: "BIGCO REFUND", amount: "5.00" });
    const reimbursed = await txn({ description: "BIGCO PAYROLL PPD ID 1", amount: "40.00", reimbursable: true });
    const transfer = await txn({ description: "BIGCO PAYROLL PPD ID 2", amount: "60.00", isTransfer: true });
    const cardPayment = await txn({ description: "BIGCO PAYROLL PPD ID 3", amount: "70.00", isExternalCardPayment: true });
    await run();
    for (const id of [refund, reimbursed, transfer, cardPayment]) {
      expect((await row(id)).categoryId, id).toBe(cats.Dining);
      expect((await decisionsOf(id))[0]!.explanation, id).toBe("Matched one of your rules.");
    }
  });
});
