// ⭐ (F2) PROPOSED FIXES — `GET /review/proposals`. READ-ONLY: this module
// writes NOTHING. Every item is a proposal for the household owner to apply
// himself with an app action that already exists (Review "mark matched",
// Categories "change"). No silent recategorization of history.
//
// Over the last 120 household days, each proposal stands on evidence the rows
// carry — Plaid's category, the forecast's own suggestion, an existing bill,
// debt or income plan — never on a merchant name alone, and never as a blanket
// rule ("every row named X"):
//
//   loan_payment     Plaid LOAN_PAYMENTS (not a card) rows the household has
//                    not filed as a payment (`classifyEvidence` unresolved:
//                    unfiled, or filed under an income category). Rows on one
//                    account paying the same amount (within max($1, 1%)) are
//                    one series. A series is proposed as ONE bill's or debt's
//                    payment when exactly one active bill or debt fits:
//                      - a distinctive word of its name (or of its category's
//                        name) appears in one of the series' descriptions
//                        (`labelEvidence`, the matcher's own name rule), and
//                      - the amount fits: a bill within max($25, 25%) of its
//                        amount (`rowWithinMatchAmount`), a debt at least its
//                        minimum − max($1, 1%).
//                    Two fits, or none: nothing is proposed.
//   transfer         TRANSFER_OUT_SAVINGS / TRANSFER_OUT_ACCOUNT_TRANSFER rows
//                    counted as spending today and filed under an EXPENSE
//                    category, that no person-to-person rail names → "Transfer".
//   bill_match       an unfiled row the forecast only SUGGESTS for a bill (a
//                    tier-3, ambiguous or underpaying pair; the ledger's
//                    window) → confirm the match.
//   income_category  a credit filed under an EXPENSE category whose Plaid
//                    primary is INCOME, that pairs with exactly one active
//                    income plan (a distinctive word of its name, and within
//                    max($25, 25%) of its amount) → file under that plan's
//                    category.
//
// A row is in at most one proposal (loan_payment before bill_match).

import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  budgetCategoriesTable,
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  addDaysISO,
  classifyMovement,
  creditAmount,
  labelEvidence,
  namesPersonToPersonRail,
  pfcOf,
  rowWithinMatchAmount,
  spendAmount,
  withinStrictTolerance,
  type RowEvidence,
} from "@workspace/avalanche-core";
import { computeCashSignalDetailed, expandItem, parseISO } from "./cashSignal";
import { POSITION_HORIZON_DAYS, tier2PairedTxnIdsOf } from "./moneyPosition";
import { expandDebtMin } from "./debtMinSchedule";
import { loadMoneyContext, loadMovementRows, type MovementRowRead } from "./moneyContext";
import { billSuggestionsOf, evidenceContextOf, rowEvidenceOf } from "./rowEvidence";
import { displayNameOf, loadMerchantAliases } from "./periodBreakdown";
import { merchantSignature } from "./merchantNameExtract";
import { householdTodayISO } from "./householdClock";

/** The window, in household days, today included. */
export const PROPOSALS_WINDOW_DAYS = 120;
/** At most this many proposals, largest first. */
export const PROPOSALS_MAX_ITEMS = 50;
/** At most this many rows listed per proposal (its total and count cover every row). */
export const PROPOSAL_ROWS_MAX = 20;

export type ProposalKind = "loan_payment" | "transfer" | "bill_match" | "income_category";
export type ProposalAction =
  | "file_as_bill_payment"
  | "file_as_debt_payment"
  | "file_as_transfer"
  | "confirm_bill_match"
  | "file_under_income_category";
/** The existing app actions that apply a proposal. */
export type ProposalApply = "review_mark_matched" | "categories_change";
export type ProposalEvidenceField =
  | "pfc_primary"
  | "pfc_detailed"
  | "bill_suggestion"
  | "category"
  | "name_match"
  | "amount_match"
  | "same_amount_rows";

