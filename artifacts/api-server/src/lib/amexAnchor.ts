import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  settingsTable,
} from "@workspace/db";

/**
 * Source values that count as Amex when computing the anchor. The legacy
 * workbook importer writes "amex"; Plaid items for American Express (slug
 * "amex" — see lib/plaid.ts SLUG_OVERRIDES) write "plaid:amex". Both must
 * contribute to the ending-balance math.
 */
export const AMEX_TXN_SOURCES = ["amex", "plaid:amex"] as const;

/**
 * Drizzle's transaction callback parameter type. Both `db` and a `tx`
 * accepted here so callers can run the refresh inside an existing
 * transaction (workbook re-import) or stand-alone (post-Plaid sync).
 */
type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AmexAnchorRefreshResult = {
  changed: boolean;
  updatedDebt: boolean;
  balance: number | null;
  asOf: string;
  txnCount: number;
};

/**
 * Recompute the Amex ending-balance anchor from the current set of
 * `source='amex'` transactions and persist it.
 *
 * Always writes `settings.preferences.amexAnchor` (so `GET /amex/anchor`
 * advances even if the linked debts row was manually edited).
 *
 * Updates the linked Amex debts row's `balance` only when:
 *   - `adopt: true` is passed (workbook re-import flow — the debts table was
 *     just wiped and rebuilt from the workbook, so we always re-anchor), OR
 *   - the debt's current balance still matches the previous auto-anchor
 *     value (i.e. the user has NOT manually changed it since our last
 *     auto-update).
 *
 * Otherwise the debt row is left alone — manual UI edits win.
 *
 * Returns `{ changed: false, balance: null }` when there are no
 * `source='amex'` transactions yet.
 */
export async function refreshAmexAnchor(
  userId: string,
  exec: Exec = db,
  opts: { adopt?: boolean } = {},
): Promise<AmexAnchorRefreshResult> {
  const adopt = opts.adopt === true;
  const asOf = new Date().toISOString();

  const [agg] = await exec
    .select({
      net: sql<string>`coalesce(sum(${transactionsTable.amount})::text, '0')`,
      cnt: sql<number>`count(*)::int`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
      ),
    );
  const txnCount = Number(agg?.cnt ?? 0);
  if (txnCount === 0) {
    return { changed: false, updatedDebt: false, balance: null, asOf, txnCount: 0 };
  }
  const balance = Number(agg!.net);
  const balanceStr = balance.toFixed(2);

  // Find the Amex debt — prefer one linked to a Plaid account that has
  // produced source='amex' transactions, fall back to a name match.
  const acctRows = await exec
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

  let debt: { id: string; balance: string } | undefined;
  if (amexPlaidAccountIds.length > 0) {
    const [byAcct] = await exec
      .select({ id: debtsTable.id, balance: debtsTable.balance })
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
    const [byName] = await exec
      .select({ id: debtsTable.id, balance: debtsTable.balance })
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

  // Read prior anchor so we can detect manual UI overrides since the last
  // auto-update.
  const [s] = await exec
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId));
  const prefs =
    (s?.preferences as Record<string, unknown> | null | undefined) ?? {};
  const priorAnchor = (prefs as {
    amexAnchor?: { balance?: number | string; lastAutoBalance?: number | string };
  }).amexAnchor;
  const priorAuto =
    priorAnchor && priorAnchor.lastAutoBalance !== undefined
      ? Number(priorAnchor.lastAutoBalance)
      : undefined;

  let updatedDebt = false;
  if (debt) {
    const debtNum = Number(debt.balance);
    const matchesAuto =
      priorAuto === undefined || !Number.isFinite(priorAuto)
        ? true
        : Math.abs(debtNum - priorAuto) < 0.005;
    const wantsUpdate = Math.abs(debtNum - balance) >= 0.005;
    if (wantsUpdate && (adopt || matchesAuto)) {
      await exec
        .update(debtsTable)
        .set({
          balance: balanceStr,
          lastBalanceUpdate: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(debtsTable.id, debt.id));
      updatedDebt = true;
    }
  }

  const nextPrefs = {
    ...prefs,
    amexAnchor: { balance, asOf, lastAutoBalance: balance },
  };
  if (s) {
    await exec
      .update(settingsTable)
      .set({ preferences: nextPrefs, updatedAt: new Date() })
      .where(eq(settingsTable.userId, userId));
  } else {
    await exec
      .insert(settingsTable)
      .values({ userId, preferences: nextPrefs })
      .onConflictDoUpdate({
        target: settingsTable.userId,
        set: { preferences: nextPrefs, updatedAt: new Date() },
      });
  }

  return { changed: true, updatedDebt, balance, asOf, txnCount };
}
