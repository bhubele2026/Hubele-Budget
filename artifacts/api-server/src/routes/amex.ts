import { Router, type IRouter } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  settingsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { AMEX_TXN_SOURCES } from "../lib/amexAnchor";

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
        inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
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

  // Always read the settings anchor (even when a debt row resolves) so we
  // can advance the returned `asOf` to the most recent of the two
  // timestamps. Without this, an auto-refresh that intentionally LEAVES the
  // debt row alone (manual UI override wins) would never bump the anchor's
  // `asOf` for clients hitting this endpoint, defeating the auto-update.
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

  if (debt) {
    const debtAsOf = (debt.updatedAt ?? new Date()).toISOString();
    const anchorAsOf = anchor?.asOf ?? null;
    const asOf =
      anchorAsOf && anchorAsOf > debtAsOf ? anchorAsOf : debtAsOf;
    res.json({
      amexEndingBalance: Number(debt.balance),
      asOf,
      source: "debt" as const,
    });
    return;
  }

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
        inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
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

/**
 * Persist a user-provided actual Amex balance to
 * `settings.preferences.amexAnchor`. The Amex page exposes this when the
 * computed/transaction-derived ending balance is the only thing available
 * (no linked debt row, no prior anchor) so the user can pin reality and
 * have the chip switch back to "From saved anchor".
 *
 * Body: { balance: number, asOf?: string (ISO) }
 */
router.post("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const body = (req.body ?? {}) as { balance?: unknown; asOf?: unknown };
  const balanceNum = Number(body.balance);
  if (!Number.isFinite(balanceNum)) {
    res.status(400).json({ error: "balance must be a finite number" });
    return;
  }
  let asOf: string;
  if (typeof body.asOf === "string" && body.asOf) {
    const d = new Date(body.asOf);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "asOf must be a valid ISO date string" });
      return;
    }
    asOf = d.toISOString();
  } else {
    asOf = new Date().toISOString();
  }

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, userId));
    const prevPrefs =
      (existing?.preferences as Record<string, unknown> | null | undefined) ??
      {};
    const nextPrefs = {
      ...prevPrefs,
      amexAnchor: { balance: balanceNum, asOf },
    };
    if (existing) {
      await tx
        .update(settingsTable)
        .set({ preferences: nextPrefs, updatedAt: new Date() })
        .where(eq(settingsTable.userId, userId));
    } else {
      await tx
        .insert(settingsTable)
        .values({ userId, preferences: nextPrefs })
        .onConflictDoUpdate({
          target: settingsTable.userId,
          set: { preferences: nextPrefs, updatedAt: new Date() },
        });
    }
  });

  res.json({
    amexEndingBalance: balanceNum,
    asOf,
    source: "anchor" as const,
  });
});

/**
 * Clear a previously persisted Amex anchor at
 * `settings.preferences.amexAnchor`. Lets the user remove the saved value so
 * the Amex page falls back to the linked debt row, the computed running sum,
 * or the missing state — whichever resolves next via GET /amex/anchor.
 */
router.delete("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, userId));
    if (!existing) return;
    const prevPrefs =
      (existing.preferences as Record<string, unknown> | null | undefined) ??
      {};
    if (!("amexAnchor" in prevPrefs)) return;
    const nextPrefs = { ...prevPrefs };
    delete (nextPrefs as Record<string, unknown>).amexAnchor;
    await tx
      .update(settingsTable)
      .set({ preferences: nextPrefs, updatedAt: new Date() })
      .where(eq(settingsTable.userId, userId));
  });
  res.json({ ok: true });
});

export default router;
