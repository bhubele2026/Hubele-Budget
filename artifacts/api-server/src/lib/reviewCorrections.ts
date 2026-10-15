// ⭐ (Q2) A PROPOSED FIX: PREVIEW, APPLY, UNDO.
//
// `GET /review/proposals` (reviewProposals.ts) proposes; the owner decides.
// This module makes one proposal a change — or shows what it would change:
//
//   POST /review/proposals/:key/apply?dryRun=1
//       Nothing is written. The proposal is recomputed and must match what the
//       owner saw (`proposalHash`, the listed row ids). The answer is each row
//       before → after, the answers the fix would replace, and the figures
//       before → after: this week's and this month's breakdown (known,
//       unresolved, actual), the Budget month(s) the rows fall in, and the
//       Banking review's buckets. The "after" is read by the very loaders the
//       screens read, through an overlay built from the SAME plan the apply
//       writes (`correctionOverlay.ts`) — (Q1) the forecast ledger included:
//       it is rebuilt with the overlay (`computeCashSignalWithOverlay`), so the
//       preview's pairing and Banking buckets are the applied result's.
//   POST /review/proposals/:key/apply
//       ONE transaction, by kind:
//         income_category · transfer   the category, through the user-decision
//                                      path (`handPickPatch`, a `user` decision
//                                      per row with its flags before/after);
//         loan_payment                 the category (when the proposal names
//                                      one) + "mark matched" for each row's
//                                      occurrence (`writeForecastResolution`);
//         bill_match                   "mark matched".
//       Merchant memory learns ONCE per fix, from its first listed row, sign
//       aware (`learnFromChoice`: money in learns `in:<signature>`, so a
//       payroll credit and same-name cafeteria charges never share a rule).
//       One record (`correction_applications`) keeps everything an undo needs.
//   POST /review/proposals/applied/:id/undo
//       Puts back every row's columns, deletes the resolutions it created,
//       restores the neighbours it deleted (same ids), reopens the queue
//       decisions it answered, marks its decisions undone and restores the
//       merchant memory — or refuses, nothing written, when a row or an answer
//       changed since, and says which.
//
// The direction guard (`directionConflictsOf`) stands in front of every
// category this writes.
//
// LIMITATIONS (stated in each dry run's `limitations`):
//   - listed_rows_only: a truncated proposal applies to the rows it lists;
//     the rest come back as the same proposal with a new hash.
//   (Q1) `forecast_pairs_as_before` and `banking_after_not_previewed` are gone:
//   the ledger (`buildForecastLedger`'s `correctionOverlay`) and the Banking
//   review (`buildBankingReview`'s `overlay`) take the overlay now. The spec
//   keeps both values in its enum; neither is sent.
//
// ⚠️ THE PATTERN-UNDO EXCEPTION (Q2, kept). The direction guard
// (`directionConflictsOf`, categorizer/review.ts) stands in front of every
// category write — PATCH, bulk-update, recategorize-by-pattern, the agent,
// Ask, and this apply — EXCEPT a pattern Undo: `POST
// /transactions/recategorize-by-pattern` with `lockedIds` restores the rows'
// OWN earlier filing (what they carried before the pattern moved them). That
// filing was the household's (or the engine's) before the change being undone;
// refusing it would leave the rows stranded in the category the undo exists to
// leave. It is not direction-checked, by design. Any other write that files
// money against its direction answers 409 `direction_conflict`.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  categoryDecisionsTable,
  correctionApplicationsTable,
  forecastResolutionsTable,
  merchantMemoryTable,
  transactionsTable,
  type DecisionRowFlags,
} from "@workspace/db";
import { monthBounds, weekBounds, type DirectionConflict } from "@workspace/avalanche-core";
import { buildReviewProposals, type ProposalRowOut, type ReviewProposal } from "./reviewProposals";
import { directionConflictsOf, directionRefusalOf } from "./categorizer/review";
import {
  DECISION_FLAG_COLUMNS,
  decisionFlagsOf,
  flagsAfterHandPick,
  handPickPatch,
  recordUserDecisions,
} from "./categorizer/userDecisions";
import { learnFromChoice } from "./categorizer/memory";
import type { Exec } from "./categorizer/db";
import { isExcludedCategory, isTransferCategory } from "./excludedCategory";
import { memoryKeyOf } from "./merchantNameExtract";
import {
  resolutionNeighbours,
  restoreForecastResolutions,
  writeForecastResolution,
  type ForecastResolutionInput,
  type ForecastResolutionRow,
} from "./forecastResolutionWrite";
import type { CorrectionOverlay, CorrectionRowPatch } from "./correctionOverlay";
import { computeCashSignalDetailed, computeCashSignalWithOverlay, type DetailedCashSignal } from "./cashSignal";
import { POSITION_HORIZON_DAYS } from "./moneyPosition";
import { buildPeriodBreakdown } from "./periodBreakdown";
import { buildBankingReview } from "./bankingReview";
import { BANK_REVIEW_BUCKETS } from "@workspace/avalanche-core";
import { buildBudgetMonthView } from "../routes/budget";
import { addDaysISO, householdTodayISO } from "./householdClock";
import { LedgerRequestError, isUuid, resolveLedgerAccounts } from "./bankLedger";

// ── Refusals ────────────────────────────────────────────────────────────────

