// (PR-A) Every hand write of `category_id` records a `user` decision. A hand
// choice (PATCH, correct, accept) also teaches merchant memory and returns the
// retroactive candidates — it never applies them.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  categoryDecisionsTable,
  transactionsTable,
  type DecisionRowFlags,
} from "@workspace/db";
import { isTransferCategory } from "../excludedCategory";
import type { Exec } from "./db";
import { learnFromChoice, retroactiveCandidates, type RetroactiveCandidates } from "./memory";

export interface UserChange {
  transactionId: string;
  previousCategoryId: string | null;
  categoryId: string | null;
  /** (Q2) The row's five flags before and after the write, so an undo can put back what it moved. */
  flagsBefore?: DecisionRowFlags | null;
  flagsAfter?: DecisionRowFlags | null;
}

/** (Q2) The five row flags a hand pick can move — the columns `DecisionRowFlags` keeps. */
export const DECISION_FLAG_COLUMNS = {
  isTransfer: transactionsTable.isTransfer,
  isTransferUserOverridden: transactionsTable.isTransferUserOverridden,
  weeklyAllowance: transactionsTable.weeklyAllowance,
  monthlyAllowance: transactionsTable.monthlyAllowance,
  unplannedAllowance: transactionsTable.unplannedAllowance,
} as const;

export const DECISION_FLAG_KEYS = Object.keys(DECISION_FLAG_COLUMNS) as Array<keyof DecisionRowFlags>;

/** (Q2) A row's five flags, read off any object that carries them. */
export function decisionFlagsOf(row: DecisionRowFlags): DecisionRowFlags {
  return {
    isTransfer: row.isTransfer === true,
    isTransferUserOverridden: row.isTransferUserOverridden === true,
    weeklyAllowance: row.weeklyAllowance === true,
    monthlyAllowance: row.monthlyAllowance === true,
    unplannedAllowance: row.unplannedAllowance === true,
  };
}

/** (Q2) The flags `setCategoryByHand` (and PATCH with `{ categoryId }`) leaves on a row. */
export function flagsAfterHandPick(before: DecisionRowFlags, pickingTransfer: boolean): DecisionRowFlags {
  return pickingTransfer
    ? { isTransfer: true, isTransferUserOverridden: true, weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false }
    : { ...before, isTransfer: false, isTransferUserOverridden: true };
}

/** Record `user` decisions for hand writes and close the rows' open queue items. */
export async function recordUserDecisions(
  exec: Exec,
  householdId: string,
  actor: string,
  changes: readonly UserChange[],
  opts: { explanation?: string; createdMemoryId?: string | null } = {},
): Promise<string[]> {
  if (changes.length === 0) return [];
  const now = new Date();
  const ids: string[] = [];
  for (let i = 0; i < changes.length; i += 500) {
    const chunk = changes.slice(i, i + 500);
    const rows = await exec
      .insert(categoryDecisionsTable)
      .values(
        chunk.map((c) => ({
          householdId,
          transactionId: c.transactionId,
          source: "user",
          categoryId: c.categoryId,
          previousCategoryId: c.previousCategoryId,
          confidence: "1.000",
          band: "auto",
          explanation:
            opts.explanation ?? (c.categoryId ? "You chose this category." : "You cleared this category."),
          inputHash: `user:${randomUUID()}`,
          resolvedAt: now,
          resolvedBy: actor,
          resolution: "corrected",
          resolvedVia: "user",
          createdMemoryId: opts.createdMemoryId ?? null,
          flagsBefore: c.flagsBefore ?? null,
          flagsAfter: c.flagsAfter ?? null,
          createdAt: now,
        })),
      )
      .returning({ id: categoryDecisionsTable.id });
    ids.push(...rows.map((r) => r.id));
    await exec
      .update(categoryDecisionsTable)
      .set({ resolvedAt: now, resolvedBy: actor, resolution: "corrected", resolvedVia: "user" })
      .where(
        and(
          inArray(categoryDecisionsTable.transactionId, chunk.map((c) => c.transactionId)),
          eq(categoryDecisionsTable.householdId, householdId),
          isNull(categoryDecisionsTable.resolvedAt),
          isNull(categoryDecisionsTable.undoneAt),
        ),
      );
  }
  return ids;
}

