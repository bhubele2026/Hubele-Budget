// (PR-A) ⭐ Categorization engine v2 — the batch.
//
// Stages (stages/, first that yields wins; see decide.ts):
//   locked     category_locked_by_user → skipped entirely (the flag is the audit)
//   memory     merchant_memory by merchantSignature (a correction beats a rule) 0.92 / 0.75
//   rule       household mapping_rules (user-authored), deterministic order     0.95 / 0.85
//   recurring  an active recurring item, name + amount                           0.90 / 0.70
//   inherited  the pending row's filing via effectiveFiling (write ≡ read)       0.95
//   heuristic  card payment / transfer / refund evidence → QUEUE only            0.50 / 0.55
//   model      ModelStage (AI-1); NullModelStage here                            ≤ 0.899
// Bands: auto ≥ 0.9 writes category_id; provisional 0.6–0.9 writes it, sets
// category_provisional and queues; < 0.6 leaves category_id and queues.
//
// What the engine may write (engineMayWrite): never a locked row; a row with
// no category; a row THIS sync just inserted (its category is the sync's own
// insert-time rule fill); or a row whose current category came from an engine
// decision that nobody accepted and that is more than 30 days old. A category
// with no decision on record (hand-typed before PR-0, imported, legacy rule
// fill) is never moved: we cannot tell who chose it.
//
// Idempotent: unique (transaction_id, input_hash) + ON CONFLICT DO NOTHING,
// and a decision identical to the row's latest live one is not re-recorded.
import { and, asc, eq, inArray, isNull, ne, gte, sql } from "drizzle-orm";
import {
  db,
  categoryDecisionsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, householdToday } from "@workspace/avalanche-core";
import { AUTO_MIN, bandFor, PROVISIONAL_MIN, REDECIDE_AFTER_DAYS } from "./bands";
import { inputHash, loadEngineContext, loadEngineRows, sha256 } from "./context";
import { decideRow } from "./decide";
import { ENGINE_ACTOR, type Exec } from "./db";
import type { ModelStage } from "./modelStage";
import type { Band, Decision, DecisionSource, EngineRow, StageResult } from "./types";

export { decideRow } from "./decide";
export { bandFor } from "./bands";
export type { Decision, EngineContext, EngineRow, StageResult } from "./types";
export { NullModelStage, type ModelStage } from "./modelStage";

const AUTOMATIC: ReadonlySet<DecisionSource> = new Set([
  "rule",
  "memory",
  "recurring",
  "inherited",
  "heuristic",
  "model",
  "refund",
]);

export interface HistoryRow {
  id: string;
  source: DecisionSource;
  categoryId: string | null;
  band: Band;
  resolution: string | null;
  undoneAt: Date | null;
  createdAt: Date;
  inputHash: string;
}

export interface RunOptions {
  /** Exactly these rows (sync passes the ids its upsert returned). */
  txnIds?: readonly string[];
  /** Otherwise every row dated on/after this day (default: the last 90 days). */
  since?: string;
  trigger: "sync" | "manual" | "job" | "test";
  /** Rows this sync INSERTED: their category is the sync's insert-time rule fill. */
  freshIds?: ReadonlySet<string>;
  now?: Date;
  /** Omitted: deterministic stages only (the sync path). */
  modelStage?: ModelStage;
  /**
   * (AI-1) The household's model gate is open (modelGate.ts): a `high` answer
   * may reach the auto band. Otherwise every model answer is clamped below it.
   */
  modelAutoAllowed?: boolean;
}

export interface BatchResult {
  decisions: Decision[];
  /** Rows no stage decided at ≥ 0.6 — the model stage's input. */
  ambiguous: string[];
}

function toDecision(r: typeof categoryDecisionsTable.$inferSelect): Decision {
  return {
    id: r.id,
    transactionId: r.transactionId,
    source: r.source as DecisionSource,
    categoryId: r.categoryId,
    previousCategoryId: r.previousCategoryId,
    confidence: Number(r.confidence),
    band: r.band as Band,
    explanation: r.explanation,
  };
}

export async function loadHistory(txnIds: readonly string[]): Promise<Map<string, HistoryRow[]>> {
  const out = new Map<string, HistoryRow[]>();
  for (let i = 0; i < txnIds.length; i += 1000) {
    const rows = await db
      .select({
        id: categoryDecisionsTable.id,
        transactionId: categoryDecisionsTable.transactionId,
        source: categoryDecisionsTable.source,
        categoryId: categoryDecisionsTable.categoryId,
        band: categoryDecisionsTable.band,
        resolution: categoryDecisionsTable.resolution,
        undoneAt: categoryDecisionsTable.undoneAt,
        createdAt: categoryDecisionsTable.createdAt,
        inputHash: categoryDecisionsTable.inputHash,
      })
      .from(categoryDecisionsTable)
      .where(inArray(categoryDecisionsTable.transactionId, txnIds.slice(i, i + 1000) as string[]))
      .orderBy(categoryDecisionsTable.createdAt, categoryDecisionsTable.id);
    for (const r of rows) {
      const list = out.get(r.transactionId) ?? [];
      list.push({ ...r, source: r.source as DecisionSource, band: r.band as Band });
      out.set(r.transactionId, list);
    }
  }
  return out;
}

