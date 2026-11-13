import type { CashSignalAssumedPaidPlan, CashSignalListedPlan } from "@workspace/api-client-react";
import { card as kitCard, cardHead, Help } from "@/ui";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { shortDate } from "@/lib/dates";
import { draggingPlanLine, type DraggingPlanRow } from "@/lib/forecastPastDue";
import { CollapsibleSection } from "./CollapsibleSection";
import type { PlanLine } from "@/lib/forecastMatch";

/** A pending bank row a plan can be matched to (the page's bank inbox), already worded. */
export type BankOption = { id: string; label: string };

/** Anchor ids the "How this adds up" links scroll to (ForecastBody `LIST_ANCHORS`). */
const ANCHOR = {
  unpaid: "forecast-unpaid",
  older: "forecast-older-unpaid",
  income: "forecast-income-not-arrived",
} as const;

/** A listed plan (off the curve) in the shape the page's Skip handler takes: shown and keyed by its due date. */
export function listedRow(p: CashSignalListedPlan): DraggingPlanRow {
  return {
    itemId: p.itemId,
    label: p.label,
    amount: Number(p.amount),
    originalDate: p.dueDate,
    occurrenceDate: p.occurrenceDate,
    effectiveDate: p.dueDate,
  };
}

type Handlers = {
  busy: boolean;
  bankOptions: BankOption[];
  partialKeys: ReadonlySet<string>;
  onJump: (itemId: string, date: string) => void;
  /** Writes `missed` (Undo toast). */
  onMarkMissed: (line: PlanLine) => void;
  /** Writes `skipped` (Undo toast). */
  onSkip: (row: DraggingPlanRow) => void;
  /** Writes `matched` to a pending bank row. */
  onMatch: (txnId: string, line: PlanLine) => void;
};

const partlyPaid = (row: DraggingPlanRow, keys: ReadonlySet<string>) =>
  keys.has(`${row.itemId}|${row.occurrenceDate}`) ||
  keys.has(`${row.itemId}|${row.originalDate}`) ||
  keys.has(`${row.itemId}|${row.effectiveDate}`);

/**
 * One plan with its three answers — Mark missed (or "Didn't arrive" for
 * income), Skip, Match to a pending bank row. (PR6) Every action sends the
 * occurrence key, never the moved-to date. (PR5b) A partly-paid plan shows
 * "Partly paid" instead: an answer here would replace the partial.
 */
