// ⭐ (WP6) WHY THE BUDGET'S "THIS MONTH" AND HOUSEHOLD SPENDING DIFFER — IN DOLLARS,
// ROW BY ROW, SO THE DIFFERENCE IS NEVER A MYSTERY.
//
// Two honest figures answer two different questions about the same month:
//   A  Budget actual (`GET /budget/months/:m` summary.expenses.actual): every
//      row filed to an expense line, the WHOLE calendar month, every account;
//      only transfers are skipped (`aggregateBudgetMonth`). Card payments a
//      seed rule filed to Misc / Buffer, debt payments in a debt line,
//      reimbursables and bank noise all count; refunds do not net; a row with
//      no line (no category, the system Uncategorized) counts nowhere.
//   B  Household spending to date (the spine's `spentMonth`,
//      `buildSpendingFacts(monthStart, today).householdSpend`): every purchase
//      the one spending rule calls spend (`classifyOutflow` rule 10), through
//      TODAY, categorized or not, less the refunds on the same account (never
//      below zero per account).
//
// The identity, to the cent:
//   A − B = futureDated + cardPayments + debtPayments + excludedNames
//         + reimbursable + bankNoise + splitsOutsideLines
//         − uncategorized − parkedUncategorized + refundsNetted + unexplained
// where (all whole cents, each row in exactly one term):
//   futureDated          A's rows dated after today (B's window ends today).
//   cardPayments         A's rows the rule calls a card payment (rules 3, 8, 9).
//   debtPayments         A's rows that pay a debt (rule 2 debt tag, rule 4 debt line).
//   excludedNames        A's rows in a category the rule excludes by name
//                        (Transfer, Ignore, Reimbursement, …; rule 5).
//   reimbursable         A's rows flagged reimbursable (rule 7).
//   bankNoise            A's rows with a bank-noise description (rule 9b).
//   splitsOutsideLines   SIGNED: a split row's parts counted by A less what B
//                        counts of the same row — normally ≤ 0, the parts of a
//                        purchase filed outside the expense lines.
//   uncategorized        B's purchases with no category (or a deleted one).
//   parkedUncategorized  B's purchases parked in a category with no budget line
//                        (the system Uncategorized).
//   refundsNetted        what refunds took off B (A never nets them).
//   unexplained          must be 0: the part no term explains. It is A as the
//                        Budget page computes it (`aggregateBudgetMonth`) less
//                        the A this walk attributed row by row — a drift between
//                        the two is disclosed here, never hidden in a term.
// Both sides read the SAME prepared rows: a pending row its posted row replaced
// counts in neither, and each posted row in its effective filing
// (`effectiveFiling`), exactly as both figures do. Read-only and pure.

import { aggregateBudgetMonth, spendCents, type BudgetMonthRow } from "./budgetActuals";
import { effectiveFiling, type FilingContext } from "./pendingFiling";
import type { SupersededPending } from "./supersededPending";
import {
  classifyOutflow,
  classifyRefund,
  creditAmount,
  isRealIncome,
  netAccountOf,
  type SpendContext,
} from "./spendingFilter";

/** One ledger row of the month: the Budget's row plus what the spending rule reads. */
export interface ReconcileRow extends BudgetMonthRow {
  occurredOn: string;
  plaidAccountId: string | null;
  pfcDetailed: string | null;
}

export type ReconcileTerm =
  | "futureDated"
  | "cardPayments"
  | "debtPayments"
  | "excludedNames"
  | "reimbursable"
  | "bankNoise"
  | "splitsOutsideLines"
  | "uncategorized"
  | "parkedUncategorized"
  | "refundsNetted";

/** Whole cents. `difference` = `budgetActual` − `householdSpendToDate`. */
export interface MonthSpendReconciliation {
  budgetActual: number;
  householdSpendToDate: number;
  difference: number;
  terms: Record<ReconcileTerm, number>;
  unexplained: number;
}

const centsOf = (amount: string): number => Math.round((parseFloat(amount) || 0) * 100);

/**
 * ⭐ The reconciliation of one month (see the file header). `rows` are the
 * month's rows (the Budget month's query); `today` is the household's today
 * (the spine's clock); `expenseLineIds` are the category ids of the month's
 * expense lines (every Budget line whose kind is not income).
 */
