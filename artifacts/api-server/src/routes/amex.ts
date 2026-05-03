import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  settingsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

/**
 * Resolved Amex ending balance for the current user. Used by the Amex page
 * as a server-side fallback so it does not silently show "Unavailable" when
 * the linked debt row is removed or renamed.
 *
 * Resolution order:
 *   1) `debt`     — a debts row whose name matches /amex|american express/i
 *                   or whose plaid_account_id matches an Amex transaction.
 *   2) `anchor`   — a previously persisted value at
 *                   `settings.preferences.amexAnchor`.
 *   3) `computed` — net change of all `source='amex'` transactions from $0.
 *   4) `missing`  — no Amex data at all.
 */
router.get("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;

  const acctRows = await db
    .selectDistinct({ plaidAccountId: transactionsTable.plaidAccountId })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.source, "amex"),
        sql`${transactionsTable.plaidAccountId} is not null`,
      ),
    );
  const amexPlaidAccountIds = acctRows
    .map((r) => r.plaidAccountId)
    .filter((v): v is string => !!v);

  let debt: { id: string; balance: string; updatedAt: Date | null } | undefined;
  if (amexPlaidAccountIds.length > 0) {
    const [byAcct] = await db
      .select({
        id: debtsTable.id,
        balance: debtsTable.balance,
        updatedAt: debtsTable.updatedAt,
      })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, userId),
          sql`${debtsTable.plaidAccountId}::text = ANY(${amexPlaidAccountIds})`,
        ),
      )
      .limit(1);
    debt = byAcct;
  }
  if (!debt) {
    const [byName] = await db
      .select({
        id: debtsTable.id,
        balance: debtsTable.balance,
        updatedAt: debtsTable.updatedAt,
      })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, userId),
          sql`${debtsTable.name} ~* '(amex|american\\s*express)'`,
        ),
      )
      .limit(1);
    debt = byName;
  }

  if (debt) {
    res.json({
      amexEndingBalance: Number(debt.balance),
      asOf: (debt.updatedAt ?? new Date()).toISOString(),
      source: "debt" as const,
    });
    return;
  }

  const [settingsRow] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId));
  const anchor =
    settingsRow?.preferences &&
    typeof settingsRow.preferences === "object" &&
    "amexAnchor" in (settingsRow.preferences as Record<string, unknown>)
      ? ((settingsRow.preferences as { amexAnchor?: unknown }).amexAnchor as
          | { balance?: number | string; asOf?: string }
          | undefined)
      : undefined;
  if (anchor && anchor.balance !== undefined && anchor.balance !== null) {
    const n = Number(anchor.balance);
    if (Number.isFinite(n)) {
      res.json({
        amexEndingBalance: n,
        asOf: anchor.asOf ?? new Date().toISOString(),
        source: "anchor" as const,
      });
      return;
    }
  }

  const [agg] = await db
    .select({
      net: sql<string>`coalesce(sum(${transactionsTable.amount})::text, '0')`,
      cnt: sql<number>`count(*)::int`,
      latest: sql<string | null>`max(${transactionsTable.occurredOn})::text`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.source, "amex"),
      ),
    );

  if (agg && (agg.cnt ?? 0) > 0) {
    res.json({
      amexEndingBalance: Number(agg.net),
      asOf:
        (agg.latest ?? new Date().toISOString().slice(0, 10)) +
        "T00:00:00.000Z",
      source: "computed" as const,
    });
    return;
  }

  res.json({
    amexEndingBalance: null,
    asOf: new Date().toISOString(),
    source: "missing" as const,
  });
});

export default router;