interface AccountIdentity {
  id: string | null;
  institution: string | null;
  name: string | null;
  mask: string | null;
}

interface ProposalRowOut {
  id: string;
  date: string;
  displayName: string;
  description: string;
  amount: string;
  pending: boolean;
  account: AccountIdentity;
  category: { id: string; name: string } | null;
  /** The bill occurrence "mark matched" would name; null when none is in reach. */
  occurrence: { planKey: string; recurringItemId: string; occurrenceDate: string } | null;
}

export interface ReviewProposal {
  key: string;
  kind: ProposalKind;
  rows: ProposalRowOut[];
  rowCount: number;
  truncated: boolean;
  /** Σ |amount| over every row of the proposal. */
  total: string;
  evidence: Array<{ field: ProposalEvidenceField; value: string }>;
  action: {
    code: ProposalAction;
    target: {
      kind: "bill" | "debt" | "category";
      id: string | null;
      label: string;
      categoryId: string | null;
      categoryName: string | null;
    };
  };
  applyWith: ProposalApply[];
}

const money = (cents: number): string => (cents / 100).toFixed(2);
const centsOf = (v: string | number): number => Math.round(Math.abs(Number(v) || 0) * 100);
const strictCents = (c: number): number => Math.max(100, Math.round(c * 0.01));

type Classified = { row: MovementRowRead; evidence: RowEvidence | null };

interface Bill {
  id: string;
  name: string;
  kind: string;
  amount: number;
  categoryId: string | null;
  frequency: string;
  dayOfMonth: number | null;
  anchorDate: string | null;
  active: string;
  debtId: string | null;
}

/** The occurrence of `bill` a row dated `on` would pay: the nearest one the matcher's window allows. */
function occurrenceFor(bill: Bill, on: string): ProposalRowOut["occurrence"] {
  // rowInMatchWindow: row − plan in [−10, +14] days → plan in [on − 14, on + 10].
  const from = parseISO(addDaysISO(on, -14));
  const to = parseISO(addDaysISO(on, 10));
  const events = expandItem(
    {
      id: bill.id,
      name: bill.name,
      kind: bill.kind,
      amount: String(bill.amount),
      frequency: bill.frequency,
      dayOfMonth: bill.dayOfMonth,
      anchorDate: bill.anchorDate,
      active: bill.active,
    } as Parameters<typeof expandItem>[0],
    from,
    to,
  );
  let best: string | null = null;
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  for (const e of events) {
    if (!best || Math.abs(day(e.date) - day(on)) < Math.abs(day(best) - day(on))) best = e.date;
  }
  return best ? { planKey: `${bill.id}|${best}`, recurringItemId: bill.id, occurrenceDate: best } : null;
}

/**
 * The debt minimum a row dated `on` would pay (the forecast's own expansion,
 * `expandDebtMin`): the nearest one the matcher's window allows. Null when the
 * debt has no minimum to expand there.
 */
function debtOccurrenceFor(debt: typeof debtsTable.$inferSelect, on: string): ProposalRowOut["occurrence"] {
  const events = expandDebtMin(debt, null, parseISO(addDaysISO(on, -14)), parseISO(addDaysISO(on, 10)));
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  let best: (typeof events)[number] | null = null;
  for (const e of events) {
    if (!best || Math.abs(day(e.date) - day(on)) < Math.abs(day(best.date) - day(on))) best = e;
  }
  return best ? { planKey: `${best.itemId}|${best.date}`, recurringItemId: best.itemId, occurrenceDate: best.date } : null;
}

