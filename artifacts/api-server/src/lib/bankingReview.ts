import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import {
  db,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  BANK_REVIEW_BUCKETS,
  BANK_REVIEW_KINDS,
  bankReviewKindOf,
  cashVarianceOf,
  classifyMovement,
  directionOfPlanKind,
  inForecast,
  pairDayDelta,
  pairDifference,
  placeBankReviewRow,
  rowAnswersResolve,
  summarizeBankReview,
  type BankReviewBucket,
  type BankReviewDirection,
  type BankReviewKind,
  type BankReviewPlanKind,
  type BankReviewPlanRef,
  type BankReviewRowPlacement,
  type BankReviewTotalsCents,
  type BankReviewVarianceKind,
  type BankReviewVarianceTotals,
  type RowEvidence,
} from "@workspace/avalanche-core";
import {
  LedgerRequestError,
  balanceAtEndOf,
  balanceUnavailableReason,
  bankRowWhere,
  hasNul,
  isCalendarDay,
  isUuid,
  loadAnnotatedRows,
  loadRegister,
  money,
  readLedgerTotals,
  resolveLedgerScope,
  toCents,
} from "./bankLedger";
import { computeCashSignalDetailed } from "./cashSignal";
import { computeBankFreshness } from "./bankFreshness";
import { buildMoneyPosition, POSITION_HORIZON_DAYS, tier2PairedTxnIdsOf } from "./moneyPosition";
import { computeReviewCount } from "./reviewCount";
import { loadMoneyContext } from "./moneyContext";
import { carriedPfcEvidence, effectiveFiling } from "./pendingFiling";
import { billSuggestionsOf, evidenceContextOf, rowEvidenceOf } from "./rowEvidence";
import { readPausedReview } from "./oneTimeBillMove";
import { readBankBalanceCheck } from "./bankBalanceCheck";
import { addDaysISO, householdTodayISO } from "./householdClock";
import type { LedgerPlanFate, LedgerPlanOccurrence } from "./forecastLedger";

/**
 * ⭐ (S4) THE BANKING REVIEW — `GET /banking/review`.
 *
 * The owner: "I want to review banking and immediately see what wasn't in the
 * plan." One bank account, one period. Nothing is computed here that another
 * function already computes; this module reads and hands over:
 *
 *   balance        the bank register (`loadRegister`, `balanceAtEndOf`) — the
 *                  Chase page's own balances, anchored on the spine's bank
 *                  balance, from THIS request's cash signal (one ledger).
 *   cashFlow       `readLedgerTotals` — the very SQL GET /transactions/ledger's
 *                  totals run, so the two agree to the cent.
 *   planned        the forecast ledger's `planOccurrences` — the fate the plans
 *                  loop decided for each occurrence, never re-decided.
 *   notInPlan      every row the register counts in the range, placed once by
 *                  avalanche-core's `placeBankReviewRow` from: the household's
 *                  answers on the row (or on the pending row it replaced, the
 *                  register's own pairing); the ledger's pairs (`matches`) and
 *                  the rows behind plans it took as paid; and the row's kind
 *                  (`classifyMovement`, the one spending rule).
 *   reconciliation (Σ buckets + as planned) − cashFlow.net — always "0.00".
 *   reviewInbox    the rows here no answer decides (`rowAnswersResolve`,
 *                  the badge's own rule) beside the badge (`computeReviewCount`)
 *                  and its real scope.
 *   balanceTie     the last manual Sync's check of the bank's own balance
 *                  (`forecast_settings.last_bank_reconciliation`), read only.
 *   balanceCheck   (F3) the same check in full (`readBankBalanceCheck`): matches /
 *                  off by / resolved since / not checked and why, stale and why,
 *                  the bank's figure (and field) beside H2's, the direction —
 *                  recomputed from the stored previous anchor in one query,
 *                  never a Plaid call. Kept apart from reviewInbox and freshness.
 *   household      secondary: the money position's week, all accounts.
 *
 * ⚠️ The plan comparison runs on the forecast's account only, over rows dated
 * from the ledger's matching window (today − 59) through today. Older rows,
 * rows after today and every row of another account are "not compared" —
 * uncertain, never "unplanned".
 */

export const BANKING_REVIEW_MAX_DAYS = 366;
export const BANKING_REVIEW_TIMEZONE = "America/Chicago";
export const BADGE_SCOPE = "this calendar month, forecast account";
export const HOUSEHOLD_SCOPE = "all accounts · this week";

