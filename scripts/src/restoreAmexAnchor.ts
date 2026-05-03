/**
 * Idempotent fix: restore the Amex ending-balance anchor to $1,293.08.
 *
 * Inserts (or updates) a debts row matching /amex|american express/i and
 * mirrors the value into settings.preferences.amexAnchor so the server-side
 * fallback (`GET /amex/anchor`) keeps working if the debt row is later
 * removed.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  debtsTable,
  transactionsTable,
  settingsTable,
} from "@workspace/db";

const USER_ID = "user_3DBrWZkCKIzrkYoLS6N9tIMcdso";
const TARGET_BALANCE = 1293.08;

async function main() {
  const targetStr = TARGET_BALANCE.toFixed(2);
  const asOf = new Date().toISOString();

  let action: "inserted" | "updated";
  let debtId: string;

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: debtsTable.id, name: debtsTable.name })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, USER_ID),
          sql`${debtsTable.name} ~* '(amex|american\\s*express)'`,
        ),
      )
      .limit(1);

    if (existing.length) {
      await tx
        .update(debtsTable)
        .set({
          balance: targetStr,
          balanceSource: "manual",
          lastBalanceUpdate: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(debtsTable.id, existing[0].id));
      action = "updated";
      debtId = existing[0].id;
    } else {
      const [created] = await tx
        .insert(debtsTable)
        .values({
          userId: USER_ID,
          name: "American Express",
          type: "credit_card",
          apr: "0.2849",
          balance: targetStr,
          minPayment: "40.00",
          payment: "40.00",
          status: "active",
          dueDay: 25,
          statementDay: 1,
          balanceSource: "manual",
          aprSource: "manual",
          minPaymentSource: "manual",
          lastBalanceUpdate: new Date(),
        })
        .returning({ id: debtsTable.id });
      action = "inserted";
      debtId = created.id;
    }

    const [s] = await tx
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, USER_ID));
    const prefs =
      (s?.preferences as Record<string, unknown> | null | undefined) ?? {};
    const nextPrefs = {
      ...prefs,
      amexAnchor: { balance: TARGET_BALANCE, asOf },
    };
    if (s) {
      await tx
        .update(settingsTable)
        .set({ preferences: nextPrefs, updatedAt: new Date() })
        .where(eq(settingsTable.userId, USER_ID));
    } else {
      await tx
        .insert(settingsTable)
        .values({ userId: USER_ID, preferences: nextPrefs })
        .onConflictDoUpdate({
          target: settingsTable.userId,
          set: { preferences: nextPrefs, updatedAt: new Date() },
        });
    }
  });

  const [{ cnt }] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, USER_ID),
        eq(transactionsTable.source, "amex"),
      ),
    );

  console.log(
    `RECONCILE  action=${action!}  debtId=${debtId!}  balance=${targetStr}  amexTxnCount=${cnt}  anchorAsOf=${asOf}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
