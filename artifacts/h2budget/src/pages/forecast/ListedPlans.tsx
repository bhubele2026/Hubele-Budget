import type { CashSignalAssumedPaidPlan, CashSignalListedPlan } from "@workspace/api-client-react";
import { card as kitCard, cardHead, Foot } from "@/ui";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { shortDate } from "@/lib/dates";
import { draggingPlanLine, type DraggingPlanRow } from "@/lib/forecastPastDue";
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
        <span className={`font-mono text-label tabular-nums ${row.amount < 0 ? "text-bad" : "text-brand-navy"}`}>
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
}) {
  const hasCarried = carried.length > 0 && !!carriedTo;
  const hasUnpaid = hasCarried || assumedPaid.length > 0 || older.length > 0;
  return (
    <>
      {hasUnpaid && (
        <section className={`${kitCard} scroll-mt-[var(--page-sticky-top,0px)] outline-none`} id={ANCHOR.unpaid} tabIndex={-1} data-testid="card-dragging-plans-summary">
          <div className={cardHead}>
            <h2 className="text-title font-semibold text-brand-navy">Unpaid items</h2>
            {hasCarried && (
              <>
                <span className="chip bad" data-testid="dragging-plans-chip">
                  {carried.length} · carried to {shortDate(carriedTo!)}
                </span>
                <span className="ml-auto font-mono text-label tabular-nums text-bad" data-testid="dragging-plans-total">
                  {formatCurrency(carriedTotal)}
                </span>
              </>
            )}
          </div>
          {hasCarried && (
            <ul data-testid="dragging-plans-list">
              {carried.map((row) => (
                <PlanRow key={`${row.itemId}|${row.originalDate}`} row={row} prefix="dragging-plan" missedWord="Mark missed" h={h} />
              ))}
            </ul>
          )}

          {assumedPaid.length > 0 && (
            <div data-testid="assumed-paid-group">
              <div className={groupHead}>
                <h3 className={groupTitle}>Paid by a bank row</h3>
                <span className="chip info">{assumedPaid.length}</span>
              </div>
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
                          <span className="font-mono text-label tabular-nums text-neutral-700">{formatCurrency(Number(p.planAmount))}</span>
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
            </div>
          )}

          {older.length > 0 && (
            <div id={ANCHOR.older} tabIndex={-1} className="scroll-mt-[var(--page-sticky-top,0px)] outline-none" data-testid="older-unpaid-group">
              <div className={groupHead}>
                <h3 className={groupTitle}>Older than 14 days · off the curve</h3>
                <span className="chip gray">{older.length}</span>
              </div>
              <ul data-testid="older-unpaid-list">
                {older.map((p) => (
                  <PlanRow key={p.planKey} row={listedRow(p)} prefix="older-plan" missedWord="Mark missed" h={h} />
                ))}
              </ul>
            </div>
          )}
          {hasCarried && <Foot>Resolving a row here removes it from the projection for that day.</Foot>}
        </section>
      )}

      {incomeNotArrived.length > 0 && (
        <section className={`${kitCard} scroll-mt-[var(--page-sticky-top,0px)] outline-none`} id={ANCHOR.income} tabIndex={-1} data-testid="card-income-not-arrived">
          <div className={cardHead}>
            <h2 className="text-title font-semibold text-brand-navy">Income not arrived</h2>
            <span className="chip warn">{incomeNotArrived.length} · off the curve</span>
          </div>
          <ul data-testid="income-not-arrived-list">
            {incomeNotArrived.map((p) => (
              <PlanRow key={p.planKey} row={listedRow(p)} prefix="income-plan" missedWord="Didn't arrive" h={h} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
