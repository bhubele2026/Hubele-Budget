import { and, count, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import {
  db,
  bankAutoMatchDeclinesTable,
  budgetCategoriesTable,
  categoryDecisionsTable,
  forecastClosedMonthsTable,
  forecastResolutionsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, withinStrictTolerance } from "@workspace/avalanche-core";
import { computeCashSignalDetailed } from "./cashSignal";
import type { ForecastLedger, LedgerPlanOccurrence } from "./forecastLedger";
import { POSITION_HORIZON_DAYS } from "./moneyPosition";
import { readUnresolvedBankRows, type UnresolvedBankRow } from "./unresolvedBankRows";
import { resolutionNeighbours, writeForecastResolution } from "./forecastResolutionWrite";
import { ENGINE_ACTOR } from "./categorizer/db";
import { AUTO_MIN } from "./categorizer/bands";
import { rowsWithSignatures } from "./categorizer/memory";
import { directionConflictsOf } from "./categorizer/review";
import { PROMOTE_HASH_LIKE, promoteHashOf } from "./categorizer/promote";
import { memoryDirectionOf, merchantSignature } from "./merchantNameExtract";

/**
 * ⭐ (BANK-AUTO) NEW BANK ROWS ARRIVE ALREADY SORTED WHEN H2 IS SURE.
 *
 * The owner: reconciling and categorizing were unclear — six "to do" counts,
 * and rows the forecast had already paired still needed a click. After every
 * bank sync (the `txn.arrived` job) and on the owner's `POST /banking/auto-sort`:
 *
 *   MATCH — a bank row on the forecast's account, dated through today, NOT
 *   pending, with no deciding answer (the badge's own rule,
 *   `readUnresolvedBankRows`), no answer of any kind on it or on its plan
 *   occurrence, no "Not this" on the pair, never handed back by a person
 *   (`bank_auto_match_declines`), not in a closed month, and either
 *     (A) LEDGER: the forecast ledger paired it with exactly ONE plan
 *         occurrence unambiguously — a tier-1/2 pair (`planMatch.ts`), not
 *         ambiguous, taken off the curve, paying the plan within
 *         max($1, 1%), the row in no other pair or payment allocation and
 *         the occurrence in no other pair; or
 *     (B) ONE OBVIOUS CANDIDATE: exactly one high-confidence open plan for the
 *         row that no other waiting row also wants high — the one-click Match
 *         rule (`pickOneClickBankMatches` over `suggestPlanMatchesForBank`,
 *         h2budget/src/lib/forecastMatch.ts), ported here, never imported;
 *   gets a `matched` answer with `source = 'auto'`. Never a partial, never
 *   "not in the plan", never anything for an ambiguous row. An everyday hook
 *   (Weekly / Monthly Spend) is never matched: card payments pay it.
 *
 *   CATEGORY — an open PROVISIONAL decision (0.6–0.9: written, flagged, queued)
 *   whose merchant the household has filed by hand at least twice, every time
 *   in that same category (locked rows of the same merchant signature, same
 *   direction of money), is promoted: a new `auto`-band decision of the same
 *   stage (`input_hash = promote:<decision id>`), the provisional one closed as
 *   superseded, the row no longer provisional. Conflicting history stays in the
 *   queue. A transfer, a card or debt payment, a split that no longer adds up,
 *   an excluded or debt category and a pick against the money's direction are
 *   never promoted — they keep their existing handling.
 *
 * Undo is the same as for a hand answer: `POST /forecast/resolutions/:id/undo`
 * (restore []) or DELETE for a match — which also records the row in
 * `bank_auto_match_declines`, so it is never matched automatically again — and
 * `POST /category-decisions/:id/undo` for a category, which puts the row back in
 * the queue as it was.
 *
 * Idempotent: a matched row is decided, a promoted decision is closed and its
 * `promote:` hash is unique, so a second run writes nothing. Every write runs
 * under one per-household advisory lock. Code decides everything here; no
 * model is asked and no amount is written.
 */

export const AUTO_SORT_SOURCE = "auto" as const;
/** At most this many provisional decisions are looked at per run (newest first). */
export const PROMOTE_SCAN_LIMIT = 500;
/** A merchant filed by hand at least this many times, always the same way, is sure. */
export const PROMOTE_MIN_CONFIRMED = 2;

// ── The one-click rule, ported (pure) ────────────────────────────────────────

export type PickConfidence = "high" | "medium" | "low";

export interface PickRow {
  id: string;
  date: string;
  /** Signed: negative is money out. */
  amount: number;
  description: string;
}

export interface PickPlan {
  /** `<itemId>|<occurrenceDate>`. */
  key: string;
  /** The date it lands on (after any reschedule). */
  date: string;
  /** Signed, as planned. */
  amount: number;
  label: string;
}

export interface PlanPick {
  plan: PickPlan;
  score: number;
  confidence: PickConfidence;
  daysAway: number;
  amountDelta: number;
  labelMatch: boolean;
}

const dayNum = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/**
 * `suggestPlanMatchesForBank` (forecastMatch.ts), ported: amount sign, amount
 * closeness and date proximity, a small bonus when a 4+ character word of the
 * plan's label is in the row's description. Lower score is better.
 *   high:   exact amount (within $0.01) within 5 days, or exact with a label word within 14;
 *   medium: exact within 14 days, or within 2% and 7 days;
 *   low:    otherwise.
 * The caller passes only the OPEN plans the ledger did not pair, less any pair
 * the household answered "Not this".
 */
export function suggestPlansForRow(row: PickRow, plans: readonly PickPlan[], opts: { maxDays?: number; limit?: number } = {}): PlanPick[] {
  const maxDays = opts.maxDays ?? 14;
  const limit = opts.limit ?? 3;
  const wantSign = Math.sign(row.amount);
  if (!wantSign) return [];
  const want = Math.abs(row.amount);
  const desc = (row.description ?? "").toLowerCase();
  const out: PlanPick[] = [];
  for (const p of plans) {
    if (Math.sign(p.amount) !== wantSign) continue;
    const daysAway = Math.round(Math.abs(dayNum(p.date) - dayNum(row.date)));
    if (daysAway > maxDays) continue;
    const amountDelta = Math.round(Math.abs(Math.abs(p.amount) - want) * 100) / 100;
    const relDelta = want > 0 ? amountDelta / want : amountDelta;
    const tokens = (p.label ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    const labelMatch = tokens.some((t) => desc.includes(t));
    const score = amountDelta * 100 + daysAway - (labelMatch ? 2 : 0);
    let confidence: PickConfidence;
    if (amountDelta < 0.01 && daysAway <= 5) confidence = "high";
    else if (amountDelta < 0.01 && labelMatch && daysAway <= maxDays) confidence = "high";
    else if (amountDelta < 0.01 && daysAway <= maxDays) confidence = "medium";
    else if (relDelta <= 0.02 && daysAway <= 7) confidence = "medium";
    else confidence = "low";
    out.push({ plan: p, score, confidence, daysAway, amountDelta, labelMatch });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, limit);
}

/**
 * `pickOneClickBankMatches` (forecastMatch.ts), ported: a row qualifies when it
 * has exactly ONE high-confidence suggestion and no OTHER row has that plan as a
 * high-confidence suggestion. Ties and contests are left to the household.
 */
export function pickOneObvious(suggestions: ReadonlyMap<string, readonly PlanPick[]>): Map<string, PlanPick> {
  const claims = new Map<string, number>();
  for (const sugs of suggestions.values()) {
    const seen = new Set<string>();
    for (const s of sugs) {
      if (s.confidence !== "high" || seen.has(s.plan.key)) continue;
      seen.add(s.plan.key);
      claims.set(s.plan.key, (claims.get(s.plan.key) ?? 0) + 1);
    }
  }
  const out = new Map<string, PlanPick>();
  for (const [txnId, sugs] of suggestions) {
    const highs = sugs.filter((s) => s.confidence === "high");
    if (highs.length !== 1) continue;
    const only = highs[0]!;
    if ((claims.get(only.plan.key) ?? 0) > 1) continue;
    out.set(txnId, only);
  }
  return out;
}

// ── Reading what the ledger decided ─────────────────────────────────────────

/** The fates of an occurrence nothing has paid or answered yet. */
const OPEN_FATES: ReadonlySet<string> = new Set(["on_curve", "overdue_outside", "income_not_arrived"]);

export interface MatchSuggestion {
  planKey: string;
  recurringItemId: string;
  occurrenceDate: string;
  label: string;
  dueDate: string;
  /** Signed, as planned (null when the plan's amount is not known). */
  amount: number | null;
  confidence: PickConfidence;
}

export interface MatchPlanning {
  ledger: ForecastLedger;
  /** The rows waiting for a match, the window the ledger compares (rowsFrom–today). */
  rows: UnresolvedBankRow[];
  /** What H2 would suggest for each waiting row (the ledger's pair first, else the best open plan). */
  suggestionByTxn: Map<string, MatchSuggestion>;
  /** The rows H2 is sure of, with the plan and why. */
  sure: Array<{ row: UnresolvedBankRow; plan: MatchSuggestion; why: "ledger" | "one_obvious" }>;
}

const toSuggestion = (o: LedgerPlanOccurrence, confidence: PickConfidence): MatchSuggestion => ({
  planKey: o.planKey,
  recurringItemId: o.itemId,
  occurrenceDate: o.occurrenceDate,
  label: o.label,
  dueDate: o.dueDate,
  amount: o.amount,
  confidence,
});

/**
 * ⭐ Which waiting rows H2 is sure of (rules A and B in the header), and a
 * suggestion for every waiting row. Reads only: the ledger (the spine's own
 * call), the waiting rows of the ledger's comparison window, the household's
 * "Not this" answers, its declines and its closed months.
 */
export async function planBankMatches(
  householdId: string,
  ownerUserId: string,
  opts: { ledger?: ForecastLedger } = {},
): Promise<MatchPlanning> {
  const ledger = opts.ledger ?? (await computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS })).ledger;
  const today = ledger.todayISO;
  const from = ledger.planComparison.rowsFromISO;
  const [waiting, rejected, declines, closed] = await Promise.all([
    readUnresolvedBankRows(householdId, ownerUserId, { from, to: today }),
    db
      .select({
        recurringItemId: forecastResolutionsTable.recurringItemId,
        occurrenceDate: forecastResolutionsTable.occurrenceDate,
        matchedTxnId: forecastResolutionsTable.matchedTxnId,
      })
      .from(forecastResolutionsTable)
      .where(and(eq(forecastResolutionsTable.householdId, householdId), eq(forecastResolutionsTable.status, "not_match"))),
    db
      .select({ txnId: bankAutoMatchDeclinesTable.txnId })
      .from(bankAutoMatchDeclinesTable)
      .where(eq(bankAutoMatchDeclinesTable.householdId, householdId)),
    db
      .select({ monthKey: forecastClosedMonthsTable.monthKey })
      .from(forecastClosedMonthsTable)
      .where(eq(forecastClosedMonthsTable.householdId, householdId)),
  ]);
  const rows = waiting.rows;
  const rejectedPairs = new Set(rejected.map((r) => `${r.recurringItemId}|${r.occurrenceDate}#${r.matchedTxnId}`));
  const declined = new Set(declines.map((d) => d.txnId));
  const closedMonths = new Set(closed.map((c) => c.monthKey));

  const occByKey = new Map(ledger.planOccurrences.map((o) => [o.planKey, o] as const));
  const matchesByTxn = new Map<string, number>();
  const matchesByPlan = new Map<string, number>();
  for (const m of ledger.matches) {
    matchesByTxn.set(m.txnId, (matchesByTxn.get(m.txnId) ?? 0) + 1);
    matchesByPlan.set(m.planKey, (matchesByPlan.get(m.planKey) ?? 0) + 1);
  }
  const allocatedPlans = new Set<string>();
  for (const list of ledger.paymentAllocations.values()) for (const a of list) allocatedPlans.add(a.planKey);

  const suggestionByTxn = new Map<string, MatchSuggestion>();
  const ledgerSure = new Map<string, MatchSuggestion>();
  const pairedTxns = new Set<string>();
  for (const m of ledger.matches) {
    const o = occByKey.get(m.planKey);
    if (!o) continue;
    pairedTxns.add(m.txnId);
    if (!suggestionByTxn.has(m.txnId) && !rejectedPairs.has(`${m.planKey}#${m.txnId}`)) {
      suggestionByTxn.set(m.txnId, toSuggestion(o, m.tier <= 2 && !m.ambiguous ? "high" : m.confidence));
    }
    const unambiguous =
      m.tier <= 2 &&
      !m.ambiguous &&
      m.offCurve &&
      withinStrictTolerance(m.planAmount, m.txnAmount) &&
      (ledger.remainderByPlanKey.get(m.planKey) ?? 0) === 0 &&
      matchesByTxn.get(m.txnId) === 1 &&
      matchesByPlan.get(m.planKey) === 1 &&
      !ledger.paymentAllocations.has(m.txnId) &&
      !allocatedPlans.has(m.planKey) &&
      !o.hookCadence;
    if (unambiguous) ledgerSure.set(m.txnId, toSuggestion(o, "high"));
  }

  // Rule B: the open plans nobody paired, the waiting rows nobody paired.
  const openPlans: PickPlan[] = ledger.planOccurrences
    .filter(
      (o) =>
        OPEN_FATES.has(o.fate) &&
        !o.txnId &&
        !o.hookCadence &&
        o.amount != null &&
        o.amount !== 0 &&
        !matchesByPlan.has(o.planKey) &&
        !allocatedPlans.has(o.planKey),
    )
    .map((o) => ({ key: o.planKey, date: o.dueDate, amount: o.amount!, label: o.label }));
  const picks = new Map<string, PlanPick[]>();
  for (const r of rows) {
    if (pairedTxns.has(r.id)) continue;
    const open = rejectedPairs.size === 0 ? openPlans : openPlans.filter((p) => !rejectedPairs.has(`${p.key}#${r.id}`));
    const sugs = suggestPlansForRow({ id: r.id, date: r.occurredOn, amount: Number(r.amount), description: r.description }, open);
    picks.set(r.id, sugs);
    const best = sugs[0];
    if (best && !suggestionByTxn.has(r.id)) {
      const o = occByKey.get(best.plan.key);
      if (o) suggestionByTxn.set(r.id, toSuggestion(o, best.confidence));
    }
  }
  const obvious = pickOneObvious(picks);

  const sure: MatchPlanning["sure"] = [];
  for (const r of rows) {
    if (r.pending || r.occurredOn > today || r.occurredOn < from) continue;
    if (declined.has(r.id) || closedMonths.has(r.occurredOn.slice(0, 7))) continue;
    const viaLedger = ledgerSure.get(r.id);
    if (viaLedger) {
      sure.push({ row: r, plan: viaLedger, why: "ledger" });
      continue;
    }
    const pick = obvious.get(r.id);
    const o = pick ? occByKey.get(pick.plan.key) : undefined;
    if (o) sure.push({ row: r, plan: toSuggestion(o, "high"), why: "one_obvious" });
  }
  return { ledger, rows, suggestionByTxn, sure };
}