/** The latest decision that is still in force (not undone). */
export function latestLive(hist: readonly HistoryRow[]): HistoryRow | null {
  for (let i = hist.length - 1; i >= 0; i -= 1) if (!hist[i]!.undoneAt) return hist[i]!;
  return null;
}

/**
 * ⭐ May a new decision write this row's category? (Documented in index.ts.)
 * Unlocked, and: no category yet; or inserted by this sync with no decision
 * yet; or its category came from an engine decision nobody accepted, more
 * than REDECIDE_AFTER_DAYS ago.
 */
export function engineMayWrite(
  row: Pick<EngineRow, "id" | "categoryId" | "categoryLockedByUser">,
  hist: readonly HistoryRow[],
  opts: { freshIds?: ReadonlySet<string>; now: Date },
): boolean {
  if (row.categoryLockedByUser) return false;
  if (row.categoryId == null) return true;
  if (opts.freshIds?.has(row.id) && hist.length === 0) return true;
  if (hist.some((h) => h.resolution === "accepted" && !h.undoneAt)) return false;
  const applied = [...hist]
    .reverse()
    .find((h) => !h.undoneAt && h.band !== "queue" && h.categoryId != null && (AUTOMATIC.has(h.source) || h.source === "user"));
  if (!applied || !AUTOMATIC.has(applied.source) || applied.categoryId !== row.categoryId) return false;
  return opts.now.getTime() - applied.createdAt.getTime() > REDECIDE_AFTER_DAYS * 86_400_000;
}

export type ApplyOutcome =
  | { decision: Decision }
  | { refused: "locked" | "changed" | "duplicate" | "gone" };

/**
 * Record one decision and apply it, atomically. Refuses a locked row (unless
 * the decision is the `locked` marker itself) and a row whose category moved
 * since it was read. Never writes `is_transfer`.
 */
export async function applyDecision(
  householdId: string,
  row: Pick<EngineRow, "id" | "categoryId" | "refundOfTxnId">,
  result: StageResult,
  hash: string,
  now: Date = new Date(),
): Promise<ApplyOutcome> {
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select({
        locked: transactionsTable.categoryLockedByUser,
        categoryId: transactionsTable.categoryId,
      })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.id, row.id), eq(transactionsTable.householdId, householdId)))
      .for("update");
    if (!cur) return { refused: "gone" as const };
    if (cur.locked && result.source !== "locked") return { refused: "locked" as const };
    if (cur.categoryId !== row.categoryId) return { refused: "changed" as const };
    const band: Band = result.source === "locked" ? "auto" : bandFor(result.confidence);
    const [ins] = await tx
      .insert(categoryDecisionsTable)
      .values({
        householdId,
        transactionId: row.id,
        source: result.source,
        categoryId: result.categoryId,
        previousCategoryId: cur.categoryId,
        confidence: result.confidence.toFixed(3),
        band,
        explanation: result.explanation,
        ruleId: result.ruleId ?? null,
        memoryId: result.memoryId ?? null,
        recurringItemId: result.recurringItemId ?? null,
        model: result.model ?? null,
        promptVersion: result.promptVersion ?? null,
        inputHash: hash,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [categoryDecisionsTable.transactionId, categoryDecisionsTable.inputHash],
      })
      .returning();
    if (!ins) return { refused: "duplicate" as const };
    // An older open decision for this row is superseded by this one.
    await tx
      .update(categoryDecisionsTable)
      .set({ resolvedAt: now, resolvedBy: ENGINE_ACTOR, resolution: "skipped" })
      .where(
        and(
          eq(categoryDecisionsTable.transactionId, row.id),
          isNull(categoryDecisionsTable.resolvedAt),
          isNull(categoryDecisionsTable.undoneAt),
          ne(categoryDecisionsTable.id, ins.id),
        ),
      );
    if (result.source !== "locked") {
      const set: Record<string, unknown> = {};
      if (band !== "queue" && result.categoryId) {
        set.categoryId = result.categoryId;
        set.categoryProvisional = band === "provisional";
        if (result.inheritedFiling) Object.assign(set, result.inheritedFiling);
      }
      if (result.refundOfTxnId && !row.refundOfTxnId) set.refundOfTxnId = result.refundOfTxnId;
      if (Object.keys(set).length > 0) {
        await tx
          .update(transactionsTable)
          .set(set)
          .where(
            and(
              eq(transactionsTable.id, row.id),
              eq(transactionsTable.householdId, householdId),
              eq(transactionsTable.categoryLockedByUser, false),
            ),
          );
      }
    }
    return { decision: toDecision(ins) };
  });
}

