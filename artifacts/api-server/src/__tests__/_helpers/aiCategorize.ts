import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { addDaysISO, householdToday } from "@workspace/avalanche-core";
import {
  db,
  aiUsageTable,
  budgetCategoriesTable,
  debtsTable,
  transactionsTable,
  categoryDecisionsTable,
  agentRunsTable,
  mappingRulesTable,
  merchantMemoryTable,
  settingsTable,
} from "@workspace/db";
import type { StructuredCall } from "../../ai/provider";

// (AI-1) Shared fixtures for the model-stage / job tests. Synthetic only.

export const daysAgo = (n: number): string => addDaysISO(householdToday(new Date()), -n);

export interface Cats {
  Groceries: string;
  Dining: string;
  Coffee: string;
  Income: string;
  CarLoan: string;
  Uncategorized: string;
}

export async function seedCategories(householdId: string, owner: string): Promise<Cats> {
  const mk = async (name: string, kind = "expense", extra: Partial<typeof budgetCategoriesTable.$inferInsert> = {}) => {
    const [c] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: owner, householdId, name: `${name} ${randomUUID().slice(0, 5)}`, kind, groupName: "Test", ...extra })
      .returning({ id: budgetCategoriesTable.id });
    return c!.id;
  };
  const [debt] = await db
    .insert(debtsTable)
    .values({ userId: owner, householdId, name: `Car ${randomUUID().slice(0, 5)}`, balance: "9000.00" })
    .returning({ id: debtsTable.id });
  return {
    Groceries: await mk("Groceries"),
    Dining: await mk("Dining"),
    Coffee: await mk("Coffee"),
    Income: await mk("Income", "income"),
    CarLoan: await mk("Car loan", "expense", { debtId: debt!.id }),
    Uncategorized: await mk("Uncategorized", "expense", { excludeFromBudget: true }),
  };
}

let seq = 0;
export async function addTxn(
  householdId: string,
  owner: string,
  o: Partial<typeof transactionsTable.$inferInsert> = {},
): Promise<string> {
  seq += 1;
  const [r] = await db
    .insert(transactionsTable)
    .values({
      userId: owner,
      householdId,
      occurredOn: daysAgo(3),
      description: `AI1 ROW ${seq}`,
      amount: "-10.00",
      source: "plaid:bank",
      plaidAccountId: "acct-ai1",
      ...o,
    })
    .returning({ id: transactionsTable.id });
  return r!.id;
}

export async function wipeHousehold(householdId: string): Promise<void> {
  await db.delete(agentRunsTable).where(eq(agentRunsTable.householdId, householdId)); // actions cascade
  await db.delete(aiUsageTable).where(eq(aiUsageTable.householdId, householdId));
  await db.delete(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, householdId));
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, householdId));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.householdId, householdId));
  await db.delete(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, householdId));
}

export async function setPrefs(householdId: string, owner: string, preferences: Record<string, unknown> | null) {
  await db
    .insert(settingsTable)
    .values({ userId: owner, householdId, preferences })
    .onConflictDoUpdate({ target: settingsTable.userId, set: { preferences, householdId } });
}

export interface Answer {
  cat: string;
  confidence?: "high" | "medium" | "low";
  isTransfer?: boolean;
  split?: Array<{ categoryId: string; amount: number }> | null;
  recurring?: { cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly"; likely: boolean } | null;
  rationale?: string;
}

/** A fake-provider fixture: answers each charge by the first rule whose text its merchant contains. */
export function fixtureBy(rules: Array<[string, Answer]>, fallback?: Answer) {
  return (call: StructuredCall): unknown => {
    const doc = JSON.parse(call.messages[0]!.content as string) as {
      categories: Array<{ id: string }>;
      charges: Array<{ index: number; merchant: string }>;
    };
    const results = [];
    for (const c of doc.charges) {
      const hit = rules.find(([needle]) => c.merchant.toUpperCase().includes(needle.toUpperCase()));
      const a = hit?.[1] ?? fallback;
      if (!a) continue;
      results.push({
        index: c.index,
        categoryId: a.cat,
        confidence: a.confidence ?? "high",
        isTransfer: a.isTransfer ?? false,
        recurringGuess: a.recurring ?? null,
        splitSuggestion: a.split ?? null,
        rationale: a.rationale ?? "Matches similar charges.",
      });
    }
    return { results };
  };
}
