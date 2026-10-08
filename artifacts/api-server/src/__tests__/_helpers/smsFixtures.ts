import { randomUUID } from "node:crypto";
import { db, householdMembersTable, householdsTable, recapSettingsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestHousehold } from "./testHousehold";

// (AI-4b) Fixtures for the SMS / recap tests: separate households, each with
// its own member, so isolation between members is real. Phone numbers are the
// reserved-looking +1555555xxxx style; none is real.

export interface TestMember {
  userId: string;
  householdId: string;
}

export async function makeMembers(count: number): Promise<TestMember[]> {
  const out: TestMember[] = [];
  for (let i = 0; i < count; i++) {
    const userId = `sms-${process.pid}-${randomUUID().slice(0, 8)}`;
    const { householdId } = await createTestHousehold(userId);
    out.push({ userId, householdId });
  }
  return out;
}

/** Deleting the household cascades recap_settings / recap_verifications / recap_deliveries. */
export async function dropMembers(members: TestMember[]): Promise<void> {
  if (members.length === 0) return;
  await db.delete(householdMembersTable).where(
    inArray(householdMembersTable.userId, members.map((m) => m.userId)),
  );
  await db.delete(householdsTable).where(inArray(householdsTable.id, members.map((m) => m.householdId)));
}

export async function seedSettings(
  m: TestMember,
  over: Partial<typeof recapSettingsTable.$inferInsert> = {},
): Promise<void> {
  await db
    .insert(recapSettingsTable)
    .values({ householdId: m.householdId, userId: m.userId, ...over })
    .onConflictDoNothing();
}

/** A verified, consented, enabled member on the given number. */
export async function seedVerified(m: TestMember, phone: string, over: Partial<typeof recapSettingsTable.$inferInsert> = {}) {
  await seedSettings(m, {
    enabled: true,
    phoneE164: phone,
    verifiedAt: new Date(),
    consentedAt: new Date(),
    consentTextVersion: "test",
    ...over,
  });
}