// ── Category: merchant memory agrees ─────────────────────────────────────────

export interface PromotionCandidate {
  decisionId: string;
  txnId: string;
  categoryId: string;
  source: string;
  confidence: string;
  /** How many hand-filed rows of the merchant agree. */
  confirmed: number;
}

/**
 * ⭐ The open provisional decisions whose merchant the household filed by hand
 * at least PROMOTE_MIN_CONFIRMED times, always in the suggested category (see
 * the header for what is never promoted). Reads only.
 */
export async function planCategoryPromotions(householdId: string): Promise<PromotionCandidate[]> {
  const open = await db
    .select({
      decisionId: categoryDecisionsTable.id,
      txnId: categoryDecisionsTable.transactionId,
      categoryId: categoryDecisionsTable.categoryId,
      source: categoryDecisionsTable.source,
      confidence: categoryDecisionsTable.confidence,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      txSource: transactionsTable.source,
      rowCategoryId: transactionsTable.categoryId,
      locked: transactionsTable.categoryLockedByUser,
      provisional: transactionsTable.categoryProvisional,
      isTransfer: transactionsTable.isTransfer,
      cardPayment: transactionsTable.isExternalCardPayment,
      debtId: transactionsTable.debtId,
      splitsInvalid: transactionsTable.splitsInvalid,
    })
    .from(categoryDecisionsTable)
    .innerJoin(transactionsTable, eq(transactionsTable.id, categoryDecisionsTable.transactionId))
    .where(
      and(
        eq(categoryDecisionsTable.householdId, householdId),
        eq(transactionsTable.householdId, householdId),
        eq(categoryDecisionsTable.band, "provisional"),
        isNull(categoryDecisionsTable.resolvedAt),
        isNull(categoryDecisionsTable.undoneAt),
        sql`${categoryDecisionsTable.categoryId} IS NOT NULL`,
        inArray(categoryDecisionsTable.source, ["memory", "rule", "recurring", "inherited", "model"]),
        // Promoted once and undone: the household decides it now.
        sql`NOT EXISTS (
          SELECT 1 FROM category_decisions p
           WHERE p.transaction_id = ${categoryDecisionsTable.transactionId}
             AND p.input_hash = ${"promote:"} || ${categoryDecisionsTable.id}::text
        )`,
      ),
    )
    .orderBy(desc(categoryDecisionsTable.createdAt), desc(categoryDecisionsTable.id))
    .limit(PROMOTE_SCAN_LIMIT);
  const eligible = open.filter(
    (d) =>
      !d.locked &&
      d.rowCategoryId === d.categoryId &&
      !d.isTransfer &&
      !d.cardPayment &&
      !d.debtId &&
      !d.splitsInvalid &&
      merchantSignature(d.description) !== "",
  );
  if (eligible.length === 0) return [];
  const [cats, history] = await Promise.all([
    db
      .select({ id: budgetCategoriesTable.id, excluded: budgetCategoriesTable.excludeFromBudget, debtId: budgetCategoriesTable.debtId })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, householdId)),
    rowsWithSignatures(
      db,
      householdId,
      eligible.map((d) => merchantSignature(d.description)),
    ),
  ]);
  const catById = new Map(cats.map((c) => [c.id, c] as const));
  const out: PromotionCandidate[] = [];
  for (const d of eligible) {
    const cat = catById.get(d.categoryId!);
    if (!cat || cat.excluded || cat.debtId) continue;
    const direction = memoryDirectionOf({ amount: d.amount, source: d.txSource });
    const confirmed = (history.get(merchantSignature(d.description)) ?? []).filter(
      (r) => r.id !== d.txnId && r.categoryLockedByUser && r.categoryId != null && memoryDirectionOf(r) === direction,
    );
    if (confirmed.length < PROMOTE_MIN_CONFIRMED) continue;
    if (!confirmed.every((r) => r.categoryId === d.categoryId)) continue;
    out.push({
      decisionId: d.decisionId,
      txnId: d.txnId,
      categoryId: d.categoryId!,
      source: d.source,
      confidence: d.confidence,
      confirmed: confirmed.length,
    });
  }
  // The direction guard the review queue uses: never file money against its direction.
  const byCategory = new Map<string, PromotionCandidate[]>();
  for (const c of out) byCategory.set(c.categoryId, [...(byCategory.get(c.categoryId) ?? []), c]);
  const conflicted = new Set<string>();
  for (const [categoryId, list] of byCategory) {
    const conflicts = await directionConflictsOf(householdId, list.map((c) => c.txnId), categoryId);
    for (const id of conflicts.keys()) conflicted.add(id);
  }
  return out.filter((c) => !conflicted.has(c.txnId));
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface AutoSortMatched {
  resolutionId: string | null;
  txnId: string;
  date: string;
  amount: string;
  planKey: string;
  recurringItemId: string;
  occurrenceDate: string;
  label: string;
  why: "ledger" | "one_obvious";
}

