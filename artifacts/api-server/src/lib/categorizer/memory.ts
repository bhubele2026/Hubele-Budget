// (PR-A) Merchant memory: what a person's correction or accept teaches the
// engine. Retroactive application happens ONLY through
// `applyMemoryRetroactively` (an explicit request); a correction returns the
// candidates and touches nothing else.
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db, merchantMemoryTable, transactionsTable } from "@workspace/db";
import { isExcludedCategory } from "../excludedCategory";
import { merchantSignature } from "../merchantNameExtract";
import { toMemoryRow } from "./context";
import type { Exec } from "./db";
import { applicableMemory } from "./stages/memory";
import type { MemoryRow } from "./types";

export const MAX_BAND = 9999999999.99;

export interface SigRow {
  id: string;
  description: string;
  amount: string;
  occurredOn: string;
  categoryId: string | null;
  plaidAccountId: string | null;
  categoryLockedByUser: boolean;
  createdAt: Date;
}

const likeEscape = (s: string): string => s.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");

/** Household rows whose description has this merchant signature (newest first). */
export async function rowsWithSignature(
  exec: Exec,
  householdId: string,
  signature: string,
  opts: { unlockedOnly?: boolean; lockedOnly?: boolean } = {},
): Promise<SigRow[]> {
  if (!signature) return [];
  const token = signature.split(" ").sort((a, b) => b.length - a.length)[0]!;
  const rows = await exec
    .select({
      id: transactionsTable.id,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      occurredOn: transactionsTable.occurredOn,
      categoryId: transactionsTable.categoryId,
      plaidAccountId: transactionsTable.plaidAccountId,
      categoryLockedByUser: transactionsTable.categoryLockedByUser,
      createdAt: transactionsTable.createdAt,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        ilike(transactionsTable.description, `%${likeEscape(token)}%`),
        opts.unlockedOnly ? eq(transactionsTable.categoryLockedByUser, false) : undefined,
        opts.lockedOnly ? eq(transactionsTable.categoryLockedByUser, true) : undefined,
      ),
    )
    .orderBy(desc(transactionsTable.occurredOn), transactionsTable.id);
  return rows.filter((r) => merchantSignature(r.description) === signature);
}

export interface RetroactiveCandidates {
  count: number;
  sample: { id: string; occurredOn: string; description: string; amount: string; categoryId: string | null }[];
}

/** Unlocked rows of the same merchant not already in `categoryId`. Never applied here. */
export async function retroactiveCandidates(
  householdId: string,
  txn: { id: string; description: string },
  categoryId: string,
  scopeFilter?: (r: SigRow) => boolean,
): Promise<RetroactiveCandidates> {
  const sig = merchantSignature(txn.description);
  const rows = (await rowsWithSignature(db, householdId, sig, { unlockedOnly: true })).filter(
    (r) => r.id !== txn.id && r.categoryId !== categoryId && (!scopeFilter || scopeFilter(r)),
  );
  return {
    count: rows.length,
    sample: rows.slice(0, 5).map((r) => ({
      id: r.id,
      occurredOn: r.occurredOn,
      description: r.description,
      amount: r.amount,
      categoryId: r.categoryId,
    })),
  };
}