export async function categoryBelongs(householdId: string, categoryId: string): Promise<boolean> {
  const [c] = await db
    .select({ id: budgetCategoriesTable.id })
    .from(budgetCategoriesTable)
    .where(and(eq(budgetCategoriesTable.id, categoryId), eq(budgetCategoriesTable.householdId, householdId)));
  return !!c;
}

/**
 * The row write a hand pick makes — the same as `PATCH /transactions/:id`
 * with `{ categoryId }`: lock, clear provisional, mark the transfer flag as a
 * person's (picking the Transfer category makes it a transfer and clears the
 * allowance flags; any other category makes it not one).
 * (Q2) Returns the row's five flags before and after, for the `user` decision.
 */
export async function setCategoryByHand(
  householdId: string,
  txnId: string,
  categoryId: string,
): Promise<{ previousCategoryId: string | null; flagsBefore: DecisionRowFlags; flagsAfter: DecisionRowFlags } | null> {
  const pickingTransfer = await isTransferCategory(householdId, categoryId);
  return db.transaction((tx) => writeCategoryByHand(tx, householdId, txnId, categoryId, pickingTransfer));
}

/**
 * (Q2) `setCategoryByHand`'s write on an open transaction (the caller locks
 * nothing else): the row is locked FOR UPDATE, read, and written. Null when
 * the row is not the household's.
 */
export async function writeCategoryByHand(
  tx: Exec,
  householdId: string,
  txnId: string,
  categoryId: string,
  pickingTransfer: boolean,
): Promise<{ previousCategoryId: string | null; flagsBefore: DecisionRowFlags; flagsAfter: DecisionRowFlags } | null> {
  const [before] = await tx
    .select({ categoryId: transactionsTable.categoryId, ...DECISION_FLAG_COLUMNS })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.id, txnId), eq(transactionsTable.householdId, householdId)))
    .for("update");
  if (!before) return null;
  const flagsBefore = decisionFlagsOf(before);
  const flagsAfter = flagsAfterHandPick(flagsBefore, pickingTransfer);
  await tx
    .update(transactionsTable)
    .set(handPickPatch(categoryId, pickingTransfer))
    .where(and(eq(transactionsTable.id, txnId), eq(transactionsTable.householdId, householdId)));
  return { previousCategoryId: before.categoryId, flagsBefore, flagsAfter };
}

/**
 * ⭐ (Q2) THE COLUMNS A HAND PICK WRITES — the one definition `writeCategoryByHand`
 * writes and a proposed fix's dry run reads (`correctionOverlay.ts`), so the
 * preview and the write can never disagree: the category, locked, not
 * provisional, the transfer flag a person's (Transfer picked: a transfer, the
 * allowance flags cleared; any other category: not a transfer).
 */
export function handPickPatch(
  categoryId: string,
  pickingTransfer: boolean,
): {
  categoryId: string;
  categoryLockedByUser: true;
  categoryProvisional: false;
  isTransferUserOverridden: true;
  isTransfer: boolean;
  weeklyAllowance?: false;
  monthlyAllowance?: false;
  unplannedAllowance?: false;
} {
  return {
    categoryId,
    categoryLockedByUser: true,
    categoryProvisional: false,
    isTransferUserOverridden: true,
    isTransfer: pickingTransfer,
    ...(pickingTransfer ? { weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false } : {}),
  };
}

export interface HandFilingResult {
  decisionId: string;
  /** The merchant_memory row this choice created, re-pointed or confirmed; null when it taught nothing. */
  learnedRuleId: string | null;
  retroactiveCandidates: RetroactiveCandidates | null;
}