function PlanRow({ row, prefix, missedWord, h }: { row: DraggingPlanRow; prefix: string; missedWord: string; h: Handlers }) {
  const line = draggingPlanLine(row);
  const id = `${row.itemId}-${row.originalDate}`;
  return (
    <li
      data-testid={`${prefix}-${id}`}
      className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-line/70 px-4 py-2.5 last:border-b-0"
    >
      <button
        type="button"
        onClick={() => h.onJump(row.itemId, row.originalDate)}
        className="press -mx-1 flex min-w-0 flex-1 items-center justify-between gap-3 rounded-control px-1 py-1 text-left outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-brand-navy/40"
        title={`Jump to ${row.label} in the planned-items register`}
        data-testid={`${prefix}-jump-${id}`}
      >
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-neutral-700">{row.label}</div>
          <div className="text-micro text-neutral-600">Due {shortDate(row.originalDate)}</div>
        </div>
        <span className={`fig text-label ${row.amount < 0 ? "text-foreground" : "text-brand-navy"}`}>
          {formatCurrency(row.amount)}
        </span>
      </button>
      {partlyPaid(row, h.partialKeys) ? (
        <span className="chip warn" data-testid={`${prefix}-partial-${id}`}>
          Partly paid
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5" data-testid={`${prefix}-actions-${id}`}>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={h.busy}
            onClick={() => h.onMarkMissed(line)}
            data-testid={`${prefix}-mark-missed-${id}`}
          >
            {missedWord}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={h.busy}
            onClick={() => h.onSkip(row)}
            data-testid={`${prefix}-skip-${id}`}
          >
            Skip
          </Button>
          <Select
            onValueChange={(v) => {
              if (h.bankOptions.some((o) => o.id === v)) h.onMatch(v, line);
            }}
            disabled={h.busy || h.bankOptions.length === 0}
          >
            <SelectTrigger
              className="h-7 w-[170px] text-xs"
              data-testid={`${prefix}-match-trigger-${id}`}
              title={h.bankOptions.length === 0 ? "No pending bank transactions to match" : "Match this plan to a pending bank transaction"}
            >
              <SelectValue placeholder="Mark matched to…" />
            </SelectTrigger>
            <SelectContent>
              {h.bankOptions.length === 0 && <div className="px-2 py-1 text-micro text-neutral-600">No pending bank txns</div>}
              {h.bankOptions.map((o) => (
                <SelectItem key={o.id} value={o.id} data-testid={`${prefix}-match-option-${id}-${o.id}`}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </li>
  );
}

const groupHead = "flex flex-wrap items-center gap-2 border-t border-brand-line px-4 pt-3 pb-1";
const groupTitle = "text-label font-semibold text-brand-navy";

/**
 * ⭐ (T3) THE LISTS THE CASH SIGNAL RETURNS, ALL ON SCREEN. Before, only the
 * carried past-due rows showed ("Past due"); three server lists were returned
 * and shown nowhere. Now, from the same cash signal, reusing the page's own
 * handlers (so every answer keeps its Undo toast):
 *   - Unpaid items: plans due in the last 14 days carried onto the curve
 *     (`events` moved off their date), then "Paid by a bank row"
 *     (`overdueAssumedPaid`, answered "Not this" to put the plan back), then
 *     "Older than 14 days · off the curve" (`overdueOutsideForecast`);
 *   - Income not arrived (`incomeNotArrived`): "Didn't arrive" / Skip / Match.
 * Display only: every amount and date is the server's.
 */
export function ListedPlans({
  carried,
  carriedTo,
  carriedTotal,
  assumedPaid,
  older,
  incomeNotArrived,
  onNotThis,
  split = false,
  ...h
}: Handlers & {
  carried: DraggingPlanRow[];
  carriedTo: string | null;
  carriedTotal: number;
  assumedPaid: CashSignalAssumedPaidPlan[];
  older: CashSignalListedPlan[];
  incomeNotArrived: CashSignalListedPlan[];
  /** Rejects the bank row's pair ("not_match"): the plan goes back on the curve (Undo toast). */
  onNotThis: (p: CashSignalAssumedPaidPlan) => void;
  /**
   * ⭐ (Readable forecast, `/forecast`) "Unpaid items" keeps only the carried rows and stays open — they need
   * answers; "Paid by a bank row", "Older than 14 days" and "Income not arrived" become folded sections whose
   * heads show the count and the total. Opening one shows exactly the rows and answers below. Off: one card.
   */
  split?: boolean;
}) {
  const hasCarried = carried.length > 0 && !!carriedTo;
  const hasUnpaid = hasCarried || assumedPaid.length > 0 || older.length > 0;

  const unpaidHead = (
    <div className={cardHead}>
      <h2 className="text-title font-semibold text-foreground">Unpaid items</h2>
      {/* (Fewer words) What resolving one does, one hover away. */}
      {hasCarried && <Help>Resolving a row here removes it from the projection for that day.</Help>}
      {hasCarried && (
        <>
          <span className="chip bad" data-testid="dragging-plans-chip">
            {carried.length} · carried to {shortDate(carriedTo!)}
          </span>
          <span className="ml-auto fig text-label text-bad" data-testid="dragging-plans-total">
            {formatCurrency(carriedTotal)}
          </span>
        </>
      )}
    </div>
  );
  const carriedList = hasCarried && (
    <ul data-testid="dragging-plans-list">
      {carried.map((row) => (
        <PlanRow key={`${row.itemId}|${row.originalDate}`} row={row} prefix="dragging-plan" missedWord="Mark missed" h={h} />
      ))}
    </ul>
  );
  const assumedList = (
    <ul data-testid="assumed-paid-list">
      {assumedPaid.map((p) => {
        const remainder = Number(p.unpaidRemainder);
        return (
          <li
            key={p.planKey}
            data-testid={`assumed-paid-${p.itemId}-${p.dueDate}`}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-line/70 px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-body font-medium text-neutral-700">{p.label}</span>
                <span className="fig text-label text-neutral-700">{formatCurrency(Number(p.planAmount))}</span>
              </div>
              <div className="text-micro text-neutral-600" data-testid={`assumed-paid-words-${p.itemId}-${p.dueDate}`}>
                {/* Words carry the direction ("paid", "still unpaid"): the amounts read unsigned. */}
                Due {shortDate(p.dueDate)} · paid {formatCurrency(Math.abs(Number(p.txnAmount)))}
                {Number.isFinite(remainder) && remainder !== 0 ? ` · ${formatCurrency(Math.abs(remainder))} still unpaid` : ""}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={h.busy}
              onClick={() => onNotThis(p)}
              aria-label={`Not paid by that bank row: ${p.label}, due ${shortDate(p.dueDate)}`}
              data-testid={`assumed-paid-not-this-${p.itemId}-${p.dueDate}`}
            >
              Not this
            </Button>
          </li>
        );
      })}
    </ul>
  );
  const olderList = (
    <ul data-testid="older-unpaid-list">
      {older.map((p) => (
        <PlanRow key={p.planKey} row={listedRow(p)} prefix="older-plan" missedWord="Mark missed" h={h} />
      ))}
    </ul>
  );
  const incomeList = (
    <ul data-testid="income-not-arrived-list">
      {incomeNotArrived.map((p) => (
        <PlanRow key={p.planKey} row={listedRow(p)} prefix="income-plan" missedWord="Didn't arrive" h={h} />
      ))}
    </ul>
  );
  const anchorClass = "scroll-mt-[var(--page-sticky-top,0px)] outline-none";

  if (split) {
    // Totals of the rows each section lists — the server's amounts, summed only to head the fold.
    const sum = (xs: ReadonlyArray<{ amount: string }>) => xs.reduce((s, x) => s + Number(x.amount), 0);
    const paidTotal = assumedPaid.reduce((s, p) => s + Number(p.planAmount), 0);
    const olderTotal = sum(older);
    const incomeTotal = sum(incomeNotArrived);
    return (
      <>
        {hasCarried && (
          <section className={`${kitCard} ${anchorClass}`} id={ANCHOR.unpaid} tabIndex={-1} data-testid="card-dragging-plans-summary">
            {unpaidHead}
            {carriedList}
          </section>
        )}
        {assumedPaid.length > 0 && (
          <CollapsibleSection id="paid-by-bank" title="Paid by a bank row" count={assumedPaid.length} chipClass="chip info" total={formatCurrency(paidTotal)}>
            <section className={kitCard} data-testid="assumed-paid-group">
              <h2 className="sr-only">Paid by a bank row</h2>
              {assumedList}
            </section>
          </CollapsibleSection>
        )}
        {older.length > 0 && (
          <CollapsibleSection
            id="older-unpaid"
            title="Older than 14 days · off the curve"
            count={older.length}
            total={formatCurrency(olderTotal)}
          >
            <section className={`${kitCard} ${anchorClass}`} id={ANCHOR.older} tabIndex={-1} data-testid="older-unpaid-group">
              <h2 className="sr-only">Older than 14 days · off the curve</h2>
              {olderList}
            </section>
          </CollapsibleSection>
        )}
        {incomeNotArrived.length > 0 && (
          <CollapsibleSection
            id="income-not-arrived"
            title="Income not arrived"
            count={`${incomeNotArrived.length} · off the curve`}
            chipClass="chip warn"
            total={formatCurrency(incomeTotal)}
          >
            <section className={`${kitCard} ${anchorClass}`} id={ANCHOR.income} tabIndex={-1} data-testid="card-income-not-arrived">
              <h2 className="sr-only">Income not arrived</h2>
              {incomeList}
            </section>
          </CollapsibleSection>
        )}
      </>
    );
  }

  return (
    <>
      {hasUnpaid && (
        <section className={`${kitCard} ${anchorClass}`} id={ANCHOR.unpaid} tabIndex={-1} data-testid="card-dragging-plans-summary">
          {unpaidHead}
          {carriedList}

          {assumedPaid.length > 0 && (
            <div data-testid="assumed-paid-group">
              <div className={groupHead}>
                <h3 className={groupTitle}>Paid by a bank row</h3>
                <span className="chip info">{assumedPaid.length}</span>
              </div>
              {assumedList}
            </div>
          )}

          {older.length > 0 && (
            <div id={ANCHOR.older} tabIndex={-1} className={anchorClass} data-testid="older-unpaid-group">
              <div className={groupHead}>
                <h3 className={groupTitle}>Older than 14 days · off the curve</h3>
                <span className="chip gray">{older.length}</span>
              </div>
              {olderList}
            </div>
          )}
        </section>
      )}

      {incomeNotArrived.length > 0 && (
        <section className={`${kitCard} ${anchorClass}`} id={ANCHOR.income} tabIndex={-1} data-testid="card-income-not-arrived">
          <div className={cardHead}>
            <h2 className="text-title font-semibold text-foreground">Income not arrived</h2>
            <span className="chip warn">{incomeNotArrived.length} · off the curve</span>
          </div>
          {incomeList}
        </section>
      )}
    </>
  );
}