export type CorrectionRefusalCode =
  | "proposal_gone"
  | "proposal_changed"
  | "no_target_category"
  | "direction_conflict"
  | "already_applied"
  | "not_found"
  | "already_undone"
  | "changed_since";

/** A refused request: the route answers `status` with `body()`. Nothing was written. */
export class CorrectionRefusal extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: CorrectionRefusalCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
  body(): Record<string, unknown> {
    return { error: this.message, code: this.code, ...this.detail };
  }
}

const WORDS: Record<CorrectionRefusalCode, string> = {
  proposal_gone: "This fix is no longer proposed. Nothing was changed.",
  proposal_changed: "This fix changed since it was shown. Nothing was changed; look at it again.",
  no_target_category: "There is no category to file these under. Nothing was changed.",
  direction_conflict: "",
  already_applied: "This fix was already applied.",
  not_found: "Not found.",
  already_undone: "This fix was already undone.",
  changed_since: "Some of these changed since the fix. Nothing was undone.",
};

const refuse = (status: 404 | 409, code: CorrectionRefusalCode, detail: Record<string, unknown> = {}) =>
  new CorrectionRefusal(status, code, WORDS[code], detail);

// ── Row state ───────────────────────────────────────────────────────────────

/** The columns a fix writes on a row (a hand pick's write), as the record keeps them. */
export interface CorrectionRowState extends DecisionRowFlags {
  categoryId: string | null;
  categoryLockedByUser: boolean;
  categoryProvisional: boolean;
}

const ROW_COLUMNS = {
  id: transactionsTable.id,
  occurredOn: transactionsTable.occurredOn,
  description: transactionsTable.description,
  amount: transactionsTable.amount,
  source: transactionsTable.source,
  plaidAccountId: transactionsTable.plaidAccountId,
  categoryId: transactionsTable.categoryId,
  categoryLockedByUser: transactionsTable.categoryLockedByUser,
  categoryProvisional: transactionsTable.categoryProvisional,
  ...DECISION_FLAG_COLUMNS,
};

type StoredRow = {
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  source: string;
  plaidAccountId: string | null;
} & CorrectionRowState;

const stateOf = (r: CorrectionRowState): CorrectionRowState => ({
  categoryId: r.categoryId ?? null,
  categoryLockedByUser: r.categoryLockedByUser === true,
  categoryProvisional: r.categoryProvisional === true,
  ...decisionFlagsOf(r),
});

const sameState = (a: CorrectionRowState, b: CorrectionRowState): boolean =>
  JSON.stringify(stateOf(a)) === JSON.stringify(stateOf(b));

/** The state a hand pick leaves: `handPickPatch` over the stored state — the write's own columns. */
function stateAfterPick(before: CorrectionRowState, categoryId: string, pickingTransfer: boolean): CorrectionRowState {
  return stateOf({ ...before, ...handPickPatch(categoryId, pickingTransfer) });
}

async function readRows(exec: Exec, householdId: string, ids: readonly string[], forUpdate: boolean): Promise<Map<string, StoredRow>> {
  if (ids.length === 0) return new Map();
  const q = exec
    .select(ROW_COLUMNS)
    .from(transactionsTable)
    .where(and(eq(transactionsTable.householdId, householdId), inArray(transactionsTable.id, [...ids])));
  const rows = forUpdate ? await q.for("update") : await q;
  return new Map(rows.map((r) => [r.id, r as StoredRow] as const));
}

// ── The plan ────────────────────────────────────────────────────────────────

export interface ApplyProposalBody {
  rowIds: string[];
  proposalHash: string;
}

interface PlannedResolution {
  recurringItemId: string;
  occurrenceDate: string;
  planKey: string;
}

interface PlannedRow {
  out: ProposalRowOut;
  /** The category the fix files the row under; null when it files nothing. */
  fileUnder: string | null;
  resolution: PlannedResolution | null;
  /** Why a row the fix marks matched gets no answer of its own. */
  resolutionSkipped: "no_occurrence" | "occurrence_shared" | null;
}