/**
 * A model's answer, validated by code before it can touch a row (CLAUDE.md §1).
 * Its category must be one of the household's. Unless the household's gate is
 * open (`autoAllowed`) the confidence is clamped below the auto band, so the
 * answer is at most provisional. An answer with no category is the model's
 * "this looks like a transfer": it is kept as a queue-only decision (never a
 * category, never `is_transfer`).
 */
export function validateModelResult(
  result: StageResult,
  allowedCategoryIds: ReadonlySet<string>,
  opts: { autoAllowed?: boolean } = {},
): StageResult | null {
  const c = Number(result.confidence);
  if (!Number.isFinite(c)) return null;
  const explanation = String(result.explanation ?? "").slice(0, 140) || "Suggested from similar charges.";
  if (result.categoryId == null) {
    return {
      source: "model",
      categoryId: null,
      confidence: Math.min(Math.max(c, 0), PROVISIONAL_MIN - 0.001),
      explanation,
      model: result.model ?? null,
      promptVersion: result.promptVersion ?? null,
    };
  }
  if (!allowedCategoryIds.has(result.categoryId)) return null;
  return {
    source: "model",
    categoryId: result.categoryId,
    confidence: Math.min(Math.max(c, 0), opts.autoAllowed ? 1 : AUTO_MIN - 0.001),
    explanation,
    model: result.model ?? null,
    promptVersion: result.promptVersion ?? null,
  };
}

/** ⭐ Run the engine over a household's rows. */
export async function runCategorizationBatch(
  householdId: string,
  opts: RunOptions,
): Promise<BatchResult> {
  const now = opts.now ?? new Date();
  let where;
  if (opts.txnIds) {
    if (opts.txnIds.length === 0) return { decisions: [], ambiguous: [] };
    where = inArray(transactionsTable.id, [...new Set(opts.txnIds)]);
  } else {
    where = gte(transactionsTable.occurredOn, opts.since ?? addDaysISO(householdToday(now), -90));
  }
  const rows = await loadEngineRows(householdId, where);
  if (rows.length === 0) return { decisions: [], ambiguous: [] };
  const history = await loadHistory(rows.map((r) => r.id));
  const ctx = await loadEngineContext(householdId, rows);

  const decisions: Decision[] = [];
  const ambiguous: EngineRow[] = [];
  const hashes = new Map<string, string>();
  for (const row of rows) {
    const hist = history.get(row.id) ?? [];
    const hash = inputHash(row, ctx);
    hashes.set(row.id, hash);
    if (hist.some((h) => h.inputHash === hash)) continue;
    // (Round 2) A locked row is skipped entirely: no decision row, the flag is the audit.
    if (row.categoryLockedByUser) continue;
    if (!engineMayWrite(row, hist, { freshIds: opts.freshIds, now })) continue;
    const result = decideRow(row, ctx);
    if (!result || bandFor(result.confidence) === "queue") ambiguous.push(row);
    if (!result) continue;
    const latest = latestLive(hist);
    if (
      latest &&
      latest.source === result.source &&
      latest.categoryId === result.categoryId &&
      latest.band === bandFor(result.confidence)
    ) {
      continue;
    }
    const out = await applyDecision(householdId, row, result, hash, now);
    if ("decision" in out) decisions.push(out.decision);
  }

  let stillAmbiguous = ambiguous;
  if (opts.modelStage && ambiguous.length > 0) {
    const allowed = new Set(
      [...ctx.spendCtx.categoriesById.keys()].filter((id) => !ctx.uncategorizedIds.has(id)),
    );
    // (AI-1) A row the model already answered for this exact input is not asked
    // again (a second run costs nothing); it stays ambiguous if its answer is
    // still waiting for a person.
    const modelHash = (r: EngineRow) => sha256(`model|${hashes.get(r.id)}`);
    const toAsk = ambiguous.filter((r) => !(history.get(r.id) ?? []).some((h) => h.inputHash === modelHash(r)));
    const answers = toAsk.length > 0 ? await opts.modelStage.decide(householdId, toAsk, ctx) : new Map<string, StageResult>();
    const decided = new Set<string>();
    for (const row of toAsk) {
      const raw = answers.get(row.id);
      const ok = raw ? validateModelResult(raw, allowed, { autoAllowed: opts.modelAutoAllowed }) : null;
      if (!ok) continue;
      const out = await applyDecision(householdId, row, ok, modelHash(row), now);
      if ("decision" in out) {
        decisions.push(out.decision);
        // A queue-band answer (low confidence, or "looks like a transfer") is
        // still a question for a person.
        if (out.decision.band !== "queue") decided.add(row.id);
      }
    }
    stillAmbiguous = ambiguous.filter((r) => !decided.has(r.id));
  }
  return { decisions, ambiguous: stillAmbiguous.map((r) => r.id) };
}