export function reconcileMonthSpend(
  rows: readonly ReconcileRow[],
  supersede: Pick<SupersededPending, "replacedIds" | "replacedBy">,
  filingCtx: FilingContext,
  spendCtx: SpendContext,
  splitParts: ReadonlyMap<string, readonly { categoryId: string; amount: string }[]>,
  opts: { today: string; expenseLineIds: ReadonlySet<string> },
): MonthSpendReconciliation {
  const { today, expenseLineIds } = opts;
  const terms: Record<ReconcileTerm, number> = {
    futureDated: 0,
    cardPayments: 0,
    debtPayments: 0,
    excludedNames: 0,
    reimbursable: 0,
    bankNoise: 0,
    splitsOutsideLines: 0,
    uncategorized: 0,
    parkedUncategorized: 0,
    refundsNetted: 0,
  };
  // B's purchases and refunds, per account (whole cents), as householdSpend nets them.
  const spendByAcct = new Map<string, number>();
  const refundByAcct = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, c: number) => m.set(k, (m.get(k) ?? 0) + c);
  let attributedA = 0;

  for (const row of rows) {
    // Replaced pending rows count in neither figure.
    if (supersede.replacedIds.has(row.id)) continue;
    const t = effectiveFiling(row, supersede.replacedBy.get(row.id), filingCtx);

    // ── A: what the Budget's expense lines count of this row (aggregateBudgetMonth's shares).
    const parts = splitParts.get(row.id);
    const shares = parts
      ? parts.map((p) => ({ categoryId: p.categoryId, spend: spendCents(row.source, centsOf(p.amount)) }))
      : t.categoryId
        ? [{ categoryId: t.categoryId, spend: spendCents(row.source, centsOf(row.amount)) }]
        : [];
    let inLines = 0;
    if (!t.isTransfer) for (const s of shares) if (expenseLineIds.has(s.categoryId)) inLines += s.spend;
    attributedA += inLines;

    // ── B's window ends today: a later row is A's alone.
    if (row.occurredOn > today) {
      terms.futureDated += inLines;
      continue;
    }

    // ── B: the one spending rule, as buildSpendingFacts applies it.
    const c = classifyOutflow(t, spendCtx);
    const whole = spendCents(row.source, centsOf(row.amount));
    switch (c.kind) {
      case "spend": {
        add(spendByAcct, netAccountOf(t), whole);
        if (parts) terms.splitsOutsideLines += inLines - whole;
        else if (inLines !== whole) {
          // Unsplit: in an expense line (inLines = whole), or in none.
          if (c.categorized) terms.parkedUncategorized += whole;
          else terms.uncategorized += whole;
        }
        break;
      }
      case "transfer":
        // Skipped by both (A skips transfers too): nothing to attribute.
        break;
      case "debt_payment":
        terms.debtPayments += inLines;
        break;
      case "card_payment":
        terms.cardPayments += inLines;
        break;
      case "excluded_category":
        terms.excludedNames += inLines;
        break;
      case "reimbursable":
        terms.reimbursable += inLines;
        break;
      case "bank_noise":
        terms.bankNoise += inLines;
        break;
      case "income":
      case "not_outflow": {
        // A counts these only through split parts in an expense line.
        terms.splitsOutsideLines += inLines;
        if (c.kind === "not_outflow" && !isRealIncome(t, spendCtx) && classifyRefund(t, spendCtx)) {
          add(refundByAcct, netAccountOf(t), Math.round(creditAmount(t) * 100));
        }
        break;
      }
    }
  }

  // B = per account, purchases less refunds, never below zero.
  let householdSpendToDate = 0;
  for (const [a, s] of spendByAcct) householdSpendToDate += Math.max(0, s - (refundByAcct.get(a) ?? 0));
  for (const [a, r] of refundByAcct) terms.refundsNetted += Math.min(spendByAcct.get(a) ?? 0, r);

  // A as the Budget page computes it — the canonical figure.
  let budgetActual = 0;
  for (const [categoryId, a] of aggregateBudgetMonth(rows, supersede, filingCtx, splitParts).byCategory) {
    if (expenseLineIds.has(categoryId)) budgetActual += a.spend.posted + a.spend.pending;
  }

  return {
    budgetActual,
    householdSpendToDate,
    difference: budgetActual - householdSpendToDate,
    terms,
    // A walked row by row − B ≡ the terms, by construction; any gap between the
    // Budget page's own A and this walk's is disclosed here.
    unexplained: budgetActual - attributedA,
  };
}

/** The identity's right-hand side without `unexplained` (whole cents): signs as in the header. */
export function explainedByTerms(t: Record<ReconcileTerm, number>): number {
  return (
    t.futureDated + t.cardPayments + t.debtPayments + t.excludedNames + t.reimbursable + t.bankNoise +
    t.splitsOutsideLines - t.uncategorized - t.parkedUncategorized + t.refundsNetted
  );
}