const bad = (code: string, message: string) => new LedgerRequestError(400, code, message);

export type BankingReviewQuery = {
  account?: string;
  from: string;
  to: string;
  rowsPerBucket: number;
  bucket?: BankReviewBucket;
  kind?: BankReviewKind;
  cursor?: string;
  limit: number;
};

// ── Cursor: one bucket's rows, largest first ─────────────────────────────────

/** The last row of a page: its |amount| in cents, its day and its id. */
type ReviewCursor = { a: number; d: string; i: string };

function encodeReviewCursor(c: ReviewCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...c }), "utf8").toString("base64url");
}

function decodeReviewCursor(raw: string): ReviewCursor {
  const invalid = bad("invalid_cursor", "cursor is not a cursor from this endpoint");
  if (hasNul(raw)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object") throw invalid;
  const { v, a, d, i } = parsed as Record<string, unknown>;
  if (v !== 1 || typeof a !== "number" || !Number.isSafeInteger(a) || a < 0) throw invalid;
  if (typeof d !== "string" || !isCalendarDay(d) || typeof i !== "string" || !isUuid(i)) throw invalid;
  return { a, d, i };
}

/** Largest first, then newest, then id — a total order, so a cursor never skips or repeats a row. */
function compareRows(x: { abs: number; date: string; id: string }, y: { abs: number; date: string; id: string }): number {
  return y.abs - x.abs || (x.date < y.date ? 1 : x.date > y.date ? -1 : 0) || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0);
}

// ── Input checks ─────────────────────────────────────────────────────────────

const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

export function checkBankingReviewQuery(q: BankingReviewQuery, today: string): void {
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === "string" && hasNul(v)) throw bad("invalid_query", `${k} must not contain a NUL byte`);
  }
  if (!isCalendarDay(q.from) || !isCalendarDay(q.to)) {
    throw bad("invalid_range", "from and to must be YYYY-MM-DD dates from year 1000");
  }
  if (q.from > q.to) throw bad("invalid_range", "from must be on or before to");
  if (q.from > today) throw bad("future_period", "from must not be after today");
  if (dayNumber(q.to) - dayNumber(q.from) > BANKING_REVIEW_MAX_DAYS) {
    throw bad("range_too_long", `at most ${BANKING_REVIEW_MAX_DAYS} days from from to to`);
  }
  if (!Number.isInteger(q.rowsPerBucket) || q.rowsPerBucket < 1 || q.rowsPerBucket > 50) {
    throw bad("invalid_rows_per_bucket", "rowsPerBucket must be a whole number from 1 to 50");
  }
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) {
    throw bad("invalid_limit", "limit must be a whole number from 1 to 100");
  }
  if (q.kind !== undefined && q.bucket !== "unmatched") {
    throw bad("invalid_kind", "kind applies to bucket=unmatched only");
  }
  if (q.cursor !== undefined && q.bucket === undefined) {
    throw bad("invalid_cursor", "cursor pages one bucket: send bucket too");
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

type RowRead = {
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  categoryId: string | null;
  isTransfer: boolean;
  source: string;
  reimbursable: boolean;
  debtId: string | null;
  isExternalCardPayment: boolean;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  weeklyAllowance: boolean;
  monthlyAllowance: boolean;
  unplannedAllowance: boolean;
  weeklyBucket: string | null;
  isTransferUserOverridden: boolean;
  plaidAccountId: string | null;
  pending: boolean;
  forecastFlag: boolean;
};

async function readAccountIdentity(
  householdId: string,
  rowId: string | null,
): Promise<{ institution: string | null; name: string | null; mask: string | null; lastSyncedAt: string | null } | null> {
  if (!rowId) return null;
  const [row] = await db
    .select({
      name: plaidAccountsTable.name,
      mask: plaidAccountsTable.mask,
      institution: plaidItemsTable.institutionName,
      lastSyncedAt: plaidItemsTable.lastSyncedAt,
    })
    .from(plaidAccountsTable)
    .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
    .where(and(eq(plaidAccountsTable.householdId, householdId), eq(plaidAccountsTable.id, rowId)));
  if (!row) return null;
  return {
    institution: row.institution ?? null,
    name: row.name ?? null,
    mask: row.mask ?? null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  };
}

/** (F2) The household's recurring items linked to a debt: their plans are debt payments, not bills. */
async function readDebtLinkedItemIds(householdId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: recurringItemsTable.id })
    .from(recurringItemsTable)
    .where(and(eq(recurringItemsTable.householdId, householdId), sql`${recurringItemsTable.debtId} IS NOT NULL`));
  return new Set(rows.map((r) => r.id));
}

