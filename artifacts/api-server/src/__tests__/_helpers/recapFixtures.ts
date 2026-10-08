import { eq } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  debtsTable,
  forecastSettingsTable,
  recapsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import type { TestMember } from "./smsFixtures";

// (AI-4a) One synthetic household for the recap tests. "Now" is Wed 2026-10-07
// 12:00 Central; the recap is for 2026-10-07, so yesterday is Tue 10-06 and the
// household week is Sun 10-04 .. Sat 10-10. No real merchant, name or number.
//
// Yesterday (Tue 10-06), discretionary: Cafe 12.40 (Dining, weekly) + Market
// 50.00 (Groceries, weekly) + Gadget 30.00 (unfiled) = 92.40. Not counted: a
// $200 transfer, a $100 payment tagged to a debt, a $10 row on 10-05 and a $99
// row on 10-07.
// Late: a 10-04 row created after the previous recap went out ($20); another
// 10-04 row created before it ($7) is not late.
// Last week to Tuesday: $300 on 9-28 -> this week to date (122.40) is lower.
// Bills: Electric $90 on 10-08 (tomorrow), Water $40 on 10-10 (in 3 days),
// Rent $1,200 on 10-12 (out).

export const NOW = new Date("2026-10-07T12:00:00-05:00");
export const FOR_DATE = "2026-10-07";

export async function seedRecapHousehold(m: TestMember): Promise<{ dining: string; groceries: string; debtId: string }> {
  const base = { userId: m.userId, householdId: m.householdId };
  const [dining] = await db
    .insert(budgetCategoriesTable)
    .values({ ...base, name: "Dining Out", kind: "expense", groupName: "Food" })
    .returning();
  const [groceries] = await db
    .insert(budgetCategoriesTable)
    .values({ ...base, name: "Groceries", kind: "expense", groupName: "Food" })
    .returning();
  const [debt] = await db
    .insert(debtsTable)
    .values({ ...base, name: "Card A", balance: "1000.00", originalBalance: "2000.00", status: "active" })
    .returning();

  const row = (r: {
    occurredOn: string;
    description: string;
    amount: string;
    categoryId?: string | null;
    weeklyAllowance?: boolean;
    isTransfer?: boolean;
    debtId?: string | null;
    createdAt?: Date;
  }) => ({
    ...base,
    occurredOn: r.occurredOn,
    description: r.description,
    amount: r.amount,
    source: "manual",
    categoryId: r.categoryId ?? null,
    weeklyAllowance: r.weeklyAllowance ?? false,
    isTransfer: r.isTransfer ?? false,
    debtId: r.debtId ?? null,
    createdAt: r.createdAt ?? new Date("2026-10-06T14:00:00Z"),
  });
  await db.insert(transactionsTable).values([
    row({ occurredOn: "2026-10-06", description: "CAFE 12", amount: "-12.40", categoryId: dining!.id, weeklyAllowance: true }),
    row({ occurredOn: "2026-10-06", description: "MARKET 9", amount: "-50.00", categoryId: groceries!.id, weeklyAllowance: true }),
    row({ occurredOn: "2026-10-06", description: "GADGET SHOP", amount: "-30.00" }),
    row({ occurredOn: "2026-10-06", description: "Online Transfer to SAV", amount: "-200.00", isTransfer: true }),
    row({ occurredOn: "2026-10-06", description: "CARD A PAYMENT", amount: "-100.00", debtId: debt!.id }),
    row({ occurredOn: "2026-10-05", description: "OLD ROW", amount: "-10.00", weeklyAllowance: true, createdAt: new Date("2026-10-05T16:00:00Z") }),
    row({ occurredOn: "2026-10-07", description: "TODAY ROW", amount: "-99.00", weeklyAllowance: true }),
    row({ occurredOn: "2026-10-04", description: "LATE ONE", amount: "-20.00", weeklyAllowance: true, createdAt: new Date("2026-10-06T20:00:00Z") }),
    row({ occurredOn: "2026-10-04", description: "EARLY ONE", amount: "-7.00", weeklyAllowance: true, createdAt: new Date("2026-10-05T15:00:00Z") }),
    row({ occurredOn: "2026-09-28", description: "PRIOR WEEK", amount: "-300.00", weeklyAllowance: true, createdAt: new Date("2026-09-28T15:00:00Z") }),
  ]);
  // The previous recap went out the morning of 10-06.
  await db.insert(recapsTable).values({
    householdId: m.householdId,
    userId: m.userId,
    forDate: "2026-10-06",
    facts: {},
    text: "earlier recap",
    source: "template",
    status: "sent",
    generatedAt: new Date("2026-10-06T12:00:00Z"),
  });

  const plan = (p: { name: string; amount: string; anchorDate: string }) => ({
    ...base,
    name: p.name,
    kind: "bill",
    amount: p.amount,
    frequency: "monthly",
    dayOfMonth: Number(p.anchorDate.slice(8, 10)),
    anchorDate: p.anchorDate,
    active: "true",
  });
  await db.insert(recurringItemsTable).values([
    plan({ name: "Electric", amount: "90", anchorDate: "2026-10-08" }),
    plan({ name: "Water", amount: "40", anchorDate: "2026-10-10" }),
    plan({ name: "Rent", amount: "1200", anchorDate: "2026-10-12" }),
  ]);
  return { dining: dining!.id, groceries: groceries!.id, debtId: debt!.id };
}

/** A typed-in bank balance of the given age, so the freshness verdict is stale. */
export async function seedStaleBank(m: TestMember, asOf: string): Promise<void> {
  await db
    .insert(forecastSettingsTable)
    .values({
      userId: m.userId,
      householdId: m.householdId,
      daysAhead: 90,
      cashBuffer: "500.00",
      bankSnapshotBalance: "3000.00",
      bankSnapshotAt: new Date(asOf),
      bankSnapshotSource: "manual",
    })
    .onConflictDoNothing();
}

export async function wipeRecapHousehold(m: TestMember): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, m.householdId));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, m.householdId));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, m.householdId));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, m.householdId));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.householdId, m.householdId));
}
