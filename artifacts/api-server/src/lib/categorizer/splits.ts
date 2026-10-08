// (PR-A) Transaction splits: one charge across several categories. Σ splits =
// the parent's amount to the cent; the parent keeps its own category and
// counts whole whenever its splits do not add up (or are flagged invalid).
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  categoryDecisionsTable,
  transactionSplitsTable,
  transactionsTable,
} from "@workspace/db";
import { NOTICE_TEXT, queueNotice } from "./index";
import { categoryBelongs } from "./userDecisions";

export const MAX_SPLITS = 20;
export const RESCALE_LIMIT_CENTS = 100;

export interface SplitInput {
  categoryId: string;
  amount: string | number;
  member?: string | null;
  note?: string | null;
}
export interface SplitPart {
  categoryId: string;
  amount: string;
}

export const centsOf = (a: string | number): number => Math.round((Number(a) || 0) * 100);
const fmt = (cents: number): string => (cents / 100).toFixed(2);

/** null when valid; otherwise a short reason. */
export function validateSplits(parentAmount: string, splits: readonly SplitInput[]): string | null {
  if (splits.length < 2) return "A split needs at least two parts.";
  if (splits.length > MAX_SPLITS) return `At most ${MAX_SPLITS} parts.`;
  const parent = centsOf(parentAmount);
  if (parent === 0) return "A $0 charge cannot be split.";
  let sum = 0;
  for (const s of splits) {
    const c = centsOf(s.amount);
    if (!Number.isFinite(Number(s.amount)) || c === 0) return "Every part needs an amount.";
    if (Math.sign(c) !== Math.sign(parent)) return "Every part must have the charge's sign.";
    sum += c;
  }
  if (sum !== parent) return `The parts add up to ${fmt(sum)}, not ${fmt(parent)}.`;
  return null;
}

/**
 * Proportional rescale onto a new parent total, exact to the cent: each part
 * rounds, the remainder goes to the largest part.
 */
export function rescaleSplits(parts: readonly number[], newTotal: number): number[] {
  const oldTotal = parts.reduce((a, b) => a + b, 0);
  if (oldTotal === 0) return [...parts];
  const out = parts.map((p) => Math.round((p * newTotal) / oldTotal));
  const diff = newTotal - out.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    let k = 0;
    for (let i = 1; i < out.length; i += 1) if (Math.abs(out[i]!) > Math.abs(out[k]!)) k = i;
    out[k] = out[k]! + diff;
  }
  return out;
}

/**
 * ⭐ The one loader readers use: row id → its parts, only for rows whose
 * splits add up to the row's amount. Every other row counts whole.
 */
export function expandSplits(
  rows: readonly { id: string; amount: string }[],
  splitsByTxn: ReadonlyMap<string, readonly SplitPart[]>,
): Map<string, SplitPart[]> {
  const out = new Map<string, SplitPart[]>();
  if (splitsByTxn.size === 0) return out;
  for (const r of rows) {
    const parts = splitsByTxn.get(r.id);
    if (!parts || parts.length === 0) continue;
    if (parts.reduce((a, p) => a + centsOf(p.amount), 0) !== centsOf(r.amount)) continue;
    out.set(r.id, [...parts]);
  }
  return out;
}

/** Splits of a household's valid split parents dated in [from, to]. */
export async function loadSplitsByTxn(
  householdId: string,
  range?: { from: string; to: string },
): Promise<Map<string, SplitPart[]>> {
  const rows = await db
    .select({
      transactionId: transactionSplitsTable.transactionId,
      categoryId: transactionSplitsTable.categoryId,
      amount: transactionSplitsTable.amount,
    })
    .from(transactionSplitsTable)
    .innerJoin(transactionsTable, eq(transactionsTable.id, transactionSplitsTable.transactionId))
    .where(
      and(
        eq(transactionSplitsTable.householdId, householdId),
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.splitsInvalid, false),
        range ? sql`${transactionsTable.occurredOn} >= ${range.from} AND ${transactionsTable.occurredOn} <= ${range.to}` : undefined,
      ),
    )
    .orderBy(transactionSplitsTable.createdAt, transactionSplitsTable.id);
  const out = new Map<string, SplitPart[]>();
  for (const r of rows) {
    const list = out.get(r.transactionId) ?? [];
    list.push({ categoryId: r.categoryId, amount: r.amount });
    out.set(r.transactionId, list);
  }
  return out;
}

export async function getSplits(householdId: string, txnId: string) {
  const [t] = await db
    .select({ id: transactionsTable.id, amount: transactionsTable.amount, splitsInvalid: transactionsTable.splitsInvalid })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.id, txnId), eq(transactionsTable.householdId, householdId)));
  if (!t) return null;
  const splits = await db
    .select()
    .from(transactionSplitsTable)
    .where(and(eq(transactionSplitsTable.transactionId, txnId), eq(transactionSplitsTable.householdId, householdId)))
    .orderBy(transactionSplitsTable.createdAt, transactionSplitsTable.id);
  return {
    transactionId: t.id,
    amount: t.amount,
    invalid: t.splitsInvalid,
    splits: splits.map((s) => ({
      id: s.id,
      categoryId: s.categoryId,
      amount: s.amount,
      member: s.member,
      note: s.note,
      source: s.source,
    })),
  };
}