/**
 * (F2) What kind of plan an occurrence is: an everyday hook's payoff, a
 * paycheck, a debt's minimum / the Avalanche extra / a bill linked to a debt,
 * or a bill.
 */
export function planKindOf(
  o: Pick<LedgerPlanOccurrence, "itemId" | "eventKind" | "hookCadence">,
  debtLinkedItemIds: ReadonlySet<string>,
): BankReviewPlanKind {
  if (o.hookCadence) return "hook";
  if (o.eventKind === "income") return "income";
  if (o.itemId.startsWith("debt:") || o.itemId.startsWith("avalanche:") || debtLinkedItemIds.has(o.itemId)) return "debt";
  return "bill";
}

/** The household's answers that name these rows, a paused bill's pending review read as its last answer. */
async function readRowAnswers(
  householdId: string,
  txnIds: string[],
): Promise<Map<string, Array<{ status: string; recurringItemId: string | null; occurrenceDate: string | null }>>> {
  const out = new Map<string, Array<{ status: string; recurringItemId: string | null; occurrenceDate: string | null }>>();
  if (txnIds.length === 0) return out;
  const [stored, paused] = await Promise.all([
    db
      .select({
        matchedTxnId: forecastResolutionsTable.matchedTxnId,
        status: forecastResolutionsTable.status,
        recurringItemId: forecastResolutionsTable.recurringItemId,
        occurrenceDate: forecastResolutionsTable.occurrenceDate,
      })
      .from(forecastResolutionsTable)
      .where(
        and(
          eq(forecastResolutionsTable.householdId, householdId),
          inArray(forecastResolutionsTable.matchedTxnId, txnIds),
          // "Not this" rejects one pairing and never decides a row.
          ne(forecastResolutionsTable.status, "not_match"),
        ),
      ),
    db
      .select({ id: recurringItemsTable.id })
      .from(recurringItemsTable)
      .where(and(eq(recurringItemsTable.householdId, householdId), ne(recurringItemsTable.active, "true"))),
  ]);
  const pausedIds = new Set(paused.map((p) => p.id));
  for (const r of stored.map((x) => readPausedReview(x, pausedIds))) {
    if (!r.matchedTxnId) continue;
    const list = out.get(r.matchedTxnId) ?? [];
    list.push({ status: r.status, recurringItemId: r.recurringItemId, occurrenceDate: r.occurrenceDate });
    out.set(r.matchedTxnId, list);
  }
  return out;
}

// ── The response ─────────────────────────────────────────────────────────────

type Totals = { count: number; moneyIn: string; moneyOut: string; net: string; pendingNet: string };

/** (F2) A bucket's cash variance, money in and money out apart; null on a side nothing compares. */
const varianceOut = (v: BankReviewVarianceTotals): { varianceIn: string | null; varianceOut: string | null } => ({
  varianceIn: v.inCents == null ? null : money(v.inCents),
  varianceOut: v.outCents == null ? null : money(v.outCents),
});

/** (F2) A row filed against its direction, by the evidence rule. */
export type ClassificationIssue = "inflow_into_expense" | "outflow_into_income";
const classificationIssueOf = (ev: RowEvidence | null): ClassificationIssue | null =>
  ev?.reason === "credit_in_expense_category"
    ? "inflow_into_expense"
    : ev?.reason === "debit_in_income_category"
      ? "outflow_into_income"
      : null;

const totalsOut = (t: BankReviewTotalsCents): Totals => ({
  count: t.count,
  moneyIn: money(t.moneyInCents),
  moneyOut: money(t.moneyOutCents),
  net: money(t.netCents),
  pendingNet: money(t.pendingNetCents),
});

const moneyOrNull = (n: number | null | undefined): string | null => (n == null ? null : money(Math.round(n * 100)));

