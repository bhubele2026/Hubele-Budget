import { db, householdsTable, householdMembersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * (#623) Test helper. Bootstraps a real household + member row for a
 * synthetic TEST_USER id so the route layer (which now filters by
 * household_id) can find seeded rows.
 *
 * Usage in a test file:
 *   const TEST_USER = `test-${process.pid}-${randomUUID().slice(0, 8)}`;
 *   let TEST_HOUSEHOLD_ID: string;
 *   beforeAll(async () => {
 *     TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
 *   });
 *
 * Then in the requireAuth mock:
 *   req.userId = TEST_USER;
 *   req.actualUserId = TEST_USER;
 *   req.householdId = TEST_HOUSEHOLD_ID;
 *   req.householdOwnerId = TEST_USER;
 *
 * And on every db.insert(...).values({ userId: TEST_USER, ... })
 * add householdId: TEST_HOUSEHOLD_ID alongside userId.
 *
 * Idempotent — safe to call multiple times for the same user id.
 */
export async function createTestHousehold(
  ownerUserId: string,
): Promise<{ householdId: string; ownerUserId: string }> {
  const [inserted] = await db
    .insert(householdsTable)
    .values({ ownerUserId })
    .onConflictDoNothing({ target: householdsTable.ownerUserId })
    .returning({ id: householdsTable.id });
  let householdId = inserted?.id;
  if (!householdId) {
    const [existing] = await db
      .select({ id: householdsTable.id })
      .from(householdsTable)
      .where(eq(householdsTable.ownerUserId, ownerUserId));
    householdId = existing!.id;
  }
  await db
    .insert(householdMembersTable)
    .values({ userId: ownerUserId, householdId, role: "owner" })
    .onConflictDoNothing({ target: householdMembersTable.userId });
  return { householdId, ownerUserId };
}