async function resolveSplitNotices(exec: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0], txnId: string, actor: string) {
  await exec
    .update(categoryDecisionsTable)
    .set({ resolvedAt: new Date(), resolvedBy: actor, resolution: "corrected" })
    .where(
      and(
        eq(categoryDecisionsTable.transactionId, txnId),
        isNull(categoryDecisionsTable.resolvedAt),
        eq(categoryDecisionsTable.explanation, NOTICE_TEXT.split_needs_rebalance),
      ),
    );
}

/** Replace-all. The parent keeps its category and becomes locked (a person filed it). */
export async function replaceSplits(
  householdId: string,
  actor: string,
  txnId: string,
  splits: readonly SplitInput[],
): Promise<{ status: 200; body: NonNullable<Awaited<ReturnType<typeof getSplits>>> } | { status: 400 | 404; body: { error: string } }> {
  const [t] = await db
    .select({ id: transactionsTable.id, amount: transactionsTable.amount })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.id, txnId), eq(transactionsTable.householdId, householdId)));
  if (!t) return { status: 404, body: { error: "Not found" } };
  const bad = validateSplits(t.amount, splits);
  if (bad) return { status: 400, body: { error: bad } };
  for (const id of new Set(splits.map((s) => s.categoryId))) {
    if (!(await categoryBelongs(householdId, id))) return { status: 400, body: { error: "Unknown category." } };
  }
  await db.transaction(async (tx) => {
    await tx.delete(transactionSplitsTable).where(eq(transactionSplitsTable.transactionId, txnId));
    // created_at steps by 1 ms per part so reads keep the order they were given in.
    const t0 = Date.now();
    await tx.insert(transactionSplitsTable).values(
      splits.map((s, i) => ({
        createdAt: new Date(t0 + i),
        householdId,
        transactionId: txnId,
        categoryId: s.categoryId,
        amount: fmt(centsOf(s.amount)),
        member: s.member ?? null,
        note: s.note ?? null,
        source: "user",
        userId: actor,
      })),
    );
    await tx
      .update(transactionsTable)
      .set({ categoryLockedByUser: true, splitsInvalid: false, categoryProvisional: false })
      .where(eq(transactionsTable.id, txnId));
    await resolveSplitNotices(tx, txnId, actor);
  });
  return { status: 200, body: (await getSplits(householdId, txnId))! };
}

export async function deleteSplits(householdId: string, actor: string, txnId: string): Promise<boolean> {
  const [t] = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.id, txnId), eq(transactionsTable.householdId, householdId)));
  if (!t) return false;
  await db.transaction(async (tx) => {
    await tx.delete(transactionSplitsTable).where(eq(transactionSplitsTable.transactionId, txnId));
    await tx.update(transactionsTable).set({ splitsInvalid: false }).where(eq(transactionsTable.id, txnId));
    await resolveSplitNotices(tx, txnId, actor);
  });
  return true;
}

/**
 * After a Plaid upsert: a split parent whose amount moved by < $1 has its
 * splits rescaled proportionally (Σ stays exact); by $1 or more it is flagged
 * `splits_invalid` and queued — the parent counts whole meanwhile.
 */
export async function reconcileSplitsAfterSync(
  householdId: string,
  txnIds: readonly string[],
): Promise<{ rescaled: number; invalidated: number }> {
  const res = { rescaled: 0, invalidated: 0 };
  if (txnIds.length === 0) return res;
  const splits = await db
    .select({
      id: transactionSplitsTable.id,
      transactionId: transactionSplitsTable.transactionId,
      amount: transactionSplitsTable.amount,
      parentAmount: transactionsTable.amount,
      parentCategoryId: transactionsTable.categoryId,
      splitsInvalid: transactionsTable.splitsInvalid,
    })
    .from(transactionSplitsTable)
    .innerJoin(transactionsTable, eq(transactionsTable.id, transactionSplitsTable.transactionId))
    .where(
      and(
        eq(transactionSplitsTable.householdId, householdId),
        inArray(transactionSplitsTable.transactionId, [...new Set(txnIds)]),
      ),
    )
    .orderBy(transactionSplitsTable.createdAt, transactionSplitsTable.id);
  const byParent = new Map<string, typeof splits>();
  for (const s of splits) byParent.set(s.transactionId, [...(byParent.get(s.transactionId) ?? []), s]);
  for (const [txnId, parts] of byParent) {
    const parent = centsOf(parts[0]!.parentAmount);
    const sum = parts.reduce((a, p) => a + centsOf(p.amount), 0);
    if (sum === parent || parts[0]!.splitsInvalid) continue;
    if (Math.abs(parent - sum) < RESCALE_LIMIT_CENTS && Math.sign(parent) === Math.sign(sum)) {
      const next = rescaleSplits(parts.map((p) => centsOf(p.amount)), parent);
      await db.transaction(async (tx) => {
        for (const [i, p] of parts.entries()) {
          await tx.update(transactionSplitsTable).set({ amount: fmt(next[i]!) }).where(eq(transactionSplitsTable.id, p.id));
        }
      });
      res.rescaled += 1;
    } else {
      await db.update(transactionsTable).set({ splitsInvalid: true }).where(eq(transactionsTable.id, txnId));
      await queueNotice(db, householdId, txnId, "split_needs_rebalance", `${txnId}|${fmt(parent)}`, parts[0]!.parentCategoryId);
      res.invalidated += 1;
    }
  }
  return res;
}