type ReviewRowOut = {
  id: string;
  date: string;
  displayName: string;
  description: string;
  amount: string;
  pending: boolean;
  manual: boolean;
  category: { id: string; name: string | null } | null;
  flags: {
    unplannedAllowance: boolean;
    weeklyAllowance: boolean;
    monthlyAllowance: boolean;
    reimbursable: boolean;
    transfer: boolean;
    cardPayment: boolean;
  };
  kind: BankReviewKind;
  /** (F2) in = money in (amount > 0), out = money out. */
  direction: BankReviewDirection;
  /** (F2) Filed against its direction (a credit under an expense category, or the reverse); null when not. */
  classificationIssue: ClassificationIssue | null;
  reason: BankReviewRowPlacement["reason"];
  evidence: "confirmed" | "automatic" | null;
  plan: {
    key: string;
    label: string;
    scheduledDate: string;
    planned: string | null;
    difference: string | null;
    dayDelta: number | null;
    eventKind: BankReviewPlanKind | null;
    direction: BankReviewDirection;
    expected: string | null;
    actual: string | null;
    variance: string | null;
    varianceKind: BankReviewVarianceKind | null;
  } | null;
};

type PlacedRow = {
  row: RowRead;
  amountCents: number;
  abs: number;
  kind: BankReviewKind;
  placement: BankReviewRowPlacement;
  /** (F2) The evidence rule's answer for the row as it counts. */
  rowEvidence: RowEvidence | null;
};

/** The fates a planned occurrence is listed with (a phantom or $0 occurrence is not a plan). */
const LISTED_FATES: ReadonlySet<LedgerPlanFate> = new Set<LedgerPlanFate>([
  "matched",
  "partial",
  "skipped",
  "missed",
  "paid_on_evidence",
  "suggested",
  "on_curve",
  "overdue_outside",
  "income_not_arrived",
  "outside_window",
]);