const abs = (a: string | number): number => Math.abs(Number(a) || 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Two amount clusters more than 20% apart → bands split at the midpoint.
 * Returns [lowBand, highBand] tagged with which side each list landed on.
 */
export function splitAmountBands(
  a: readonly number[],
  b: readonly number[],
): { a: [number, number]; b: [number, number] } | null {
  if (a.length === 0 || b.length === 0) return null;
  const [minA, maxA, minB, maxB] = [Math.min(...a), Math.max(...a), Math.min(...b), Math.max(...b)];
  const low = maxA * 1.2 < minB ? "a" : maxB * 1.2 < minA ? "b" : null;
  if (!low) return null;
  const mid = round2(low === "a" ? (maxA + minB) / 2 : (maxB + minA) / 2);
  const lowBand: [number, number] = [0, mid];
  const highBand: [number, number] = [round2(mid + 0.01), MAX_BAND];
  return low === "a" ? { a: lowBand, b: highBand } : { a: highBand, b: lowBand };
}

async function upsertMemory(
  exec: Exec,
  v: {
    householdId: string;
    signature: string;
    scope: MemoryRow["scope"];
    plaidAccountId: string | null;
    lo: number | null;
    hi: number | null;
    categoryId: string;
    count: number;
    learnedFromTxnId: string | null;
  },
): Promise<string> {
  const res = await exec.execute(sql`
    INSERT INTO merchant_memory
      (household_id, signature, scope, plaid_account_id, amount_band_lo, amount_band_hi,
       category_id, count, last_confirmed_at, learned_from_txn_id, source)
    VALUES (${v.householdId}, ${v.signature}, ${v.scope}, ${v.plaidAccountId},
            ${v.lo == null ? null : v.lo.toFixed(2)}, ${v.hi == null ? null : v.hi.toFixed(2)},
            ${v.categoryId}, ${v.count}, now(), ${v.learnedFromTxnId}, 'user')
    ON CONFLICT (household_id, signature, scope, coalesce(plaid_account_id, ''), coalesce(amount_band_lo, 0))
    DO UPDATE SET category_id = EXCLUDED.category_id,
                  amount_band_hi = EXCLUDED.amount_band_hi,
                  count = EXCLUDED.count,
                  last_confirmed_at = EXCLUDED.last_confirmed_at,
                  learned_from_txn_id = EXCLUDED.learned_from_txn_id,
                  disabled_at = NULL
    RETURNING id`);
  return (res.rows[0] as { id: string }).id;
}

export interface LearnOutcome {
  memoryId: string;
  /** True when this choice created or re-pointed a memory row (undo disables it). */
  created: boolean;
}

/**
 * ⭐ A person filed `txn` into `categoryId`. Scope evolution:
 *   - nothing known → a `merchant` row;
 *   - the applicable row agrees → count + 1;
 *   - it disagrees and the earlier evidence was on ANOTHER account →
 *     `merchant_account` rows for both accounts;
 *   - it disagrees and the amounts split cleanly (two clusters > 20% apart) →
 *     `merchant_amount` rows for both bands;
 *   - otherwise the latest correction wins (the row is re-pointed, count 1).
 * System categories (Uncategorized / Transfer / Ignore) teach nothing.
 */
export async function learnFromChoice(
  exec: Exec,
  householdId: string,
  txn: { id: string; description: string; amount: string; plaidAccountId: string | null },
  categoryId: string | null,
): Promise<LearnOutcome | null> {
  if (!categoryId) return null;
  if (await isExcludedCategory(householdId, categoryId)) return null;
  const signature = merchantSignature(txn.description);
  if (!signature) return null;
  const live = (
    await exec
      .select()
      .from(merchantMemoryTable)
      .where(and(eq(merchantMemoryTable.householdId, householdId), eq(merchantMemoryTable.signature, signature)))
  )
    .filter((m) => !m.disabledAt);
  const cur = applicableMemory(live.map(toMemoryRow), txn);
  const base = { householdId, signature, learnedFromTxnId: txn.id };
  if (cur && cur.categoryId === categoryId) {
    await exec
      .update(merchantMemoryTable)
      .set({ count: sql`${merchantMemoryTable.count} + 1`, lastConfirmedAt: new Date() })
      .where(eq(merchantMemoryTable.id, cur.id));
    return { memoryId: cur.id, created: false };
  }
  if (!cur) {
    const id = await upsertMemory(exec, {
      ...base,
      scope: "merchant",
      plaidAccountId: null,
      lo: null,
      hi: null,
      categoryId,
      count: 1,
    });
    return { memoryId: id, created: true };
  }
  // Disagreement. Two accounts?
  const curRaw = live.find((m) => m.id === cur.id)!;
  if (cur.scope === "merchant" && txn.plaidAccountId && curRaw.learnedFromTxnId) {
    const [prev] = await exec
      .select({ plaidAccountId: transactionsTable.plaidAccountId })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.id, curRaw.learnedFromTxnId), eq(transactionsTable.householdId, householdId)));
    if (prev?.plaidAccountId && prev.plaidAccountId !== txn.plaidAccountId) {
      await upsertMemory(exec, {
        ...base,
        learnedFromTxnId: curRaw.learnedFromTxnId,
        scope: "merchant_account",
        plaidAccountId: prev.plaidAccountId,
        lo: null,
        hi: null,
        categoryId: cur.categoryId,
        count: cur.count,
      });
      const id = await upsertMemory(exec, {
        ...base,
        scope: "merchant_account",
        plaidAccountId: txn.plaidAccountId,
        lo: null,
        hi: null,
        categoryId,
        count: 1,
      });
      return { memoryId: id, created: true };
    }
  }
  // Two amount clusters?
  const priors = (await rowsWithSignature(exec, householdId, signature, { lockedOnly: true })).filter(
    (r) => r.id !== txn.id,
  );
  const bands = splitAmountBands(
    priors.filter((r) => r.categoryId === cur.categoryId).map((r) => abs(r.amount)),
    [abs(txn.amount), ...priors.filter((r) => r.categoryId === categoryId).map((r) => abs(r.amount))],
  );
  if (bands) {
    await upsertMemory(exec, {
      ...base,
      learnedFromTxnId: curRaw.learnedFromTxnId,
      scope: "merchant_amount",
      plaidAccountId: null,
      lo: bands.a[0],
      hi: bands.a[1],
      categoryId: cur.categoryId,
      count: cur.count,
    });
    const id = await upsertMemory(exec, {
      ...base,
      scope: "merchant_amount",
      plaidAccountId: null,
      lo: bands.b[0],
      hi: bands.b[1],
      categoryId,
      count: 1,
    });
    return { memoryId: id, created: true };
  }
  // Latest correction wins.
  await exec
    .update(merchantMemoryTable)
    .set({ categoryId, count: 1, lastConfirmedAt: new Date(), learnedFromTxnId: txn.id })
    .where(eq(merchantMemoryTable.id, cur.id));
  return { memoryId: cur.id, created: true };
}