interface CorrectionPlan {
  proposal: ReviewProposal;
  targetCategoryId: string | null;
  pickingTransfer: boolean;
  rows: PlannedRow[];
  /** Each row as stored when the plan was made — the "before" the apply re-checks under lock. */
  stored: Map<string, StoredRow>;
  /** The answers the fix's resolutions would replace (read, not written). */
  neighbours: ForecastResolutionRow[];
  /** The listed row merchant memory learns from (the first one filed), or null. */
  teachRowId: string | null;
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * ⭐ THE PLAN — what the fix would do, from the proposal as it stands NOW. The
 * apply writes exactly this; the dry run reads exactly this. Refuses (409) a
 * proposal that is gone, changed, has no category to file under, or would file
 * money against its direction.
 */
async function planCorrection(
  householdId: string,
  ownerUserId: string,
  key: string,
  body: ApplyProposalBody,
): Promise<CorrectionPlan> {
  const view = await buildReviewProposals(householdId, ownerUserId);
  const proposal = view.items.find((p) => p.key === key);
  if (!proposal) throw refuse(409, "proposal_gone");
  const listed = proposal.rows.map((r) => r.id);
  const asked = [...new Set(body.rowIds)];
  if (
    proposal.proposalHash !== body.proposalHash ||
    asked.length !== body.rowIds.length ||
    asked.length !== listed.length ||
    !asked.every((id) => listed.includes(id))
  ) {
    throw refuse(409, "proposal_changed", { proposalHash: proposal.proposalHash });
  }

  const wantsCategory = proposal.applyWith.includes("categories_change");
  const targetCategoryId = wantsCategory ? proposal.action.target.categoryId : null;
  if (wantsCategory && !targetCategoryId) throw refuse(409, "no_target_category");
  const pickingTransfer = targetCategoryId ? await isTransferCategory(householdId, targetCategoryId) : false;

  const stored = await readRows(db, householdId, listed, false);
  if (stored.size !== listed.length) throw refuse(409, "proposal_changed", { proposalHash: proposal.proposalHash });

  if (targetCategoryId) {
    // The row as the write leaves it: a hand pick sets the transfer flag (true for Transfer, else false).
    const conflicts = await directionConflictsOf(householdId, listed, targetCategoryId, { patch: { isTransfer: pickingTransfer } });
    if (conflicts.size > 0) {
      const r = directionRefusalOf(conflicts);
      throw new CorrectionRefusal(409, "direction_conflict", r.error, { conflict: r.conflict, conflicts: r.conflicts });
    }
  }

  // "Mark matched": each row answers its occurrence; an occurrence two rows
  // would answer goes to the row dated nearest it (then the lower id) — a second
  // answer on one occurrence would delete the first.
  const marks = proposal.applyWith.includes("review_mark_matched");
  const winner = new Map<string, ProposalRowOut>();
  if (marks) {
    for (const r of proposal.rows) {
      if (!r.occurrence) continue;
      const cur = winner.get(r.occurrence.planKey);
      const gap = (x: ProposalRowOut) => Math.abs(day(x.date) - day(x.occurrence!.occurrenceDate));
      if (!cur || gap(r) < gap(cur) || (gap(r) === gap(cur) && r.id < cur.id)) winner.set(r.occurrence.planKey, r);
    }
  }
  const rows: PlannedRow[] = proposal.rows.map((r) => {
    let resolution: PlannedResolution | null = null;
    let resolutionSkipped: PlannedRow["resolutionSkipped"] = null;
    if (marks) {
      if (!r.occurrence) resolutionSkipped = "no_occurrence";
      else if (winner.get(r.occurrence.planKey)?.id !== r.id) resolutionSkipped = "occurrence_shared";
      else resolution = { recurringItemId: r.occurrence.recurringItemId, occurrenceDate: r.occurrence.occurrenceDate, planKey: r.occurrence.planKey };
    }
    return { out: r, fileUnder: targetCategoryId, resolution, resolutionSkipped };
  });

  const seen = new Map<string, ForecastResolutionRow>();
  for (const r of rows) {
    if (!r.resolution) continue;
    for (const n of await resolutionNeighbours(resolutionInput(ownerUserId, householdId, r))) seen.set(n.id, n);
  }
  const teach = rows.find((r) => r.fileUnder);
  return {
    proposal,
    targetCategoryId,
    pickingTransfer,
    rows,
    stored,
    neighbours: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)),
    teachRowId: teach ? teach.out.id : null,
  };
}

function resolutionInput(userId: string, householdId: string, r: PlannedRow): ForecastResolutionInput {
  return {
    userId,
    householdId,
    recurringItemId: r.resolution!.recurringItemId,
    occurrenceDate: r.resolution!.occurrenceDate,
    status: "matched",
    matchedTxnId: r.out.id,
  };
}

/**
 * (Q1) The overlay a dry run of this proposal reads — the same plan the apply
 * writes. For tests that build the overlay ledger beside the applied one.
 */
export async function overlayForProposal(
  householdId: string,
  ownerUserId: string,
  key: string,
  body: ApplyProposalBody,
): Promise<CorrectionOverlay> {
  return overlayOfPlan(await planCorrection(householdId, ownerUserId, key, body));
}

/** ⭐ The plan as an overlay: the dry run's "after" reads the very columns and answers the apply writes. */
export function overlayOfPlan(plan: CorrectionPlan): CorrectionOverlay {
  const rows = new Map<string, CorrectionRowPatch>();
  const addMatched: Array<CorrectionOverlay["addMatched"][number]> = [];
  const resolvedPlanKeys = new Set<string>();
  for (const r of plan.rows) {
    if (r.fileUnder) rows.set(r.out.id, handPickPatch(r.fileUnder, plan.pickingTransfer));
    if (r.resolution) {
      addMatched.push({
        txnId: r.out.id,
        occurredOn: plan.stored.get(r.out.id)!.occurredOn,
        recurringItemId: r.resolution.recurringItemId,
        occurrenceDate: r.resolution.occurrenceDate,
      });
      resolvedPlanKeys.add(r.resolution.planKey);
    }
  }
  return { rows, addMatched, removedResolutionIds: new Set(plan.neighbours.map((n) => n.id)), resolvedPlanKeys };
}

// ── The figures ─────────────────────────────────────────────────────────────

export interface CorrectionFigureScope {
  weekStart: string;
  monthStart: string;
  /** The Budget months the rows fall in (first-of-month ISO). */
  budgetMonths: string[];
  /** The categories whose Budget lines the fix moves. */
  categoryIds: string[];
  /**
   * One Banking review per checking or savings account the rows are on
   * (`bankingScopesOf`). (Final #7) A card row has no Banking review.
   */
  banking: Array<{ accountRowId: string; from: string; to: string }>;
}

