import type {
  CorrectionBankingFigures,
  CorrectionPeriodFigures,
  CorrectionPreview,
  CorrectionPreviewLimitationsItem,
  CorrectionRow,
  ReviewProposal,
} from "@workspace/api-client-react/features";
import { WEEK_FIGURE_WORDS } from "@workspace/avalanche-core/glossary";
import { formatCurrency } from "@/lib/utils";
import { householdToday } from "@/lib/householdDay";
import { rangeWords } from "./reviewDates";
import { BUCKETS, dayWords } from "./words";

/**
 * (Q5) The words of the correction workflow: what a fix does to each row, which
 * totals it moves (before → after), and why a refusal happened. Display only:
 * every figure is the server's dry run (`POST /review/proposals/:key/apply?dryRun=1`),
 * which reads the same builders as the screens. A total is listed only when its
 * before and after differ; a comparison of two strings decides that, never a sum.
 */

export interface FigureChange {
  key: string;
  /** "This week" / "October budget" … */
  scope: string;
  label: string;
  before: string;
  after: string;
}

const cents = (v: string | null | undefined): number | null => (v == null ? null : Math.round(Number(v) * 100));
const same = (a: string | null | undefined, b: string | null | undefined) => cents(a) === cents(b);
const face = (v: string | null | undefined) => (v == null ? "—" : formatCurrency(v));

function periodChanges(scope: string, keyPrefix: string, before: CorrectionPeriodFigures, after: CorrectionPeriodFigures): FigureChange[] {
  const out: FigureChange[] = [];
  const push = (k: string, label: string, b: string | null, a: string | null) => {
    if (!same(b, a)) out.push({ key: `${keyPrefix}-${k}`, scope, label, before: face(b), after: face(a) });
  };
  push("known", WEEK_FIGURE_WORDS.known, before.known, after.known);
  push("unresolved", WEEK_FIGURE_WORDS.unresolved, before.unresolved, after.unresolved);
  push("actual", WEEK_FIGURE_WORDS.cautious, before.actual, after.actual);
  // Plan comparison: remaining and over are two views of one fact; say the one that exists.
  const overB = cents(before.over) ?? 0;
  const overA = cents(after.over) ?? 0;
  if (overB > 0 || overA > 0) push("over", "Over", before.over, after.over);
  else push("remaining", "Left", before.remaining, after.remaining);
  return out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (monthStart: string) => MONTHS[Number(monthStart.slice(5, 7)) - 1] ?? monthStart;

function bankingChanges(scope: string, before: CorrectionBankingFigures, after: CorrectionBankingFigures): FigureChange[] {
  const out: FigureChange[] = [];
  for (const b of BUCKETS) {
    const x = before.buckets[b.name];
    const y = after.buckets[b.name];
    if (x.count === y.count && same(x.moneyIn, y.moneyIn) && same(x.moneyOut, y.moneyOut)) continue;
    out.push({ key: `bank-${b.name}`, scope, label: b.title, before: `${x.count} ${x.count === 1 ? "row" : "rows"}`, after: `${y.count} ${y.count === 1 ? "row" : "rows"}` });
  }
  if (before.unresolvedInRange !== after.unresolvedInRange) {
    out.push({ key: "bank-inbox", scope, label: "Charges to match", before: String(before.unresolvedInRange), after: String(after.unresolvedInRange) });
  }
  return out;
}

/** Every total the fix moves, in the order the owner reads them: week, month, budget, Banking. */
export function figureChanges(p: CorrectionPreview, today: string = householdToday(new Date())): FigureChange[] {
  const f = p.figures;
  const out = [...periodChanges("This week", "week", f.week.before, f.week.after), ...periodChanges("This month", "month", f.month.before, f.month.after)];
  for (const m of f.budgetMonths) {
    const scope = `${monthName(m.monthStart)} budget`;
    const push = (k: string, label: string, b: string, a: string) => {
      if (!same(b, a)) out.push({ key: `budget-${m.monthStart}-${k}`, scope, label, before: face(b), after: face(a) });
    };
    push("income", "Income", m.before.income, m.after.income);
    push("expenses", "Expenses", m.before.expenses, m.after.expenses);
    push("net", "Net", m.before.net, m.after.net);
    const afterLines = new Map(m.after.lines.map((l) => [l.categoryId, l]));
    for (const l of m.before.lines) {
      const a = afterLines.get(l.categoryId);
      if (a && !same(l.actual, a.actual)) out.push({ key: `budget-${m.monthStart}-line-${l.categoryId}`, scope, label: l.name, before: face(l.actual), after: face(a.actual) });
    }
  }
  for (const b of f.banking) {
    if (!b.after) continue;
    const name = [b.account.institution, b.account.name].filter(Boolean).join(" ") + (b.account.mask ? ` ••${b.account.mask.slice(-4)}` : "");
    // The dry run reads this fix's own rows' dates, not the page's range: the dates are said, so a count
    // of 6 here is never read against the 5 on the page.
    const when = b.from === b.to ? dayWords(b.from) : rangeWords({ from: b.from, to: b.to }, today);
    out.push(...bankingChanges(["Banking", name, when].filter(Boolean).join(" · "), b.before, b.after));
  }
  return out;
}

/** What the fix does to one row, in a short line each. */
export function rowChangeWords(row: CorrectionRow, proposal: Pick<ReviewProposal, "rows" | "action">): string[] {
  const out: string[] = [];
  const was = proposal.rows.find((r) => r.id === row.id)?.category?.name ?? null;
  const target = proposal.action.target.categoryName ?? proposal.action.target.label;
  if (row.after.categoryId !== row.before.categoryId) out.push(`Filed under ${target}${was ? ` (was ${was})` : ""}`);
  if (row.after.isTransfer !== row.before.isTransfer) out.push(row.after.isTransfer ? "Counted as a transfer" : "No longer a transfer");
  if (row.after.weeklyAllowance !== row.before.weeklyAllowance) out.push(row.after.weeklyAllowance ? "Counts toward the weekly plan" : "Leaves the weekly plan");
  if (row.after.monthlyAllowance !== row.before.monthlyAllowance) out.push(row.after.monthlyAllowance ? "Counts toward the monthly plan" : "Leaves the monthly plan");
  if (row.resolution) out.push(`Matched to ${proposal.action.target.label} on ${dayWords(row.resolution.occurrenceDate)}`);
  else if (row.resolutionSkipped === "occurrence_shared") out.push("Another row answers this bill");
  else if (row.resolutionSkipped === "no_occurrence") out.push("No bill in reach to match");
  return out;
}

export function limitationWords(limits: readonly CorrectionPreviewLimitationsItem[]): string | null {
  const words: Record<CorrectionPreviewLimitationsItem, string> = {
    listed_rows_only: "Only the rows listed are changed.",
    forecast_pairs_as_before: "Bill matches on the forecast may shift once saved.",
    banking_after_not_previewed: "Banking totals are not previewed.",
  };
  const lines = limits.map((l) => words[l]).filter(Boolean);
  return lines.length ? lines.join(" ") : null;
}

/** The server's one-line reason for a refused fix or undo, else a plain default. */
export function refusalWords(err: unknown, fallback: string): string {
  const data = (err as { data?: { error?: unknown; code?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error) return data.error;
  return fallback;
}

export function refusalCode(err: unknown): string | null {
  const data = (err as { data?: { code?: unknown } } | null)?.data;
  return typeof data?.code === "string" ? data.code : null;
}