/** Does a memory row's scope cover this row? */
export function memoryCovers(m: MemoryRow, r: { amount: string; plaidAccountId: string | null }): boolean {
  if (m.scope === "merchant_account") return !!m.plaidAccountId && m.plaidAccountId === r.plaidAccountId;
  if (m.scope === "merchant_amount") {
    const a = abs(r.amount);
    return m.amountBandLo != null && m.amountBandHi != null && a >= m.amountBandLo && a <= m.amountBandHi;
  }
  return true;
}

export async function loadMemory(householdId: string, id: string): Promise<MemoryRow & { disabledAt: Date | null; lastConfirmedAt: Date | null; source: string } | null> {
  const [m] = await db
    .select()
    .from(merchantMemoryTable)
    .where(and(eq(merchantMemoryTable.id, id), eq(merchantMemoryTable.householdId, householdId)));
  return m ? { ...toMemoryRow(m), disabledAt: m.disabledAt, lastConfirmedAt: m.lastConfirmedAt, source: m.source } : null;
}

/** Ids of unlocked rows a memory row would move if applied now. */
export async function memoryRetroactiveIds(householdId: string, m: MemoryRow): Promise<SigRow[]> {
  return (await rowsWithSignature(db, householdId, m.signature, { unlockedOnly: true })).filter(
    (r) => r.categoryId !== m.categoryId && memoryCovers(m, r),
  );
}