async function periodFigures(
  householdId: string,
  ownerUserId: string,
  period: "week" | "month",
  start: string,
  overlay: CorrectionOverlay | null,
  cash: DetailedCashSignal | undefined,
) {
  const b = await buildPeriodBreakdown(
    householdId,
    ownerUserId,
    { period, start, rowsPerGroup: 1 },
    { ...(cash ? { cash } : {}), overlay },
  );
  return {
    start: b.start,
    end: b.end,
    plan: b.plan.amount,
    actual: b.actual,
    known: b.known,
    unresolved: b.unresolved.amount,
    remaining: b.remaining,
    over: b.over,
  };
}

async function budgetFigures(
  householdId: string,
  ownerUserId: string,
  userId: string,
  monthStart: string,
  categoryIds: ReadonlySet<string>,
  overlay: CorrectionOverlay | null,
) {
  const v = await buildBudgetMonthView({ householdId, householdOwnerId: ownerUserId, userId }, monthStart, { overlay });
  return {
    income: v.summary.income.actual,
    expenses: v.summary.expenses.actual,
    net: v.summary.net.actual,
    lines: v.lines
      .filter((l) => categoryIds.has(l.categoryId))
      .map((l) => ({ categoryId: l.categoryId, name: l.categoryName, kind: l.kind, actual: l.actualAmount })),
  };
}

async function bankingFigures(
  householdId: string,
  ownerUserId: string,
  s: CorrectionFigureScope["banking"][number],
  overlay: CorrectionOverlay | null,
  cash: DetailedCashSignal | undefined,
) {
  const r = await buildBankingReview(
    householdId,
    ownerUserId,
    { account: s.accountRowId, from: s.from, to: s.to, rowsPerBucket: 1, limit: 1 },
    // (Q1) The dry run's "after": the review as the fix leaves it, on the overlay ledger.
    { ...(overlay ? { overlay } : {}), ...(cash ? { cash } : {}) },
  );
  const bucket = (b: { count: number; moneyIn: string; moneyOut: string; net: string }) => ({
    count: b.count,
    moneyIn: b.moneyIn,
    moneyOut: b.moneyOut,
    net: b.net,
  });
  return {
    account: { id: r.account.id, institution: r.account.institution, name: r.account.name, mask: r.account.mask },
    buckets: Object.fromEntries(BANK_REVIEW_BUCKETS.map((b) => [b, bucket(r.notInPlan[b])])) as Record<
      (typeof BANK_REVIEW_BUCKETS)[number],
      ReturnType<typeof bucket>
    >,
    asPlanned: { count: r.asPlanned.count, net: r.asPlanned.net },
    unresolvedInRange: r.reviewInbox.unresolvedInRange,
  };
}

/**
 * ⭐ THE FIGURES A FIX MOVES — this week's and this month's breakdown, the
 * Budget months, and the Banking review — read by the endpoints' own builders.
 * `overlay` null reads the household as it stands (the "before", and the
 * applied result); an overlay reads it as the fix would leave it, with `cash`
 * the ledger built with that same overlay (`computeCashSignalWithOverlay`).
 */
export async function correctionFigures(
  householdId: string,
  ownerUserId: string,
  userId: string,
  scope: CorrectionFigureScope,
  overlay: CorrectionOverlay | null,
  opts: { cash?: DetailedCashSignal; banking?: boolean } = {},
) {
  const cats = new Set(scope.categoryIds);
  const [week, month, budgetMonths, banking] = await Promise.all([
    periodFigures(householdId, ownerUserId, "week", scope.weekStart, overlay, opts.cash),
    periodFigures(householdId, ownerUserId, "month", scope.monthStart, overlay, opts.cash),
    Promise.all(scope.budgetMonths.map(async (m) => ({ monthStart: m, ...(await budgetFigures(householdId, ownerUserId, userId, m, cats, overlay)) }))),
    opts.banking === false
      ? Promise.resolve([])
      : Promise.all(scope.banking.map(async (s) => ({ from: s.from, to: s.to, ...(await bankingFigures(householdId, ownerUserId, s, overlay, opts.cash)) }))),
  ]);
  return { week, month, budgetMonths, banking };
}

export type CorrectionFigures = Awaited<ReturnType<typeof correctionFigures>>;

/** The scope a plan's figures cover: the current week and month, the rows' months and accounts. */
function scopeOfPlan(plan: CorrectionPlan, today: string): CorrectionFigureScope {
  const months = new Set<string>();
  const byAccount = new Map<string, { from: string; to: string }>();
  for (const r of plan.rows) {
    months.add(monthBounds(r.out.date).start);
    const id = r.out.account.id;
    if (!id) continue;
    const to = r.out.date > today ? today : r.out.date;
    const cur = byAccount.get(id);
    byAccount.set(id, cur ? { from: r.out.date < cur.from ? r.out.date : cur.from, to: to > cur.to ? to : cur.to } : { from: to, to });
  }
  const categoryIds = new Set<string>();
  if (plan.targetCategoryId) categoryIds.add(plan.targetCategoryId);
  for (const r of plan.rows) {
    if (r.out.category) categoryIds.add(r.out.category.id);
    const s = plan.stored.get(r.out.id)?.categoryId;
    if (s) categoryIds.add(s);
  }
  return {
    weekStart: weekBounds(today).start,
    monthStart: monthBounds(today).start,
    budgetMonths: [...months].sort(),
    categoryIds: [...categoryIds].sort(),
    banking: [...byAccount]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([accountRowId, r]) => ({ accountRowId, from: r.from < addDaysISO(today, -365) ? addDaysISO(today, -365) : r.from, to: r.to })),
  };
}

