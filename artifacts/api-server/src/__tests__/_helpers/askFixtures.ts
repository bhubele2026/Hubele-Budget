import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  agentRunsTable,
  allowancePlansTable,
  budgetCategoriesTable,
  recurringItemsTable,
  settingsTable,
} from "@workspace/db";
import { addTxn, daysAgo, seedCategories, type Cats } from "./aiCategorize";
import { createTestHousehold } from "./testHousehold";

// (AI-2) Synthetic households for the Ask tests. Nothing real.

export interface AskHousehold {
  owner: string;
  member: string;
  householdId: string;
  cats: Cats;
  txns: { kroger: string; shell: string; coffee: string };
  billId: string;
  planId: string;
  expenseCatId: string;
}

export async function seedAskHousehold(tag: string, opts: { merchant?: string } = {}): Promise<AskHousehold> {
  const owner = `ask-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const member = `${owner}-m`;
  const { householdId } = await createTestHousehold(owner);
  const cats = await seedCategories(householdId, owner);
  const m = opts.merchant ?? tag.toUpperCase();
  const kroger = await addTxn(householdId, owner, { description: `KROGER ${m} 1`, amount: "-45.20", categoryId: cats.Groceries, occurredOn: daysAgo(2) });
  const shell = await addTxn(householdId, owner, { description: `SHELL ${m} 2`, amount: "-60.00", occurredOn: daysAgo(3) });
  const coffee = await addTxn(householdId, owner, { description: `BEAN ${m} 3`, amount: "-6.50", categoryId: cats.Coffee, occurredOn: daysAgo(1) });
  const [bill] = await db
    .insert(recurringItemsTable)
    .values({ userId: owner, householdId, name: `Internet ${m}`, kind: "bill", amount: "70.00", frequency: "monthly", dayOfMonth: 15 })
    .returning({ id: recurringItemsTable.id });
  const [plan] = await db
    .insert(allowancePlansTable)
    .values({ householdId, period: "weekly", amount: "200.00", effectiveFrom: "2026-05-01", source: "owner" })
    .returning({ id: allowancePlansTable.id });
  const [exp] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: owner, householdId, name: `Fun ${m} ${randomUUID().slice(0, 4)}`, kind: "expense", groupName: "Test" })
    .returning({ id: budgetCategoriesTable.id });
  return { owner, member, householdId, cats, txns: { kroger, shell, coffee }, billId: bill!.id, planId: plan!.id, expenseCatId: exp!.id };
}

export async function newRun(householdId: string): Promise<string> {
  const [r] = await db
    .insert(agentRunsTable)
    .values({ householdId, kind: "chat", trigger: "user", status: "running" })
    .returning({ id: agentRunsTable.id });
  return r!.id;
}

export async function setWaitDays(householdId: string, owner: string, days: number | null): Promise<void> {
  const preferences = days === null ? null : { wishlistWaitDays: days };
  await db
    .insert(settingsTable)
    .values({ userId: owner, householdId, preferences })
    .onConflictDoUpdate({ target: settingsTable.userId, set: { preferences, householdId } });
}

export async function clearRuns(householdId: string): Promise<void> {
  await db.delete(agentRunsTable).where(eq(agentRunsTable.householdId, householdId));
}
