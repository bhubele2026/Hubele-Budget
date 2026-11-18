// ⭐ (11/18/2026) A READING THE DAY OUTRAN — its own module, reading only tables the
// household data revision watches (`ledgerCache.ts`), so the cached weekly plan may ask it.
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db, forecastSettingsTable, transactionsTable } from "@workspace/db";
import { householdDayOf } from "./householdClock";
import { resolveSnapshotAccount } from "./resolveSnapshotAccount";

/**
 * ⭐ (11/18) Did a charge on the snapshot account, dated on the reading's own
 * household day, reach the ledger after the read? One indexed count; no Plaid call.
 */
export async function chargeArrivedAfterRead(
  householdId: string,
  accountExternalId: string,
  snapshotAt: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.plaidAccountId, accountExternalId),
        eq(transactionsTable.occurredOn, householdDayOf(snapshotAt)),
        gt(transactionsTable.createdAt, snapshotAt),
        lt(transactionsTable.amount, "0"),
        isNull(transactionsTable.plaidRemovedAt),
      ),
    );
  return (row?.n ?? 0) > 0;
}

/** The same question for the household's own snapshot: false with no Plaid reading or no resolved account. */
export async function bankReadOutrun(householdId: string, ownerUserId: string): Promise<boolean> {
  const [s] = await db
    .select({
      balance: forecastSettingsTable.bankSnapshotBalance,
      at: forecastSettingsTable.bankSnapshotAt,
      source: forecastSettingsTable.bankSnapshotSource,
      accountId: forecastSettingsTable.bankSnapshotAccountId,
      mask: forecastSettingsTable.bankSnapshotMask,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  if (!s || s.balance == null || s.at == null || s.source !== "plaid") return false;
  const resolved = await resolveSnapshotAccount({
    householdId,
    bankSnapshotAccountId: s.accountId ?? null,
    bankSnapshotMask: s.mask ?? null,
  });
  return resolved.externalId ? chargeArrivedAfterRead(householdId, resolved.externalId, s.at) : false;
}