/**
 * ⭐ (Final #7) THE ACCOUNTS A BANKING REVIEW READS — the plan's accounts the
 * Banking review itself accepts (`resolveLedgerAccounts`: checking, savings,
 * the forecast's account and its twins). A card row (an Amex pay-later
 * instalment the loan_payment proposal lists) has no Banking review: asking
 * for one threw `account_not_ledger`, the dry run answered 400 and the fix
 * could never be applied from the screen. Its own before → after is in
 * `rows`, and the week, month and Budget figures carry it; it gets no Banking
 * figures. Any other refusal is a real error.
 */
async function bankingScopesOf(
  householdId: string,
  ownerUserId: string,
  scopes: CorrectionFigureScope["banking"],
): Promise<CorrectionFigureScope["banking"]> {
  const out: CorrectionFigureScope["banking"] = [];
  for (const s of scopes) {
    try {
      await resolveLedgerAccounts(householdId, ownerUserId, s.accountRowId);
      out.push(s);
    } catch (e) {
      if (e instanceof LedgerRequestError && e.code === "account_not_ledger") continue;
      throw e;
    }
  }
  return out;
}

// ── Views ───────────────────────────────────────────────────────────────────

const resolutionView = (r: ForecastResolutionRow) => ({
  id: r.id,
  status: r.status,
  recurringItemId: r.recurringItemId,
  occurrenceDate: r.occurrenceDate,
  matchedTxnId: r.matchedTxnId,
});

function rowsView(plan: CorrectionPlan) {
  return plan.rows.map((r) => {
    const before = stateOf(plan.stored.get(r.out.id)!);
    return {
      id: r.out.id,
      date: r.out.date,
      displayName: r.out.displayName,
      amount: r.out.amount,
      pending: r.out.pending,
      source: r.out.source,
      account: r.out.account,
      before,
      after: r.fileUnder ? stateAfterPick(before, r.fileUnder, plan.pickingTransfer) : before,
      resolution: r.resolution ? { recurringItemId: r.resolution.recurringItemId, occurrenceDate: r.resolution.occurrenceDate, status: "matched" as const } : null,
      resolutionSkipped: r.resolutionSkipped,
    };
  });
}

const proposalView = (p: ReviewProposal) => ({
  key: p.key,
  kind: p.kind,
  proposalHash: p.proposalHash,
  action: p.action.code,
  label: p.action.target.label,
});

// ── Dry run ─────────────────────────────────────────────────────────────────

/** ⭐ `POST /review/proposals/:key/apply?dryRun=1`. Writes nothing. */
export async function previewCorrection(
  householdId: string,
  ownerUserId: string,
  userId: string,
  key: string,
  body: ApplyProposalBody,
) {
  const plan = await planCorrection(householdId, ownerUserId, key, body);
  const today = householdTodayISO();
  const planScope = scopeOfPlan(plan, today);
  // (Final #7) Banking figures for checking and savings accounts only: a card row has none.
  const scope = { ...planScope, banking: await bankingScopesOf(householdId, ownerUserId, planScope.banking) };
  const overlay = overlayOfPlan(plan);
  // ⭐ (Q1) Two ledgers, built from the same reads at the same moment: the
  // household as it stands, and as the fix leaves it (the overlay ledger — its
  // answers and rows patched, never shared). Before and after differ by the fix
  // alone, and the "after" pairing is the one the applied fix will produce.
  const [cash, cashAfter] = await Promise.all([
    computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS }),
    computeCashSignalWithOverlay(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS }, overlay),
  ]);
  const [before, after, learns] = await Promise.all([
    correctionFigures(householdId, ownerUserId, userId, scope, null, { cash }),
    correctionFigures(householdId, ownerUserId, userId, scope, overlay, { cash: cashAfter }),
    learnsMemory(householdId, plan),
  ]);
  const limitations: string[] = [];
  if (plan.proposal.truncated) limitations.push("listed_rows_only");
  return {
    dryRun: true as const,
    proposal: proposalView(plan.proposal),
    rows: rowsView(plan),
    replaces: plan.neighbours.map(resolutionView),
    learnsMemory: learns,
    figures: {
      week: { before: before.week, after: after.week },
      month: { before: before.month, after: after.month },
      budgetMonths: before.budgetMonths.map((b, i) => {
        const { monthStart, ...was } = b;
        const { monthStart: _m, ...now } = after.budgetMonths[i]!;
        void _m;
        return { monthStart, before: was, after: now };
      }),
      // (Q1) The Banking review after the fix: the same account and days, on the overlay ledger.
      banking: before.banking.map(({ from, to, account, ...was }, i) => {
        const { from: _f, to: _t, account: _a, ...now } = after.banking[i]!;
        void _f;
        void _t;
        void _a;
        return { account, from, to, before: was, after: now };
      }),
    },
    limitations,
  };
}

