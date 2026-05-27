import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  budgetCategoriesTable,
  db,
  debtBalanceHistoryTable,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { dedupePlaidAccountsForUser } from "../lib/dedupePlaidAccounts";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `dedupe-amex-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db
    .delete(debtBalanceHistoryTable)
    .where(eq(debtBalanceHistoryTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});
afterAll(cleanup);

describe("dedupePlaidAccountsForUser — Amex three-card scenario (#416)", () => {
  it("when both survivor and loser already have a debt row, merges debts (deletes loser-debt, repoints its transactions to survivor-debt) instead of hitting debts_plaid_account_unique", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `amex-item-merge-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "American Express",
        institutionSlug: "american-express",
      })
      .returning();
    // Two duplicate plaid_accounts rows for the same physical card,
    // each already linked to its own debt row (the worst-case heal
    // shape).
    const [survivorAcct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: `acct-survivor-${suffix}`,
        name: "Amex Gold",
        mask: "1001",
        type: "credit",
        subtype: "credit card",
      })
      .returning();
    const [loserAcct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: `acct-loser-${suffix}`,
        name: "Amex Gold",
        mask: "1001",
        type: "credit",
        subtype: "credit card",
      })
      .returning();
    const [survivorDebt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Amex Gold",
        balance: "500",
        plaidAccountId: survivorAcct!.id,
      })
      .returning();
    const [loserDebt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Amex Gold (dupe)",
        balance: "750",
        plaidAccountId: loserAcct!.id,
      })
      .returning();
    // A manual transaction attached to the loser-debt that must be
    // repointed onto the survivor-debt as part of the merge.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-04-15",
      description: "Manual on dupe debt",
      amount: "-25.00",
      source: "manual",
      debtId: loserDebt!.id,
    });
    // Balance history rows on BOTH debts: a unique day on the loser
    // (must survive the merge by being repointed to the survivor),
    // plus a day that exists on both (the survivor's row wins; the
    // loser's row cascades away and we accept that).
    await db.insert(debtBalanceHistoryTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        debtId: survivorDebt!.id,
        recordedOn: "2026-03-01",
        balance: "500.00",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        debtId: loserDebt!.id,
        recordedOn: "2026-03-15",
        balance: "750.00",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        debtId: loserDebt!.id,
        recordedOn: "2026-03-01",
        balance: "999.99",
      },
    ]);
    // A budget_category linked only to the loser-debt: must be
    // promoted onto the survivor-debt instead of cascading away.
    const [loserCategory] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Amex dupe cat ${suffix}`,
        kind: "expense",
        groupName: "Debt",
        sourceKind: "debt",
        debtId: loserDebt!.id,
      })
      .returning();

    try {
      const report = await dedupePlaidAccountsForUser(TEST_USER);
      expect(report.duplicatesRemoved).toBeGreaterThanOrEqual(1);

      // Exactly one plaid_account row + one debt row remain for ··1001
      // — the dedupe routine never violated debts_plaid_account_unique.
      const accts = await db
        .select()
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, TEST_USER));
      const oneOhOne = accts.filter((a) => a.mask === "1001");
      expect(oneOhOne).toHaveLength(1);

      const debts = await db
        .select()
        .from(debtsTable)
        .where(eq(debtsTable.userId, TEST_USER));
      expect(debts).toHaveLength(1);
      // The surviving debt is one of the originals (which one depends
      // on which plaid_account row the dedupe picked as survivor).
      expect([survivorDebt!.id, loserDebt!.id]).toContain(debts[0].id);

      // The manual transaction was repointed to whichever debt
      // survived the merge — never lost.
      const txns = await db
        .select()
        .from(transactionsTable)
        .where(eq(transactionsTable.userId, TEST_USER));
      expect(txns).toHaveLength(1);
      expect(txns[0].debtId).toBe(debts[0].id);

      // Balance history: the unique loser-day was repointed onto
      // the survivor-debt; the survivor's own day was preserved.
      // Total rows on the survivor: 2 (3-01 from survivor, 3-15
      // repointed from loser). Loser's 3-01 row collided and
      // cascaded away — that is the documented merge behavior.
      const history = await db
        .select()
        .from(debtBalanceHistoryTable)
        .where(eq(debtBalanceHistoryTable.userId, TEST_USER));
      expect(history).toHaveLength(2);
      for (const row of history) {
        expect(row.debtId).toBe(debts[0].id);
      }
      const days = history.map((r) => String(r.recordedOn)).sort();
      expect(days).toEqual(["2026-03-01", "2026-03-15"]);

      // Budget category linked to the loser-debt was promoted onto
      // the survivor-debt instead of cascading away.
      const cats = await db
        .select()
        .from(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.userId, TEST_USER));
      expect(cats).toHaveLength(1);
      expect(cats[0].id).toBe(loserCategory!.id);
      expect(cats[0].debtId).toBe(debts[0].id);
    } finally {
      await cleanup();
    }
  });


  it("collapses duplicate per-card Amex rows under one item: three cards, one duplicate per card → exactly three survivors, no transactions or debts lost", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `amex-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "American Express",
        institutionSlug: "american-express",
      })
      .returning();

    // Three physical cards, each with a duplicate row representing a
    // second `plaid_accounts` insert that happened on a re-link before
    // the dedupe guard landed. The newer row should win as the survivor
    // for each (institutionName, mask) group.
    const baseTime = Date.now();
    const makeAcct = async (
      mask: string,
      tag: "old" | "new",
      offsetMs: number,
    ) => {
      const [row] = await db
        .insert(plaidAccountsTable)
        .values({
          userId: TEST_USER,
          householdId: TEST_HOUSEHOLD_ID,
          itemId: item!.id,
          accountId: `amex-${mask}-${tag}-${suffix}`,
          name: `Amex ··${mask}`,
          mask,
          type: "credit",
          subtype: "credit card",
          createdAt: new Date(baseTime + offsetMs),
        })
        .returning();
      return row!;
    };

    const card1Old = await makeAcct("1001", "old", -30_000);
    const card1New = await makeAcct("1001", "new", -10_000);
    const card2Old = await makeAcct("2002", "old", -29_000);
    const card2New = await makeAcct("2002", "new", -9_000);
    const card3Old = await makeAcct("3003", "old", -28_000);
    const card3New = await makeAcct("3003", "new", -8_000);

    // One transaction per *original* (loser) row to prove they get
    // repointed onto the survivor without being lost or re-dated.
    const seedTxn = async (
      plaidAccountIdText: string,
      tag: string,
      amount: string,
    ) => {
      await db.insert(transactionsTable).values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-01",
        occurredAt: new Date("2026-05-01T12:00:00Z").toISOString(),
        description: `amex-${suffix}-${tag}`,
        amount,
        account: "American Express",
        source: "plaid:amex",
        plaidTransactionId: `amex-${suffix}-${tag}`,
        plaidAccountId: plaidAccountIdText,
      });
    };
    await seedTxn(card1Old.accountId, "c1", "100.00");
    await seedTxn(card2Old.accountId, "c2", "200.00");
    await seedTxn(card3Old.accountId, "c3", "300.00");
    // And one on each survivor too so the totals are clearly visible.
    await seedTxn(card1New.accountId, "c1n", "50.00");

    // One debt per loser row — each must be repointed onto its own
    // card's survivor (NOT collapsed across cards).
    const [d1] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Amex ··1001 (${suffix})`,
        balance: "1000.00",
        plaidAccountId: card1Old.id,
      })
      .returning();
    const [d2] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Amex ··2002 (${suffix})`,
        balance: "2000.00",
        plaidAccountId: card2Old.id,
      })
      .returning();
    const [d3] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Amex ··3003 (${suffix})`,
        balance: "3000.00",
        plaidAccountId: card3Old.id,
      })
      .returning();

    const report = await dedupePlaidAccountsForUser(TEST_USER);
    // Three groups (one per card) each with one duplicate.
    expect(report.groupsScanned).toBe(3);
    expect(report.duplicatesRemoved).toBe(3);
    // Three loser-attached transactions repointed onto the three
    // survivors (the one already on a survivor is untouched).
    expect(report.transactionsRepointed).toBe(3);
    expect(report.debtsRepointed).toBe(3);

    // Exactly three Plaid account rows survive: one per physical card.
    const remaining = await db
      .select({
        id: plaidAccountsTable.id,
        mask: plaidAccountsTable.mask,
        accountId: plaidAccountsTable.accountId,
      })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(3);
    expect(remaining.map((r) => r.id).sort()).toEqual(
      [card1New.id, card2New.id, card3New.id].sort(),
    );
    // Each card represented exactly once in the survivor set.
    expect(new Set(remaining.map((r) => r.mask))).toEqual(
      new Set(["1001", "2002", "3003"]),
    );

    // No transactions lost; every txn now points at its card's survivor.
    const txns = await db
      .select({
        plaidAccountId: transactionsTable.plaidAccountId,
        amount: transactionsTable.amount,
        occurredOn: transactionsTable.occurredOn,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(txns).toHaveLength(4);
    const survivorIds = new Set(
      [card1New, card2New, card3New].map((c) => c.accountId),
    );
    for (const t of txns) {
      expect(survivorIds.has(t.plaidAccountId ?? "")).toBe(true);
      expect(t.occurredOn).toBe("2026-05-01");
    }

    // Each debt now points at its card's survivor (one debt per card).
    const debtsAfter = await db
      .select({
        id: debtsTable.id,
        plaidAccountId: debtsTable.plaidAccountId,
        balance: debtsTable.balance,
      })
      .from(debtsTable)
      .where(eq(debtsTable.userId, TEST_USER));
    const byId = new Map(debtsAfter.map((d) => [d.id, d] as const));
    expect(byId.get(d1!.id)!.plaidAccountId).toBe(card1New.id);
    expect(byId.get(d2!.id)!.plaidAccountId).toBe(card2New.id);
    expect(byId.get(d3!.id)!.plaidAccountId).toBe(card3New.id);
    // Balances unchanged (no cross-card collapse).
    expect(Number(byId.get(d1!.id)!.balance)).toBeCloseTo(1000, 2);
    expect(Number(byId.get(d2!.id)!.balance)).toBeCloseTo(2000, 2);
    expect(Number(byId.get(d3!.id)!.balance)).toBeCloseTo(3000, 2);
  });

  it("(#754) two genuinely different Amex cards sharing a mask are NOT collapsed: Platinum ··1009 and Delta Gold ··1009 both survive with their transactions intact", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `amex-mask-collision-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();

    const [platinum] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: `amex-platinum-${suffix}`,
        name: "Platinum Card®",
        officialName: "Platinum Card®",
        mask: "1009",
        type: "credit",
        subtype: "credit card",
      })
      .returning();
    const [deltaGold] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: `amex-delta-gold-${suffix}`,
        name: "Delta SkyMiles® Gold Card",
        officialName: "Delta SkyMiles® Gold Card",
        mask: "1009",
        type: "credit",
        subtype: "credit card",
      })
      .returning();

    // Two transactions per card, distinguishable by their plaid txn id
    // so we can assert each one stays homed on the right account.
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-20",
        description: "Platinum charge A",
        amount: "-12.50",
        source: "plaid:amex",
        plaidTransactionId: `pt-platinum-a-${suffix}`,
        plaidAccountId: platinum!.accountId,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-21",
        description: "Platinum charge B",
        amount: "-30.00",
        source: "plaid:amex",
        plaidTransactionId: `pt-platinum-b-${suffix}`,
        plaidAccountId: platinum!.accountId,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-22",
        description: "Delta charge A",
        amount: "-99.00",
        source: "plaid:amex",
        plaidTransactionId: `pt-delta-a-${suffix}`,
        plaidAccountId: deltaGold!.accountId,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-23",
        description: "Delta charge B",
        amount: "-45.00",
        source: "plaid:amex",
        plaidTransactionId: `pt-delta-b-${suffix}`,
        plaidAccountId: deltaGold!.accountId,
      },
    ]);

    try {
      const report = await dedupePlaidAccountsForUser(TEST_USER);
      // No groups of >1 should have been formed for ··1009 — the two
      // distinct cards must end up in DIFFERENT groups thanks to the
      // (institution, mask, name) key.
      expect(report.duplicatesRemoved).toBe(0);

      const accts = await db
        .select()
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, TEST_USER));
      const oneOhNines = accts.filter((a) => a.mask === "1009");
      expect(oneOhNines).toHaveLength(2);
      const names = new Set(oneOhNines.map((a) => a.name));
      expect(names).toEqual(
        new Set(["Platinum Card®", "Delta SkyMiles® Gold Card"]),
      );

      // Both account rows still present by id.
      const remainingIds = new Set(oneOhNines.map((a) => a.id));
      expect(remainingIds.has(platinum!.id)).toBe(true);
      expect(remainingIds.has(deltaGold!.id)).toBe(true);

      // Transactions still point at the correct account_id.
      const txns = await db
        .select({
          plaidTransactionId: transactionsTable.plaidTransactionId,
          plaidAccountId: transactionsTable.plaidAccountId,
        })
        .from(transactionsTable)
        .where(eq(transactionsTable.userId, TEST_USER));
      const byPtId = new Map(
        txns.map((t) => [t.plaidTransactionId ?? "", t.plaidAccountId] as const),
      );
      expect(byPtId.get(`pt-platinum-a-${suffix}`)).toBe(platinum!.accountId);
      expect(byPtId.get(`pt-platinum-b-${suffix}`)).toBe(platinum!.accountId);
      expect(byPtId.get(`pt-delta-a-${suffix}`)).toBe(deltaGold!.accountId);
      expect(byPtId.get(`pt-delta-b-${suffix}`)).toBe(deltaGold!.accountId);
    } finally {
      await cleanup();
    }
  });

  it("is a no-op when the three Amex cards each have exactly one row", async () => {
    const otherUser = `${TEST_USER}-clean`;
    try {
      const suffix = randomUUID().slice(0, 8);
      const [item] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `amex-clean-${suffix}`,
          accessToken: "test-no-access",
          institutionName: "American Express",
          institutionSlug: "american-express",
        })
        .returning();
      for (const mask of ["1001", "2002", "3003"]) {
        await db.insert(plaidAccountsTable).values({
          userId: otherUser,
          itemId: item!.id,
          accountId: `amex-${mask}-${suffix}`,
          name: `Amex ··${mask}`,
          mask,
          type: "credit",
          subtype: "credit card",
        });
      }
      const report = await dedupePlaidAccountsForUser(otherUser);
      expect(report.groupsScanned).toBe(0);
      expect(report.duplicatesRemoved).toBe(0);
      const remaining = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      expect(remaining).toHaveLength(3);
    } finally {
      await db
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      await db
        .delete(plaidItemsTable)
        .where(eq(plaidItemsTable.userId, otherUser));
    }
  });
});