export interface AutoSortCategorized {
  decisionId: string | null;
  promotedDecisionId: string;
  txnId: string;
  categoryId: string;
  confirmed: number;
}

export interface AutoSortResult {
  dryRun: boolean;
  matched: AutoSortMatched[];
  categorized: AutoSortCategorized[];
}

/** One per-household lock for every auto-sort write, so a sync and a button press never both write. */
const lockHousehold = (tx: { execute: typeof db.execute }, householdId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bank-auto-sort:${householdId}`}))`);

/**
 * ⭐ Run the auto-sort for one household. `dryRun` reads and reports what it
 * would write, and writes nothing. Each write re-checks, under the lock, that
 * nothing answered the row, its occurrence or the pair since it was read.
 */
export async function runBankAutoSort(
  householdId: string,
  ownerUserId: string,
  opts: { dryRun?: boolean; ledger?: ForecastLedger } = {},
): Promise<AutoSortResult> {
  const dryRun = opts.dryRun === true;
  const [plan, promotions] = await Promise.all([
    planBankMatches(householdId, ownerUserId, opts.ledger ? { ledger: opts.ledger } : {}),
    planCategoryPromotions(householdId),
  ]);
  const matched: AutoSortMatched[] = [];
  const categorized: AutoSortCategorized[] = [];
  const toMatched = (s: MatchPlanning["sure"][number], resolutionId: string | null): AutoSortMatched => ({
    resolutionId,
    txnId: s.row.id,
    date: s.row.occurredOn,
    amount: s.row.amount,
    planKey: s.plan.planKey,
    recurringItemId: s.plan.recurringItemId,
    occurrenceDate: s.plan.occurrenceDate,
    label: s.plan.label,
    why: s.why,
  });

  if (dryRun) {
    for (const s of plan.sure) {
      const input = { userId: ownerUserId, householdId, recurringItemId: s.plan.recurringItemId, occurrenceDate: s.plan.occurrenceDate, status: "matched", matchedTxnId: s.row.id };
      if ((await resolutionNeighbours(input)).length === 0) matched.push(toMatched(s, null));
    }
    for (const p of promotions) {
      categorized.push({ decisionId: null, promotedDecisionId: p.decisionId, txnId: p.txnId, categoryId: p.categoryId, confirmed: p.confirmed });
    }
    return { dryRun, matched, categorized };
  }

  if (plan.sure.length > 0) {
    await db.transaction(async (tx) => {
      await lockHousehold(tx, householdId);
      const declined = new Set(
        (
          await tx
            .select({ txnId: bankAutoMatchDeclinesTable.txnId })
            .from(bankAutoMatchDeclinesTable)
            .where(and(eq(bankAutoMatchDeclinesTable.householdId, householdId), inArray(bankAutoMatchDeclinesTable.txnId, plan.sure.map((s) => s.row.id))))
        ).map((d) => d.txnId),
      );
      for (const s of plan.sure) {
        if (declined.has(s.row.id)) continue;
        const input = {
          userId: ownerUserId,
          householdId,
          recurringItemId: s.plan.recurringItemId,
          occurrenceDate: s.plan.occurrenceDate,
          status: "matched",
          matchedTxnId: s.row.id,
          source: AUTO_SORT_SOURCE,
        };
        // Nothing may be replaced: an answer on the row, on the occurrence or a
        // "Not this" on the pair means a person is deciding it.
        if ((await resolutionNeighbours(input, tx)).length > 0) continue;
        const { row, deleted } = await writeForecastResolution(tx, input);
        if (deleted.length > 0) throw new Error("bank auto-sort: a match replaced an answer");
        matched.push(toMatched(s, row.id));
      }
    });
  }

  for (const p of promotions) {
    const done = await db.transaction(async (tx) => {
      await lockHousehold(tx, householdId);
      const [t] = await tx
        .select({ categoryId: transactionsTable.categoryId, locked: transactionsTable.categoryLockedByUser })
        .from(transactionsTable)
        .where(and(eq(transactionsTable.id, p.txnId), eq(transactionsTable.householdId, householdId)))
        .for("update");
      if (!t || t.locked || t.categoryId !== p.categoryId) return null;
      const [d] = await tx
        .select({ id: categoryDecisionsTable.id })
        .from(categoryDecisionsTable)
        .where(
          and(
            eq(categoryDecisionsTable.id, p.decisionId),
            eq(categoryDecisionsTable.householdId, householdId),
            isNull(categoryDecisionsTable.resolvedAt),
            isNull(categoryDecisionsTable.undoneAt),
          ),
        );
      if (!d) return null;
      const now = new Date();
      const [ins] = await tx
        .insert(categoryDecisionsTable)
        .values({
          householdId,
          transactionId: p.txnId,
          source: p.source,
          categoryId: p.categoryId,
          previousCategoryId: t.categoryId,
          confidence: Math.max(Number(p.confidence), AUTO_MIN).toFixed(3),
          band: "auto",
          explanation: `Filed automatically: you filed this merchant here ${p.confirmed} times.`,
          inputHash: promoteHashOf(p.decisionId),
          createdAt: now,
        })
        .onConflictDoNothing({ target: [categoryDecisionsTable.transactionId, categoryDecisionsTable.inputHash] })
        .returning({ id: categoryDecisionsTable.id });
      if (!ins) return null;
      // The provisional decision is superseded by this one (as a newer engine decision supersedes).
      await tx
        .update(categoryDecisionsTable)
        .set({ resolvedAt: now, resolvedBy: ENGINE_ACTOR, resolution: "skipped" })
        .where(eq(categoryDecisionsTable.id, p.decisionId));
      await tx
        .update(transactionsTable)
        .set({ categoryProvisional: false })
        .where(and(eq(transactionsTable.id, p.txnId), eq(transactionsTable.householdId, householdId)));
      return ins.id;
    });
    if (done) categorized.push({ decisionId: done, promotedDecisionId: p.decisionId, txnId: p.txnId, categoryId: p.categoryId, confirmed: p.confirmed });
  }
  return { dryRun, matched, categorized };
}