/**
 * ⭐ After a person set a row's category (PATCH, correct, accept): record the
 * `user` decision, resolve the row's open queue items (the one being answered
 * gets `resolution`), learn merchant memory, and report — never apply — the
 * retroactive candidates.
 */
export async function recordHandFiling(
  householdId: string,
  actor: string,
  txnId: string,
  opts: {
    previousCategoryId: string | null;
    categoryId: string | null;
    answering?: { decisionId: string; resolution: "accepted" | "corrected" };
    /** (Q2) The row's five flags before and after the write (undo restores what moved). */
    flagsBefore?: DecisionRowFlags | null;
    flagsAfter?: DecisionRowFlags | null;
  },
): Promise<HandFilingResult | null> {
  const [txn] = await db
    .select({
      id: transactionsTable.id,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      // (F2) Memory is sign-aware: which way the money moved reads the amount by source.
      source: transactionsTable.source,
      plaidAccountId: transactionsTable.plaidAccountId,
    })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.id, txnId), eq(transactionsTable.householdId, householdId)));
  if (!txn) return null;
  return db.transaction(async (tx) => {
    const learned = await learnFromChoice(tx, householdId, txn, opts.categoryId);
    const createdMemoryId = learned?.created ? learned.memoryId : null;
    if (opts.answering) {
      await tx
        .update(categoryDecisionsTable)
        .set({
          resolvedAt: new Date(),
          resolvedBy: actor,
          resolution: opts.answering.resolution,
          resolvedVia: "user",
          createdMemoryId,
        })
        .where(
          and(
            eq(categoryDecisionsTable.id, opts.answering.decisionId),
            eq(categoryDecisionsTable.householdId, householdId),
          ),
        );
    }
    const [decisionId] = await recordUserDecisions(
      tx,
      householdId,
      actor,
      [
        {
          transactionId: txnId,
          previousCategoryId: opts.previousCategoryId,
          categoryId: opts.categoryId,
          flagsBefore: opts.flagsBefore ?? null,
          flagsAfter: opts.flagsAfter ?? null,
        },
      ],
      { createdMemoryId },
    );
    return {
      decisionId: decisionId!,
      learnedRuleId: learned?.memoryId ?? null,
      retroactiveCandidates: opts.categoryId
        ? await retroactiveCandidates(householdId, txn, opts.categoryId)
        : null,
    };
  });
}

export interface DecisionHistoryRow {
  id: string;
  transactionId: string;
  source: string;
  categoryId: string | null;
  previousCategoryId: string | null;
  confidence: number;
  band: string;
  explanation: string;
  resolution: string | null;
  undoneAt: string | null;
  createdAt: string;
}

export const DECISION_HISTORY_MAX = 20;

/**
 * (PR-A2) How one charge was filed: its decisions, newest first, at most
 * DECISION_HISTORY_MAX. Null when the charge is not in the household.
 */
export async function listDecisionHistory(
  householdId: string,
  txnId: string,
): Promise<DecisionHistoryRow[] | null> {
  const [txn] = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.id, txnId), eq(transactionsTable.householdId, householdId)));
  if (!txn) return null;
  const rows = await db
    .select()
    .from(categoryDecisionsTable)
    .where(and(eq(categoryDecisionsTable.transactionId, txnId), eq(categoryDecisionsTable.householdId, householdId)))
    .orderBy(desc(categoryDecisionsTable.createdAt), desc(categoryDecisionsTable.id))
    .limit(DECISION_HISTORY_MAX);
  return rows.map((d) => ({
    id: d.id,
    transactionId: d.transactionId,
    source: d.source,
    categoryId: d.categoryId,
    previousCategoryId: d.previousCategoryId,
    confidence: Number(d.confidence),
    band: d.band,
    explanation: d.explanation,
    resolution: d.resolution,
    undoneAt: d.undoneAt ? d.undoneAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  }));
}