/** ⭐ `GET /review/proposals`. See the file header. Writes nothing. */
export async function buildReviewProposals(householdId: string, ownerUserId: string) {
  const today = householdTodayISO();
  const from = addDaysISO(today, -(PROPOSALS_WINDOW_DAYS - 1));
  const range = { start: from, end: today };

  // The forecast ledger: its tier-2 off-curve pairs (bill_matched) and its suggestions.
  const { ledger } = await computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS });
  const tier2PairedTxnIds = tier2PairedTxnIdsOf(ledger);
  const moneyCtx = await loadMoneyContext(householdId, range, { tier2PairedTxnIds });
  const suggestions = billSuggestionsOf(ledger, moneyCtx.supersede);
  const suggestedIds = [...suggestions.keys()];

  const t = transactionsTable;
  // Filter in SQL: only rows whose Plaid category can make a proposal, or rows the forecast suggests.
  const evidenceWhere = or(
    inArray(sql`upper(${t.pfcPrimary})`, ["LOAN_PAYMENTS", "TRANSFER_OUT", "INCOME"]),
    sql`upper(${t.pfcDetailed}) LIKE 'LOAN\\_PAYMENTS%'`,
    sql`upper(${t.pfcDetailed}) LIKE 'TRANSFER\\_OUT%'`,
    sql`upper(${t.pfcDetailed}) LIKE 'INCOME%'`,
    suggestedIds.length > 0 ? inArray(t.id, suggestedIds) : undefined,
  );
  const [rows, cats, bills, debts, accounts, aliases] = await Promise.all([
    loadMovementRows(householdId, from, today, moneyCtx, { where: evidenceWhere }),
    db
      .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name, kind: budgetCategoriesTable.kind, debtId: budgetCategoriesTable.debtId })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, householdId)),
    db
      .select({
        id: recurringItemsTable.id,
        name: recurringItemsTable.name,
        kind: recurringItemsTable.kind,
        amount: recurringItemsTable.amount,
        categoryId: recurringItemsTable.categoryId,
        frequency: recurringItemsTable.frequency,
        dayOfMonth: recurringItemsTable.dayOfMonth,
        anchorDate: recurringItemsTable.anchorDate,
        active: recurringItemsTable.active,
        debtId: recurringItemsTable.debtId,
      })
      .from(recurringItemsTable)
      .where(and(eq(recurringItemsTable.householdId, householdId), eq(recurringItemsTable.active, "true"))),
    db
      .select()
      .from(debtsTable)
      .where(and(eq(debtsTable.householdId, householdId), eq(debtsTable.status, "active"))),
    loadAccountIdentitiesByExternalId(householdId),
    loadMerchantAliases(householdId),
  ]);

  const evCtx = evidenceContextOf(moneyCtx, suggestions);
  const classified: Classified[] = rows.map((row) => ({
    row,
    evidence: rowEvidenceOf(row, classifyMovement(row, moneyCtx, { explain: true }), evCtx),
  }));

  const catName = new Map(cats.map((c) => [c.id, c.name] as const));
  const transferCategory = cats.find((c) => c.name.trim().toLowerCase() === "transfer") ?? null;
  const billRows: Bill[] = bills.map((b) => ({ ...b, amount: Math.abs(Number(b.amount) || 0) }));
  const billById = new Map(billRows.map((b) => [b.id, b] as const));

  const rowOut = (row: MovementRowRead, occurrence: ProposalRowOut["occurrence"] = null): ProposalRowOut => ({
    id: row.id,
    date: row.occurredOn,
    displayName: displayNameOf(row.description, aliases),
    description: row.description,
    amount: (Number(row.amount) || 0).toFixed(2),
    pending: row.pending,
    account: (row.plaidAccountId ? accounts.get(row.plaidAccountId) : undefined) ?? { id: null, institution: null, name: null, mask: null },
    category: row.categoryId && catName.has(row.categoryId) ? { id: row.categoryId, name: catName.get(row.categoryId)! } : null,
    occurrence,
  });
  const pfcEvidence = (row: MovementRowRead) => {
    const pfc = pfcOf(row);
    const out: ReviewProposal["evidence"] = [];
    if (pfc.primary) out.push({ field: "pfc_primary", value: pfc.primary });
    if (pfc.detailed) out.push({ field: "pfc_detailed", value: pfc.detailed });
    return out;
  };
  const dedupe = (items: ReviewProposal["evidence"]) => {
    const seen = new Set<string>();
    return items.filter((e) => {
      const k = `${e.field}|${e.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const proposals: ReviewProposal[] = [];
  const used = new Set<string>();
  const finish = (
    key: string,
    kind: ProposalKind,
    rowsOut: ProposalRowOut[],
    evidence: ReviewProposal["evidence"],
    action: ReviewProposal["action"],
    applyWith: ProposalApply[],
  ) => {
    const sorted = [...rowsOut].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1));
    for (const r of sorted) used.add(r.id);
    proposals.push({
      key,
      kind,
      rows: sorted.slice(0, PROPOSAL_ROWS_MAX),
      rowCount: sorted.length,
      truncated: sorted.length > PROPOSAL_ROWS_MAX,
      total: money(sorted.reduce((a, r) => a + centsOf(r.amount), 0)),
      evidence: dedupe(evidence),
      action,
      applyWith,
    });
  };

  // ── loan_payment: series of LOAN_PAYMENTS rows → exactly one bill or debt.
  const loanRows = classified.filter(
    ({ row, evidence }) => spendAmount(row) > 0 && pfcOf(row).primary === "LOAN_PAYMENTS" && evidence?.class === "unresolved",
  );
  const byAccount = new Map<string, MovementRowRead[]>();
  for (const { row } of loanRows) {
    const k = row.plaidAccountId ?? `source:${row.source}`;
    const list = byAccount.get(k);
    if (list) list.push(row);
    else byAccount.set(k, [row]);
  }
  const debtCats = new Map<string, string[]>();
  for (const c of cats) {
    if (!c.debtId) continue;
    const list = debtCats.get(c.debtId);
    if (list) list.push(c.name);
    else debtCats.set(c.debtId, [c.name]);
  }
  for (const [account, list] of byAccount) {
    const sorted = [...list].sort((a, b) => centsOf(a.amount) - centsOf(b.amount) || a.id.localeCompare(b.id));
    const series: MovementRowRead[][] = [];
    for (const r of sorted) {
      const last = series[series.length - 1];
      if (last && withinStrictTolerance(Number(last[0]!.amount), Number(r.amount))) last.push(r);
      else series.push([r]);
    }
    for (const s of series) {
      const amount = Number(s[0]!.amount);
      const fits: Array<{ kind: "bill" | "debt"; id: string; label: string; categoryId: string | null; nameHit: { row: MovementRowRead; name: string } }> = [];
      for (const b of billRows) {
        if (b.kind === "income" || b.amount <= 0) continue;
        const names = [b.name, ...(b.categoryId && catName.has(b.categoryId) ? [catName.get(b.categoryId)!] : [])];
        const hit = firstNameHit(s, names);
        if (!hit) continue;
        if (!rowWithinMatchAmount(-b.amount, -Math.abs(amount))) continue;
        fits.push({ kind: "bill", id: b.id, label: b.name, categoryId: b.categoryId, nameHit: hit });
      }
      for (const d of debts) {
        const min = centsOf(d.minPayment);
        if (min <= 0) continue;
        const hit = firstNameHit(s, [d.name, ...(debtCats.get(d.id) ?? [])]);
        if (!hit) continue;
        if (centsOf(amount) < min - strictCents(min)) continue;
        fits.push({ kind: "debt", id: d.id, label: d.name, categoryId: null, nameHit: hit });
      }
      if (fits.length !== 1) continue;
      const f = fits[0]!;
      const bill = f.kind === "bill" ? billById.get(f.id)! : null;
      const debtRow = f.kind === "debt" ? debts.find((d) => d.id === f.id)! : null;
      const evidence: ReviewProposal["evidence"] = [
        ...s.flatMap(pfcEvidence),
        { field: "name_match", value: `${f.nameHit.row.description} ~ ${f.nameHit.name}` },
        { field: "amount_match", value: `${money(centsOf(amount))} ~ ${bill ? money(centsOf(bill.amount)) : `minimum ${money(centsOf(debtRow!.minPayment))}`}` },
      ];
      if (s.length > 1) evidence.push({ field: "same_amount_rows", value: String(s.length) });
      const debtCategory = f.kind === "debt" ? (cats.find((c) => c.debtId === f.id) ?? null) : null;
      const categoryId = f.kind === "bill" ? f.categoryId : (debtCategory?.id ?? null);
      finish(
        `loan_payment:${account}:${centsOf(amount)}:${f.kind}:${f.id}`,
        "loan_payment",
        s.map((r) => rowOut(r, bill ? occurrenceFor(bill, r.occurredOn) : debtOccurrenceFor(debtRow!, r.occurredOn))),
        evidence,
        {
          code: f.kind === "bill" ? "file_as_bill_payment" : "file_as_debt_payment",
          target: {
            kind: f.kind,
            id: f.id,
            label: f.label,
            categoryId,
            categoryName: categoryId ? (catName.get(categoryId) ?? null) : null,
          },
        },
        categoryId ? ["categories_change", "review_mark_matched"] : ["review_mark_matched"],
      );
    }
  }

  // ── transfer: savings / account transfers counted as spending, filed under an expense category.
  const SPEND_COVERAGES = new Set(["needs_classification", "allowance_weekly", "allowance_monthly", "unplanned"]);
  const transferGroups = new Map<string, MovementRowRead[]>();
  for (const { row } of classified) {
    if (used.has(row.id) || spendAmount(row) <= 0 || row.isTransfer) continue;
    const pfc = pfcOf(row);
    if (pfc.detailed !== "TRANSFER_OUT_SAVINGS" && pfc.detailed !== "TRANSFER_OUT_ACCOUNT_TRANSFER") continue;
    if (namesPersonToPersonRail(row.description)) continue;
    const cat = row.categoryId ? moneyCtx.categoriesById.get(row.categoryId) : undefined;
    if (!cat || cat.kind !== "expense" || moneyCtx.filingCtx.uncategorizedIds.has(row.categoryId!)) continue;
    const m = classifyMovement(row, moneyCtx);
    if (!SPEND_COVERAGES.has(m.coverage)) continue;
    const k = `${merchantSignature(row.description)}|${row.plaidAccountId ?? row.source}`;
    const list = transferGroups.get(k);
    if (list) list.push(row);
    else transferGroups.set(k, [row]);
  }
  for (const [k, list] of transferGroups) {
    finish(
      `transfer:${k}`,
      "transfer",
      list.map((r) => rowOut(r)),
      [
        ...list.flatMap(pfcEvidence),
        ...[...new Set(list.map((r) => r.categoryId!))].map((id) => ({ field: "category" as const, value: catName.get(id) ?? "" })),
      ],
      {
        code: "file_as_transfer",
        target: { kind: "category", id: transferCategory?.id ?? null, label: transferCategory?.name ?? "Transfer", categoryId: transferCategory?.id ?? null, categoryName: transferCategory?.name ?? null },
      },
      ["categories_change"],
    );
  }

  // ── bill_match: an unfiled row the forecast only suggests for a bill.
  for (const { row, evidence } of classified) {
    if (used.has(row.id) || evidence?.reason !== "bill_suggestion") continue;
    const target = evidence.suggestion?.target;
    if (!target) continue;
    const bill = billById.get(target.itemId) ?? null;
    finish(
      `bill_match:${row.id}`,
      "bill_match",
      [rowOut(row, { planKey: target.planKey, recurringItemId: target.itemId, occurrenceDate: target.occurrenceDate })],
      evidence.evidence.map((e) => ({ field: e.field === "household" ? "category" : (e.field as ProposalEvidenceField), value: e.value })),
      {
        code: "confirm_bill_match",
        target: {
          kind: "bill",
          id: target.itemId,
          label: target.label,
          categoryId: bill?.categoryId ?? null,
          categoryName: bill?.categoryId ? (catName.get(bill.categoryId) ?? null) : null,
        },
      },
      ["review_mark_matched"],
    );
  }

  // ── income_category: a paycheck filed under an expense category.
  const incomePlans = billRows.filter((b) => b.kind === "income" && b.amount > 0);
  const incomeGroups = new Map<string, { plan: Bill; rows: MovementRowRead[] }>();
  for (const { row, evidence } of classified) {
    if (used.has(row.id) || creditAmount(row) <= 0) continue;
    if (evidence?.reason !== "credit_in_expense_category" || pfcOf(row).primary !== "INCOME") continue;
    const fits = incomePlans.filter((p) => labelEvidence(p.name, row.description) && rowWithinMatchAmount(p.amount, Number(row.amount)));
    if (fits.length !== 1) continue;
    const plan = fits[0]!;
    const k = `${merchantSignature(row.description)}|${row.plaidAccountId ?? row.source}|${plan.id}`;
    const g = incomeGroups.get(k);
    if (g) g.rows.push(row);
    else incomeGroups.set(k, { plan, rows: [row] });
  }
  for (const [k, { plan, rows: list }] of incomeGroups) {
    finish(
      `income_category:${k}`,
      "income_category",
      list.map((r) => rowOut(r)),
      [
        ...list.flatMap(pfcEvidence),
        ...[...new Set(list.map((r) => r.categoryId!))].map((id) => ({ field: "category" as const, value: catName.get(id) ?? "" })),
        { field: "name_match", value: `${list[0]!.description} ~ ${plan.name}` },
        { field: "amount_match", value: `${money(centsOf(list[0]!.amount))} ~ ${money(centsOf(plan.amount))}` },
      ],
      {
        code: "file_under_income_category",
        target: {
          kind: "category",
          id: plan.categoryId,
          label: plan.name,
          categoryId: plan.categoryId,
          categoryName: plan.categoryId ? (catName.get(plan.categoryId) ?? null) : null,
        },
      },
      ["categories_change"],
    );
  }

  proposals.sort((a, b) => centsOf(b.total) - centsOf(a.total) || a.key.localeCompare(b.key));
  return {
    window: { from, to: today, days: PROPOSALS_WINDOW_DAYS },
    count: proposals.length,
    truncated: proposals.length > PROPOSALS_MAX_ITEMS,
    items: proposals.slice(0, PROPOSALS_MAX_ITEMS),
  };
}

/** The first row of a series whose description carries a distinctive word of one of `names`. */
function firstNameHit(series: readonly MovementRowRead[], names: readonly string[]): { row: MovementRowRead; name: string } | null {
  for (const r of series) {
    for (const n of names) if (labelEvidence(n, r.description)) return { row: r, name: n };
  }
  return null;
}

/** The household's linked accounts, by their external Plaid id. */
async function loadAccountIdentitiesByExternalId(householdId: string): Promise<Map<string, AccountIdentity>> {
  const rows = await db
    .select({
      id: plaidAccountsTable.id,
      accountId: plaidAccountsTable.accountId,
      name: plaidAccountsTable.name,
      mask: plaidAccountsTable.mask,
      institution: plaidItemsTable.institutionName,
    })
    .from(plaidAccountsTable)
    .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
    .where(eq(plaidAccountsTable.householdId, householdId));
  return new Map(rows.map((r) => [r.accountId, { id: r.id, institution: r.institution ?? null, name: r.name ?? null, mask: r.mask ?? null }]));
}

export type ReviewProposalsView = Awaited<ReturnType<typeof buildReviewProposals>>;