async function learnsMemory(householdId: string, plan: CorrectionPlan): Promise<boolean> {
  if (!plan.teachRowId || !plan.targetCategoryId) return false;
  if (await isExcludedCategory(householdId, plan.targetCategoryId)) return false;
  return memoryKeyOf(plan.stored.get(plan.teachRowId)!) !== "";
}

// ── Apply ───────────────────────────────────────────────────────────────────

type MemorySnapshotRow = Record<string, unknown>;

interface CorrectionRecordRow {
  txnId: string;
  filed: boolean;
  before: CorrectionRowState;
  after: CorrectionRowState;
  decisionId: string | null;
  resolutionId: string | null;
}

interface CorrectionRecordMemory {
  signature: string;
  before: MemorySnapshotRow[];
  after: MemorySnapshotRow[];
  memoryId: string;
  created: boolean;
}

const jsonOf = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** JSON with every object's keys sorted: a jsonb round trip reorders keys, so records compare by this. */
function canon(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.keys(x as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((x as Record<string, unknown>)[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(norm(jsonOf(v)));
}

async function memoryRows(exec: Exec, householdId: string, signature: string): Promise<MemorySnapshotRow[]> {
  const rows = await exec
    .select()
    .from(merchantMemoryTable)
    .where(and(eq(merchantMemoryTable.householdId, householdId), eq(merchantMemoryTable.signature, signature)));
  return jsonOf(rows.sort((a, b) => a.id.localeCompare(b.id)));
}

/** ⭐ `POST /review/proposals/:key/apply`. One transaction; one record; refuses (nothing written) a changed proposal. */
export async function applyCorrection(
  householdId: string,
  ownerUserId: string,
  userId: string,
  key: string,
  body: ApplyProposalBody,
) {
  const plan = await planCorrection(householdId, ownerUserId, key, body);
  const ids = plan.rows.map((r) => r.out.id);
  const applied = await db.transaction(async (tx) => {
    // Two taps apply once: the same fix (key + hash) is applied by one transaction at a time.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`q2-correction:${householdId}:${key}`}::text))`);
    const [live] = await tx
      .select({ id: correctionApplicationsTable.id })
      .from(correctionApplicationsTable)
      .where(
        and(
          eq(correctionApplicationsTable.householdId, householdId),
          eq(correctionApplicationsTable.proposalKey, key),
          eq(correctionApplicationsTable.proposalHash, plan.proposal.proposalHash),
          isNull(correctionApplicationsTable.undoneAt),
        ),
      )
      .limit(1);
    if (live) throw refuse(409, "already_applied", { applicationId: live.id });
    // The rows under lock must be the rows the plan read.
    const now = await readRows(tx, householdId, ids, true);
    for (const id of ids) {
      const a = now.get(id);
      if (!a || !sameState(a, plan.stored.get(id)!)) throw refuse(409, "proposal_changed", { proposalHash: plan.proposal.proposalHash });
    }
    // The queue items the fix answers, reopened by its undo. ⭐ (Final #8) Only
    // the FILED rows' open items: `recordUserDecisions` closes those and no
    // other. A row the fix only marks matched keeps its question open; reading
    // it here let the undo wipe an answer the owner gave it after the fix.
    const filed = plan.rows.filter((r) => r.fileUnder);
    const filedIds = filed.map((r) => r.out.id);
    const reopened = filedIds.length
      ? (
          await tx
            .select({ id: categoryDecisionsTable.id })
            .from(categoryDecisionsTable)
            .where(
              and(
                eq(categoryDecisionsTable.householdId, householdId),
                inArray(categoryDecisionsTable.transactionId, filedIds),
                isNull(categoryDecisionsTable.resolvedAt),
                isNull(categoryDecisionsTable.undoneAt),
              ),
            )
        )
          .map((d) => d.id)
          .sort()
      : [];

    // Merchant memory: ONCE per fix, from its first filed row, sign-aware.
    let memory: CorrectionRecordMemory | null = null;
    if (plan.teachRowId && plan.targetCategoryId) {
      const teach = plan.stored.get(plan.teachRowId)!;
      const signature = memoryKeyOf(teach);
      const before = signature ? await memoryRows(tx, householdId, signature) : [];
      const learned = await learnFromChoice(tx, householdId, teach, plan.targetCategoryId);
      if (learned) {
        memory = { signature, before, after: await memoryRows(tx, householdId, signature), memoryId: learned.memoryId, created: learned.created };
      }
    }

    // The rows: the hand pick's own write, and one `user` decision each.
    const records: CorrectionRecordRow[] = [];
    for (const r of filed) {
      await tx
        .update(transactionsTable)
        .set(handPickPatch(r.fileUnder!, plan.pickingTransfer))
        .where(and(eq(transactionsTable.id, r.out.id), eq(transactionsTable.householdId, householdId)));
    }
    const decisionOf = new Map<string, string>();
    const change = (r: PlannedRow) => {
      const before = stateOf(plan.stored.get(r.out.id)!);
      return {
        transactionId: r.out.id,
        previousCategoryId: before.categoryId,
        categoryId: r.fileUnder,
        flagsBefore: decisionFlagsOf(before),
        flagsAfter: flagsAfterHandPick(decisionFlagsOf(before), plan.pickingTransfer),
      };
    };
    const explanation = `Filed by a fix you applied (${plan.proposal.action.target.label}).`;
    const teachFiled = filed.filter((r) => r.out.id === plan.teachRowId);
    const restFiled = filed.filter((r) => r.out.id !== plan.teachRowId);
    const teachIds = await recordUserDecisions(tx, householdId, userId, teachFiled.map(change), {
      explanation,
      createdMemoryId: memory?.created ? memory.memoryId : null,
    });
    const restIds = await recordUserDecisions(tx, householdId, userId, restFiled.map(change), { explanation });
    teachFiled.forEach((r, i) => decisionOf.set(r.out.id, teachIds[i]!));
    restFiled.forEach((r, i) => decisionOf.set(r.out.id, restIds[i]!));

    // "Mark matched": the resolution write, keeping what it replaced.
    const created: ForecastResolutionRow[] = [];
    const deleted: ForecastResolutionRow[] = [];
    const resolutionOf = new Map<string, string>();
    for (const r of plan.rows) {
      if (!r.resolution) continue;
      const w = await writeForecastResolution(tx, resolutionInput(userId, householdId, r));
      created.push(w.row);
      deleted.push(...w.deleted);
      resolutionOf.set(r.out.id, w.row.id);
    }

    for (const r of plan.rows) {
      const before = stateOf(plan.stored.get(r.out.id)!);
      records.push({
        txnId: r.out.id,
        filed: !!r.fileUnder,
        before,
        after: r.fileUnder ? stateAfterPick(before, r.fileUnder, plan.pickingTransfer) : before,
        decisionId: decisionOf.get(r.out.id) ?? null,
        resolutionId: resolutionOf.get(r.out.id) ?? null,
      });
    }

    const [app] = await tx
      .insert(correctionApplicationsTable)
      .values({
        householdId,
        proposalKey: key,
        proposalKind: plan.proposal.kind,
        proposalHash: plan.proposal.proposalHash,
        label: plan.proposal.action.target.label,
        actorUserId: userId,
        rows: records,
        resolutions: jsonOf({ created, deleted }),
        reopenedDecisionIds: reopened,
        memory,
      })
      .returning();
    return { app: app!, records, created, deleted };
  });
  return {
    dryRun: false as const,
    applicationId: applied.app.id,
    appliedAt: applied.app.createdAt.toISOString(),
    proposal: proposalView(plan.proposal),
    rows: rowsView(plan).map((r) => {
      const rec = applied.records.find((x) => x.txnId === r.id)!;
      return { ...r, decisionId: rec.decisionId };
    }),
    replaced: applied.deleted.map(resolutionView),
    learnedMemory: applied.app.memory != null,
  };
}

// ── Undo ────────────────────────────────────────────────────────────────────

const memoryFromJson = (r: MemorySnapshotRow): typeof merchantMemoryTable.$inferInsert => {
  const d = (v: unknown) => (v == null ? null : new Date(String(v)));
  return {
    id: r.id as string,
    householdId: r.householdId as string,
    signature: r.signature as string,
    scope: r.scope as string,
    plaidAccountId: (r.plaidAccountId as string | null) ?? null,
    amountBandLo: (r.amountBandLo as string | null) ?? null,
    amountBandHi: (r.amountBandHi as string | null) ?? null,
    categoryId: r.categoryId as string,
    count: r.count as number,
    lastConfirmedAt: d(r.lastConfirmedAt),
    learnedFromTxnId: (r.learnedFromTxnId as string | null) ?? null,
    source: r.source as string,
    disabledAt: d(r.disabledAt),
    createdAt: d(r.createdAt)!,
  };
};

const resolutionFromJson = (r: ForecastResolutionRow): ForecastResolutionRow => ({ ...r, createdAt: new Date(String(r.createdAt)) });

/**
 * ⭐ `POST /review/proposals/applied/:id/undo` — the whole fix, exactly, or
 * nothing: refuses (409 `changed_since`, naming the rows and answers) when a
 * row it filed no longer holds what it wrote, or an answer it wrote was
 * changed or replaced since.
 */
export async function undoCorrection(householdId: string, userId: string, applicationId: string) {
  if (!isUuid(applicationId)) throw refuse(404, "not_found");
  return db.transaction(async (tx) => {
    const [app] = await tx
      .select()
      .from(correctionApplicationsTable)
      .where(and(eq(correctionApplicationsTable.id, applicationId), eq(correctionApplicationsTable.householdId, householdId)))
      .for("update");
    if (!app) throw refuse(404, "not_found");
    if (app.undoneAt) throw refuse(409, "already_undone", { undoneAt: app.undoneAt.toISOString() });
    const records = app.rows as CorrectionRecordRow[];
    const resolutions = app.resolutions as { created: ForecastResolutionRow[]; deleted: ForecastResolutionRow[] };
    const memory = app.memory as CorrectionRecordMemory | null;

    // ── Has anything it wrote changed since?
    const now = await readRows(tx, householdId, records.map((r) => r.txnId), true);
    const changedRows = records.filter((r) => r.filed && (!now.has(r.txnId) || !sameState(now.get(r.txnId)!, r.after))).map((r) => r.txnId);
    const createdIds = resolutions.created.map((r) => r.id);
    const createdNow = createdIds.length
      ? await tx.select().from(forecastResolutionsTable).where(inArray(forecastResolutionsTable.id, createdIds)).for("update")
      : [];
    const changedAnswers: string[] = [];
    for (const c of resolutions.created) {
      const cur = createdNow.find((x) => x.id === c.id);
      if (!cur || canon(cur) !== canon(c)) {
        changedAnswers.push(c.id);
        continue;
      }
      // A new answer on its occurrence or its row since: restoring the old ones would make two.
      const others = (
        await resolutionNeighbours(
          { userId: c.userId, householdId, recurringItemId: c.recurringItemId, occurrenceDate: c.occurrenceDate, status: c.status, matchedTxnId: c.matchedTxnId },
          tx,
        )
      ).filter((x) => x.id !== c.id);
      if (others.length > 0) changedAnswers.push(c.id);
    }
    if (changedRows.length > 0 || changedAnswers.length > 0) {
      throw refuse(409, "changed_since", { rows: changedRows.sort(), answers: changedAnswers.sort() });
    }

    // ── Put everything back.
    for (const r of records) {
      if (!r.filed) continue;
      await tx
        .update(transactionsTable)
        .set(stateOf(r.before))
        .where(and(eq(transactionsTable.id, r.txnId), eq(transactionsTable.householdId, householdId)));
    }
    if (createdIds.length > 0) {
      await tx.delete(forecastResolutionsTable).where(and(eq(forecastResolutionsTable.householdId, householdId), inArray(forecastResolutionsTable.id, createdIds)));
    }
    await restoreForecastResolutions(tx, resolutions.deleted.map(resolutionFromJson));
    const undoneAt = new Date();
    const decisionIds = records.map((r) => r.decisionId).filter((d): d is string => !!d);
    if (decisionIds.length > 0) {
      await tx
        .update(categoryDecisionsTable)
        .set({ undoneAt })
        .where(and(eq(categoryDecisionsTable.householdId, householdId), inArray(categoryDecisionsTable.id, decisionIds), isNull(categoryDecisionsTable.undoneAt)));
    }
    const reopened = app.reopenedDecisionIds as string[];
    if (reopened.length > 0) {
      // (Final #8) Only an item still closed as the apply closed it (`recordUserDecisions`:
      // "corrected", by the user): an answer of another kind is the owner's, and stays.
      await tx
        .update(categoryDecisionsTable)
        .set({ resolvedAt: null, resolvedBy: null, resolution: null, resolvedVia: null })
        .where(
          and(
            eq(categoryDecisionsTable.householdId, householdId),
            inArray(categoryDecisionsTable.id, reopened),
            isNull(categoryDecisionsTable.undoneAt),
            eq(categoryDecisionsTable.resolvedBy, app.actorUserId),
            eq(categoryDecisionsTable.resolution, "corrected"),
            eq(categoryDecisionsTable.resolvedVia, "user"),
          ),
        );
    }
    let memoryOutcome: "none" | "restored" | "disabled" | "kept" = "none";
    if (memory) {
      const current = await memoryRows(tx, householdId, memory.signature);
      if (canon(current) === canon(memory.after)) {
        await tx
          .delete(merchantMemoryTable)
          .where(and(eq(merchantMemoryTable.householdId, householdId), eq(merchantMemoryTable.signature, memory.signature)));
        if (memory.before.length > 0) await tx.insert(merchantMemoryTable).values(memory.before.map(memoryFromJson));
        memoryOutcome = "restored";
      } else if (memory.created) {
        // Learned more since: the rule this fix taught is switched off, as a decision's undo does.
        await tx
          .update(merchantMemoryTable)
          .set({ disabledAt: undoneAt })
          .where(and(eq(merchantMemoryTable.id, memory.memoryId), eq(merchantMemoryTable.householdId, householdId)));
        memoryOutcome = "disabled";
      } else {
        memoryOutcome = "kept";
      }
    }
    await tx
      .update(correctionApplicationsTable)
      .set({ undoneAt, undoneBy: userId })
      .where(eq(correctionApplicationsTable.id, app.id));
    return {
      applicationId: app.id,
      undoneAt: undoneAt.toISOString(),
      rows: records.filter((r) => r.filed).length,
      answersRemoved: createdIds.length,
      answersRestored: resolutions.deleted.length,
      memory: memoryOutcome,
    };
  });
}

// ── History ─────────────────────────────────────────────────────────────────

export const APPLIED_HISTORY_MAX = 20;

/** `GET /review/proposals/applied` — the household's applied fixes, newest first. */
export async function listAppliedCorrections(householdId: string) {
  const rows = await db
    .select()
    .from(correctionApplicationsTable)
    .where(eq(correctionApplicationsTable.householdId, householdId))
    .orderBy(desc(correctionApplicationsTable.createdAt), desc(correctionApplicationsTable.id))
    .limit(APPLIED_HISTORY_MAX);
  return {
    items: rows.map((a) => {
      const recs = a.rows as CorrectionRecordRow[];
      const res = a.resolutions as { created: unknown[]; deleted: unknown[] };
      return {
        id: a.id,
        proposalKey: a.proposalKey,
        kind: a.proposalKind as ReviewProposal["kind"],
        label: a.label,
        rowCount: recs.length,
        filedCount: recs.filter((r) => r.filed).length,
        matchedCount: res.created.length,
        appliedAt: a.createdAt.toISOString(),
        undoneAt: a.undoneAt ? a.undoneAt.toISOString() : null,
        undoable: a.undoneAt == null,
      };
    }),
  };
}

export type { DirectionConflict };