export async function buildBankingReview(householdId: string, ownerUserId: string, q: BankingReviewQuery) {
  checkBankingReviewQuery(q, householdTodayISO());
  const cursor = q.cursor !== undefined ? decodeReviewCursor(q.cursor) : null;

  // ONE LEDGER FOR THE REQUEST: the spine's own call (horizon 90, from today).
  // The register's anchor, the plan comparison and the household block all
  // read it. The handlers below are attached so a refused account never leaves
  // a rejection unhandled.
  const cashPromise = computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS });
  const signalPromise = cashPromise.then((c) => c.signal);
  const freshnessPromise = computeBankFreshness(householdId, ownerUserId);
  for (const p of [cashPromise, signalPromise, freshnessPromise]) p.catch(() => {});

  const scope = await resolveLedgerScope(householdId, ownerUserId, q.account, { signal: signalPromise });
  const range = { start: q.from, end: q.to };
  const debtLinkedRead = readDebtLinkedItemIds(householdId);
  debtLinkedRead.catch(() => {});

  const t = transactionsTable;
  const [cash, register, freshness, badgeCount, settingsRows, position, rows] = await Promise.all([
    cashPromise,
    loadRegister(scope),
    freshnessPromise,
    computeReviewCount(householdId, ownerUserId),
    db
      .select({ tie: forecastSettingsTable.lastBankReconciliation, anchorAt: forecastSettingsTable.bankSnapshotAt })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId)),
    buildMoneyPosition(householdId, ownerUserId, { cash: cashPromise, freshness: freshnessPromise }),
    db
      .select({
        id: t.id,
        occurredOn: t.occurredOn,
        description: t.description,
        amount: t.amount,
        categoryId: t.categoryId,
        isTransfer: t.isTransfer,
        source: t.source,
        reimbursable: t.reimbursable,
        debtId: t.debtId,
        isExternalCardPayment: t.isExternalCardPayment,
        pfcPrimary: t.pfcPrimary,
        pfcDetailed: t.pfcDetailed,
        weeklyAllowance: t.weeklyAllowance,
        monthlyAllowance: t.monthlyAllowance,
        unplannedAllowance: t.unplannedAllowance,
        weeklyBucket: t.weeklyBucket,
        isTransferUserOverridden: t.isTransferUserOverridden,
        plaidAccountId: t.plaidAccountId,
        pending: t.pending,
        forecastFlag: t.forecastFlag,
      })
      .from(t)
      .where(
        and(
          eq(t.householdId, householdId),
          bankRowWhere(scope.plaidAccountIds, scope.snapshotAccount),
          gte(t.occurredOn, q.from),
          lte(t.occurredOn, q.to),
        ),
      ),
  ]);
  const ledger = cash.ledger;
  const today = ledger.todayISO;
  const debtLinkedItemIds = await debtLinkedRead;
  const planRefOf = (o: LedgerPlanOccurrence): BankReviewPlanRef => ({
    key: o.planKey,
    label: o.label,
    scheduledDate: o.dueDate,
    planned: o.amount,
    eventKind: planKindOf(o, debtLinkedItemIds),
  });
  const [totals, money2] = await Promise.all([
    readLedgerTotals(scope, { from: q.from, to: q.to }, register),
    // Categories, the filing a posted row inherits, and the checking account —
    // what `classifyMovement` reads — for this range.
    loadMoneyContext(householdId, range, { tier2PairedTxnIds: tier2PairedTxnIdsOf(ledger) }),
  ]);

  // ── The rows the register counts in the range (a replaced pending row is out).
  const counted = rows.filter((r) => register.byId.get(r.id)?.countsInBalance ?? true);
  const replacedOf = (id: string): string | null => register.byId.get(id)?.replacedPendingId ?? null;
  const answerIds = new Set<string>();
  for (const r of counted) {
    answerIds.add(r.id);
    const p = replacedOf(r.id);
    if (p) answerIds.add(p);
  }
  const answers = await readRowAnswers(householdId, [...answerIds]);
  /** The row's own answers; with none, the answers on the pending row it replaced (they carry). */
  const answersOf = (id: string) => {
    const own = answers.get(id);
    if (own && own.length > 0) return own;
    const p = replacedOf(id);
    return (p ? answers.get(p) : undefined) ?? [];
  };

  // ── What the forecast ledger decided (forecast account only).
  const comparisonAvailable = scope.snapshotAccount;
  const occByKey = new Map(ledger.planOccurrences.map((o) => [o.planKey, o] as const));
  const answeredByTxn = new Map<string, LedgerPlanOccurrence>();
  const evidenceByTxn = new Map<string, LedgerPlanOccurrence>();
  for (const o of ledger.planOccurrences) {
    if (!o.txnId) continue;
    if (o.fate === "matched" || o.fate === "partial") answeredByTxn.set(o.txnId, o);
    if (o.fate === "paid_on_evidence") evidenceByTxn.set(o.txnId, o);
  }
  const evidencePairByTxn = new Map<string, BankReviewPlanRef>();
  const suggestionByTxn = new Map<string, BankReviewPlanRef>();
  for (const m of ledger.matches) {
    const o = occByKey.get(m.planKey);
    if (!o) continue;
    if (m.tier <= 2 && !m.ambiguous) evidencePairByTxn.set(m.txnId, planRefOf(o));
    else suggestionByTxn.set(m.txnId, planRefOf(o));
  }
  const rowsFrom = ledger.planComparison.rowsFromISO;
  const evidenceCtx = evidenceContextOf(money2, billSuggestionsOf(ledger, money2.supersede));

  // ── Place every counted row exactly once.
  const placed: PlacedRow[] = counted.map((r) => {
    const own = answersOf(r.id);
    const replaced = replacedOf(r.id);
    const answeredPlan = answeredByTxn.get(r.id) ?? (replaced ? answeredByTxn.get(replaced) : undefined);
    const resolutions = own.map((a) => {
      let plan: BankReviewPlanRef | null = null;
      if ((a.status === "matched" || a.status === "partial") && answeredPlan) plan = planRefOf(answeredPlan);
      else if (a.recurringItemId && a.occurrenceDate) {
        const o = occByKey.get(`${a.recurringItemId}|${a.occurrenceDate}`);
        if (o) plan = planRefOf(o);
      }
      return { status: a.status, plan };
    });
    const evidenceOcc = comparisonAvailable ? evidenceByTxn.get(r.id) : undefined;
    const evidence = comparisonAvailable ? (evidencePairByTxn.get(r.id) ?? (evidenceOcc ? planRefOf(evidenceOcc) : null)) : null;
    const suggestion = comparisonAvailable ? (suggestionByTxn.get(r.id) ?? null) : null;
    const compared = comparisonAvailable && r.occurredOn >= rowsFrom && r.occurredOn <= today;
    const amountCents = toCents(r.amount);
    const placement = placeBankReviewRow({
      occurredOn: r.occurredOn,
      amount: amountCents / 100,
      resolutions,
      evidence,
      suggestion,
      compared,
    });
    // The kind: the one spending rule, on the row as it counts (a posted row
    // takes the filing its replaced pending row carried).
    const replacedPending = money2.supersede.replacedBy.get(r.id);
    const asCounted = effectiveFiling(r, replacedPending, money2.filingCtx);
    const m = classifyMovement(asCounted, money2, { explain: true });
    const kind = bankReviewKindOf(m.coverage);
    // (F2) The evidence rule, on the same row and classification.
    const rowEvidence = rowEvidenceOf({ ...asCounted, carriedPfc: carriedPfcEvidence(r, replacedPending) }, m, evidenceCtx);
    return { row: r, amountCents, abs: Math.abs(amountCents), kind, placement, rowEvidence };
  });
  const summary = summarizeBankReview(
    placed.map((p) => ({ amountCents: p.amountCents, pending: p.row.pending, kind: p.kind, placement: p.placement })),
  );

  // ── Rows to show: each bucket's largest, and one page of the asked bucket.
  const byBucket = new Map<BankReviewBucket, PlacedRow[]>(BANK_REVIEW_BUCKETS.map((b) => [b, []]));
  for (const p of placed) if (p.placement.bucket !== "asPlanned") byBucket.get(p.placement.bucket)!.push(p);
  for (const list of byBucket.values()) list.sort((x, y) => compareRows({ ...x, date: x.row.occurredOn, id: x.row.id }, { ...y, date: y.row.occurredOn, id: y.row.id }));
  const shown = new Map<BankReviewBucket, PlacedRow[]>();
  for (const [b, list] of byBucket) shown.set(b, list.slice(0, q.rowsPerBucket));
  let pageRows: PlacedRow[] = [];
  let nextCursor: string | null = null;
  if (q.bucket) {
    let list = byBucket.get(q.bucket)!;
    if (q.kind) list = list.filter((p) => p.kind === q.kind);
    if (cursor) {
      const at = { abs: cursor.a, date: cursor.d, id: cursor.i };
      list = list.filter((p) => compareRows(at, { abs: p.abs, date: p.row.occurredOn, id: p.row.id }) < 0);
    }
    pageRows = list.slice(0, q.limit);
    const last = pageRows[pageRows.length - 1];
    if (list.length > q.limit && last) nextCursor = encodeReviewCursor({ a: last.abs, d: last.row.occurredOn, i: last.row.id });
  }
  const showIds = new Set<string>();
  for (const list of shown.values()) for (const p of list) showIds.add(p.row.id);
  for (const p of pageRows) showIds.add(p.row.id);
  const annotated = await loadAnnotatedRows(householdId, [...showIds]);
  const rowOut = (p: PlacedRow): ReviewRowOut => {
    const r = p.row;
    const plan = p.placement.plan;
    return {
      id: r.id,
      date: r.occurredOn,
      displayName: String(annotated.get(r.id)?.displayName ?? r.description),
      description: r.description,
      amount: money(p.amountCents),
      pending: r.pending,
      manual: !r.plaidAccountId,
      category: r.categoryId ? { id: r.categoryId, name: money2.categoriesById.get(r.categoryId)?.name ?? null } : null,
      flags: {
        unplannedAllowance: r.unplannedAllowance,
        weeklyAllowance: r.weeklyAllowance,
        monthlyAllowance: r.monthlyAllowance,
        reimbursable: r.reimbursable,
        transfer: r.isTransfer,
        cardPayment: r.isExternalCardPayment,
      },
      kind: p.kind,
      direction: p.amountCents > 0 ? "in" : "out",
      classificationIssue: classificationIssueOf(p.rowEvidence),
      reason: p.placement.reason,
      evidence: p.placement.evidence,
      plan: plan
        ? {
            key: plan.key,
            label: plan.label,
            scheduledDate: plan.scheduledDate,
            planned: moneyOrNull(plan.planned),
            difference: moneyOrNull(plan.difference),
            dayDelta: plan.dayDelta,
            eventKind: plan.eventKind ?? null,
            direction: plan.direction,
            expected: moneyOrNull(plan.expected),
            actual: moneyOrNull(plan.actual),
            variance: moneyOrNull(plan.variance),
            varianceKind: plan.varianceKind,
          }
        : null,
    };
  };
  const bucketOut = (b: BankReviewBucket) => ({
    ...totalsOut(summary.buckets[b]),
    rows: shown.get(b)!.map(rowOut),
    truncated: byBucket.get(b)!.length > shown.get(b)!.length,
    differenceTotal: b === "amountDifference" ? money(summary.differenceTotalCents) : null,
    ...varianceOut(summary.varianceByBucket[b]),
    byKind:
      b === "unmatched"
        ? (Object.fromEntries(BANK_REVIEW_KINDS.map((k) => [k, totalsOut(summary.unmatchedByKind[k])])) as Record<
            BankReviewKind,
            Totals
          >)
        : null,
    byReason:
      b === "uncertain"
        ? {
            needs_review: totalsOut(summary.uncertainByReason.needs_review),
            suggested_match: totalsOut(summary.uncertainByReason.suggested_match),
            not_compared: totalsOut(summary.uncertainByReason.not_compared),
          }
        : null,
  });

  // ── Planned: the occurrences due in the range, with the row behind each.
  const plannedOcc = comparisonAvailable
    ? ledger.planOccurrences
        .filter((o) => LISTED_FATES.has(o.fate) && o.dueDate >= q.from && o.dueDate <= q.to)
        .sort((a, b) =>
          a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : a.planKey < b.planKey ? -1 : a.planKey > b.planKey ? 1 : 0,
        )
    : [];
  const rowById = new Map(rows.map((r) => [r.id, r] as const));
  const missingTxnIds = [...new Set(plannedOcc.map((o) => o.txnId).filter((id): id is string => !!id && !rowById.has(id)))];
  const elsewhere = new Map<string, { occurredOn: string; onAccount: boolean }>();
  if (missingTxnIds.length > 0) {
    const found = await db
      .select({
        id: t.id,
        occurredOn: t.occurredOn,
        onAccount: sql<boolean>`(${bankRowWhere(scope.plaidAccountIds, scope.snapshotAccount)})`,
      })
      .from(t)
      .where(and(eq(t.householdId, householdId), inArray(t.id, missingTxnIds)));
    for (const f of found) elsewhere.set(f.id, { occurredOn: f.occurredOn, onAccount: f.onAccount === true });
  }
  const planned = plannedOcc.map((o) => {
    const inRange = o.txnId ? rowById.get(o.txnId) : undefined;
    const other = o.txnId ? elsewhere.get(o.txnId) : undefined;
    const txnDate = inRange?.occurredOn ?? other?.occurredOn ?? null;
    const eventKind = planKindOf(o, debtLinkedItemIds);
    const v = cashVarianceOf(o.amount, o.txnAmount, directionOfPlanKind(eventKind));
    return {
      key: o.planKey,
      itemId: o.itemId,
      label: o.label,
      scheduledDate: o.dueDate,
      occurrenceDate: o.occurrenceDate,
      planned: moneyOrNull(o.amount),
      fate: o.fate,
      txnId: o.txnId,
      txnDate,
      txnAmount: moneyOrNull(o.txnAmount),
      txnOnThisAccount: !!inRange || other?.onAccount === true,
      difference: o.amount != null && o.txnAmount != null ? moneyOrNull(pairDifference(o.amount, o.txnAmount)) : null,
      dayDelta: txnDate ? pairDayDelta(o.dueDate, txnDate) : null,
      remainder: moneyOrNull(o.remainder),
      onCurve: o.onCurve,
      hook: o.hookCadence,
      eventKind,
      direction: v.direction,
      expected: moneyOrNull(v.expected),
      actual: moneyOrNull(v.actual),
      variance: moneyOrNull(v.variance),
      varianceKind: v.varianceKind,
    };
  });

  // ── Account identity, balances, tie, inbox.
  const identityRowId = q.account ?? (scope.snapshotAccount ? cash.signal.account.rowId : null);
  const identity = await readAccountIdentity(householdId, identityRowId ?? null);
  const balanceStart = register.openingCents === null ? null : balanceAtEndOf(register, addDaysISO(q.from, -1));
  const tie = settingsRows[0]?.tie ?? null;
  // (S4) The short form, unchanged: a not-checked record (F3) reads as before — not checked.
  const tieApplies =
    !!tie && tie.status !== "not_checked" && scope.snapshotAccount && scope.plaidAccountIds.includes(tie.accountId);
  // (F3) The full check: one query at most (the recompute), no Plaid call.
  const balanceCheck = await readBankBalanceCheck({
    householdId,
    record: tie,
    isForecastAccount: scope.snapshotAccount,
    accountIds: scope.plaidAccountIds,
    currentAnchorAt: settingsRows[0]?.anchorAt ?? null,
  });
  // (S6) The badge's own rule, shared: a posted row carries its replaced pending row's answers.
  const statusesOf = (id: string | null): string[] => (id ? (answers.get(id) ?? []).map((a) => a.status) : []);
  const resolved = (id: string): boolean => rowAnswersResolve(statusesOf(id), statusesOf(replacedOf(id)));
  const unresolvedInRange = counted.filter((r) => inForecast(r, today) && !resolved(r.id)).length;
  const placedNet = summary.netCents;

  return {
    account: {
      id: identityRowId ?? null,
      institution: identity?.institution ?? null,
      name: identity?.name ?? (scope.snapshotAccount ? cash.signal.account.name : null),
      mask: identity?.mask ?? (scope.snapshotAccount ? cash.signal.account.mask : null),
      isForecastAccount: scope.snapshotAccount,
      lastSyncedAt: identity?.lastSyncedAt ?? null,
    },
    period: { from: q.from, to: q.to, today, timezone: BANKING_REVIEW_TIMEZONE },
    balance: {
      today: scope.anchor.todayBalance,
      asOf: scope.anchor.snapshotAt,
      start: balanceStart,
      end: balanceAtEndOf(register, q.to),
      unavailableReason: balanceUnavailableReason(scope),
    },
    freshness: scope.snapshotAccount ? freshness : null,
    cashFlow: {
      moneyIn: totals.moneyIn,
      moneyOut: totals.moneyOut,
      net: totals.net,
      count: totals.count,
      pendingNet: totals.pendingNet,
      supersededExcluded: totals.notCounted.superseded,
      otherExcluded: totals.notCounted.other,
    },
    planComparison: {
      available: comparisonAvailable,
      reason: comparisonAvailable ? null : ("not_forecast_account" as const),
      comparedFrom: comparisonAvailable ? rowsFrom : null,
      plansFrom: comparisonAvailable ? ledger.planComparison.plansFromISO : null,
      through: comparisonAvailable ? today : null,
    },
    planned,
    notInPlan: {
      amountDifference: bucketOut("amountDifference"),
      timingDifference: bucketOut("timingDifference"),
      confirmedUnplanned: bucketOut("confirmedUnplanned"),
      uncertain: bucketOut("uncertain"),
      unmatched: bucketOut("unmatched"),
    },
    asPlanned: {
      count: summary.asPlanned.count,
      net: money(summary.asPlanned.netCents),
      pendingNet: money(summary.asPlanned.pendingNetCents),
      ...varianceOut(summary.varianceByBucket.asPlanned),
      withoutPlanDetail: placed.filter((p) => p.placement.bucket === "asPlanned" && !p.placement.plan).length,
    },
    reconciliation: {
      rowsPlaced: placed.length,
      rowsUnexplained: totals.count - placed.length - totals.notCounted.superseded - totals.notCounted.other,
      unexplained: money(placedNet - toCents(totals.net)),
    },
    reviewInbox: { unresolvedInRange, badgeCount, badgeScope: BADGE_SCOPE },
    balanceTie: tieApplies
      ? { status: tie!.status, checkedAt: tie!.checkedAt, unexplained: tie!.unexplained }
      : { status: "not_checked" as const, checkedAt: null, unexplained: null },
    balanceCheck: {
      status: balanceCheck.status,
      reason: balanceCheck.reason,
      stale: balanceCheck.stale,
      staleReason: balanceCheck.staleReason,
      checkedAt: balanceCheck.checkedAt,
      bank: balanceCheck.bank
        ? { balance: money(balanceCheck.bank.balanceCents), at: balanceCheck.bank.at, field: balanceCheck.bank.field }
        : null,
      h2: balanceCheck.h2 ? { balance: money(balanceCheck.h2.balanceCents) } : null,
      difference: balanceCheck.differenceCents == null ? null : money(balanceCheck.differenceCents),
      direction: balanceCheck.direction,
      lastDrift: balanceCheck.lastDrift
        ? {
            checkedAt: balanceCheck.lastDrift.checkedAt,
            difference: money(balanceCheck.lastDrift.differenceCents),
            direction: balanceCheck.lastDrift.direction,
          }
        : null,
    },
    household: {
      scope: HOUSEHOLD_SCOPE,
      weekStart: position.weekStart,
      weekEnd: position.weekEnd,
      spentWeek: position.spentWeekDiscretionary,
      weekPlan: position.weekCap,
      remainingWeek: position.remainingWeek,
    },
    page: q.bucket
      ? { bucket: q.bucket, kind: q.kind ?? null, rows: pageRows.map(rowOut), nextCursor, limit: q.limit }
      : null,
  };
}

export type BankingReview = Awaited<ReturnType<typeof buildBankingReview>>;