// ── What it did ──────────────────────────────────────────────────────────────

export const AUTO_DONE_DEFAULT_DAYS = 7;
export const AUTO_DONE_MAX = 100;

export interface AutoDoneItem {
  kind: "match" | "category";
  /** The answer (match) or decision (category) to undo. */
  undoId: string;
  txnId: string;
  at: string;
  /** Match: the plan's key and label. Category: the category's id and name. */
  planKey: string | null;
  categoryId: string | null;
  label: string;
}

/**
 * What the auto-sort did since `since` that still stands (an automatic match
 * still stored; a promotion not undone), newest first, at most AUTO_DONE_MAX,
 * with the counts of everything since.
 */
export async function listAutoDone(
  householdId: string,
  sinceISO: string,
): Promise<{ since: string; matched: number; categorized: number; items: AutoDoneItem[]; truncated: boolean }> {
  const fr = forecastResolutionsTable;
  const cd = categoryDecisionsTable;
  // "Since" is a household day (America/Chicago), as every other day here.
  const onOrAfter = (col: typeof fr.createdAt | typeof cd.createdAt) =>
    sql`(${col} AT TIME ZONE 'America/Chicago')::date >= ${sinceISO}::date`;
  const matchWhere = and(eq(fr.householdId, householdId), eq(fr.source, AUTO_SORT_SOURCE), onOrAfter(fr.createdAt));
  const promoteWhere = and(eq(cd.householdId, householdId), like(cd.inputHash, PROMOTE_HASH_LIKE), isNull(cd.undoneAt), onOrAfter(cd.createdAt));
  const [matches, promoted, [matchCount], [promoteCount]] = await Promise.all([
    db
      .select({ id: fr.id, txnId: fr.matchedTxnId, itemId: fr.recurringItemId, occurrenceDate: fr.occurrenceDate, createdAt: fr.createdAt })
      .from(fr)
      .where(matchWhere)
      .orderBy(desc(fr.createdAt), desc(fr.id))
      .limit(AUTO_DONE_MAX),
    db
      .select({ id: cd.id, txnId: cd.transactionId, categoryId: cd.categoryId, createdAt: cd.createdAt, name: budgetCategoriesTable.name })
      .from(cd)
      .leftJoin(budgetCategoriesTable, eq(budgetCategoriesTable.id, cd.categoryId))
      .where(promoteWhere)
      .orderBy(desc(cd.createdAt), desc(cd.id))
      .limit(AUTO_DONE_MAX),
    db.select({ n: count() }).from(fr).where(matchWhere),
    db.select({ n: count() }).from(cd).where(promoteWhere),
  ]);
  const labels = await planLabelsOf(householdId, matches.map((m) => m.itemId).filter((x): x is string => !!x));
  const items: AutoDoneItem[] = [
    ...matches
      .filter((m) => m.txnId)
      .map((m) => ({
        kind: "match" as const,
        undoId: m.id,
        txnId: m.txnId!,
        at: m.createdAt.toISOString(),
        planKey: m.itemId && m.occurrenceDate ? `${m.itemId}|${m.occurrenceDate}` : null,
        categoryId: null,
        label: (m.itemId && labels.get(m.itemId)) || "A planned payment",
      })),
    ...promoted.map((p) => ({
      kind: "category" as const,
      undoId: p.id,
      txnId: p.txnId,
      at: p.createdAt.toISOString(),
      planKey: null,
      categoryId: p.categoryId,
      label: p.name ?? "A category",
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.undoId < b.undoId ? 1 : -1));
  const matched = Number(matchCount?.n ?? 0);
  const categorized = Number(promoteCount?.n ?? 0);
  const shown = items.slice(0, AUTO_DONE_MAX);
  return { since: sinceISO, matched, categorized, items: shown, truncated: matched + categorized > shown.length };
}

/** The labels of the plans these item ids name: a recurring item's name, a debt's minimum, the Avalanche extra. */
async function planLabelsOf(householdId: string, itemIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uuids = [...new Set(itemIds.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))];
  if (uuids.length > 0) {
    const rows = await db
      .select({ id: recurringItemsTable.id, name: recurringItemsTable.name })
      .from(recurringItemsTable)
      .where(and(eq(recurringItemsTable.householdId, householdId), inArray(recurringItemsTable.id, uuids)));
    for (const r of rows) out.set(r.id, r.name);
  }
  for (const id of itemIds) {
    if (id.startsWith("avalanche:")) out.set(id, "Avalanche extra payment");
    else if (id.startsWith("debt:")) out.set(id, "Debt minimum payment");
  }
  return out;
}

/** The default `since` of the auto-done list: a week back, household days. */
export const autoDoneSinceDefault = (today: string): string => addDaysISO(today, -AUTO_DONE_DEFAULT_DAYS);