/** (V7) How many transaction ids one backlog slice runs over. */
export const BACKLOG_SLICE = 500;

/**
 * ⭐ (V7) "File everything up to today": the deterministic stages over EVERY
 * row of the household — `since` is the household's oldest `occurred_on` —
 * in slices of BACKLOG_SLICE ids, oldest first, so no one engine pass holds
 * more than a slice. Each slice is an ordinary `runCategorizationBatch`, so
 * `engineMayWrite` decides exactly as it does for the 90-day run: a locked row
 * or a row a person filed is never touched, and a second run records nothing.
 * No model here: the caller enqueues the model pass.
 */
export async function runCategorizationBacklog(
  householdId: string,
  opts: { now?: Date } = {},
): Promise<BatchResult & { since: string | null }> {
  const [o] = await db
    .select({ since: sql<string | null>`min(${transactionsTable.occurredOn})::text` })
    .from(transactionsTable)
    .where(eq(transactionsTable.householdId, householdId));
  const since = o?.since ?? null;
  if (!since) return { decisions: [], ambiguous: [], since: null };
  const ids = (
    await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.householdId, householdId), gte(transactionsTable.occurredOn, since)))
      .orderBy(asc(transactionsTable.occurredOn), asc(transactionsTable.createdAt), asc(transactionsTable.id))
  ).map((r) => r.id);
  const decisions: Decision[] = [];
  const ambiguous: string[] = [];
  for (let i = 0; i < ids.length; i += BACKLOG_SLICE) {
    const out = await runCategorizationBatch(householdId, {
      txnIds: ids.slice(i, i + BACKLOG_SLICE),
      trigger: "manual",
      ...(opts.now ? { now: opts.now } : {}),
    });
    decisions.push(...out.decisions);
    ambiguous.push(...out.ambiguous);
  }
  return { decisions, ambiguous, since };
}

// ── Notices: queue items that are not a category opinion ────────────────────

export type NoticeKind = "removed" | "split_needs_rebalance";

export const NOTICE_TEXT: Record<NoticeKind, string> = {
  removed: "The bank removed this charge.",
  split_needs_rebalance: "The bank changed this charge's amount, so its split no longer adds up.",
};

/** Queue a notice (`source='heuristic'`, no category). Idempotent per (row, key). */
export async function queueNotice(
  exec: Exec,
  householdId: string,
  txnId: string,
  kind: NoticeKind,
  key: string,
  previousCategoryId: string | null,
): Promise<void> {
  await exec
    .insert(categoryDecisionsTable)
    .values({
      householdId,
      transactionId: txnId,
      source: "heuristic",
      categoryId: null,
      previousCategoryId,
      confidence: "0.500",
      band: "queue",
      explanation: NOTICE_TEXT[kind],
      inputHash: sha256(`notice|${kind}|${key}`),
    })
    .onConflictDoNothing({
      target: [categoryDecisionsTable.transactionId, categoryDecisionsTable.inputHash],
    });
}

/**
 * (PR-A) Plaid `removed` guard, second half. The sync deletes an untouched row
 * as before; any row still holding a removed id was kept because a person had
 * worked it (category, lock, review, allowance flags, overrides, splits). It is
 * stamped `plaid_removed_at` and queued: "the bank removed this charge".
 */
export async function markRemovedRowsKept(
  householdId: string,
  removedPlaidIds: readonly string[],
): Promise<number> {
  if (removedPlaidIds.length === 0) return 0;
  const kept = await db
    .update(transactionsTable)
    .set({ plaidRemovedAt: sql`now()` })
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        inArray(transactionsTable.plaidTransactionId, [...removedPlaidIds]),
        isNull(transactionsTable.plaidRemovedAt),
      ),
    )
    .returning({ id: transactionsTable.id, categoryId: transactionsTable.categoryId });
  for (const r of kept) await queueNotice(db, householdId, r.id, "removed", "removed", r.categoryId);
  return kept.length;
}
