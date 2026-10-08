import { useState } from "react";
import { Link } from "wouter";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import { useUpsertBudgetLine, type BudgetLineWithActual } from "@workspace/api-client-react";
import { Button } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { Figure } from "@/kit/Figure";
import { Note, RefreshNote } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonFigure, SkeletonLine } from "@/kit/Skeleton";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { errorWords, firstOfMonth, monthEnd, monthLabel, parseDollars, plainDollars, remainingWords, shiftMonth } from "./format";
import { MoneyInput, PlanFrame, useToast } from "./parts";
import { usePlanCategoriesData, usePlanInvalidate, type CategoriesData } from "./planData";

function Money({ value }: { value: string | number | null | undefined }) {
  const n = toAmount(value);
  if (n == null) return <span className="text-ink-3">—</span>;
  return (
    <data value={centsValue(n)} className="tnum">
      {fmtMoney(n)}
    </data>
  );
}

/**
 * A line's planned amount is yours to edit only when it is an envelope you set
 * by hand. A line that bills or a debt fills is read-only: change the bill or
 * the debt, and the line follows.
 */
export function isEditableLine(line: BudgetLineWithActual): boolean {
  if (line.sourceKind !== "manual") return false;
  if (line.planSource === "bills" || line.planSource === "debts") return false;
  const kind = line.plannedSource?.kind;
  return kind === undefined || kind === "manual";
}

function sourceWords(line: BudgetLineWithActual): string {
  switch (line.plannedSource?.kind) {
    case "bills":
      return "This amount comes from the bills filed under it:";
    case "derived":
      return "This amount is the minimum payment on the linked debt.";
    case "pinned":
      return "This amount was pinned. It stays until you unpin it in the classic app.";
    default:
      return line.sourceKind === "auto_debts"
        ? "This amount comes from your debt plan."
        : line.sourceKind === "auto_bills"
          ? "This amount comes from your bills."
          : "You set this amount.";
  }
}

function LineRow({
  line,
  from,
  to,
  onSave,
  busy,
}: {
  line: BudgetLineWithActual;
  from: string;
  to: string;
  onSave: (line: BudgetLineWithActual, amount: string) => string | null;
  busy: boolean;
}) {
  const [text, setText] = useState(plainDollars(line.plannedAmount));
  const [error, setError] = useState<string | null>(null);
  const planned = toAmount(line.plannedAmount);
  const actual = toAmount(line.actualAmount);
  const posted = toAmount(line.postedAmount);
  const pending = toAmount(line.pendingAmount);
  const left = planned != null && actual != null ? remainingWords(planned, actual) : null;
  const editable = isEditableLine(line);
  const commit = () => {
    if (busy) return;
    if (text.trim() === plainDollars(line.plannedAmount)) return;
    setError(onSave(line, text));
  };
  return (
    <li className="flex flex-col gap-2 border-t border-rule py-3 first:border-t-0" data-testid="plan-line">
      <div className="flex items-start justify-between gap-4">
        <span className="min-w-0 truncate type-body text-ink">{line.categoryName}</span>
        <Link
          href={`/activity?categoryId=${encodeURIComponent(line.categoryId)}&from=${from}&to=${to}`}
          className="shrink-0 type-figure-sm text-ink underline decoration-1 underline-offset-4 hover:text-moss-ink"
          aria-label={`${line.categoryName} activity this month`}
          data-testid="line-actual"
        >
          <Money value={actual} />
        </Link>
      </div>
      <p className="type-caption text-ink-3">
        spent so far
        {pending != null && pending > 0 && posted != null ? (
          <>
            {" "}
            · <Money value={posted} /> posted, <Money value={pending} /> pending
          </>
        ) : null}
        {left && left.kind === "left" && (
          <>
            {" "}
            · <Money value={left.amount} /> left
          </>
        )}
        {left && left.kind === "over" && (
          <>
            {" "}
            · over by <Money value={left.amount} />
          </>
        )}
        {left && left.kind === "even" && " · none left"}
      </p>
      {editable ? (
        <MoneyInput
          label={`Planned for ${line.categoryName}`}
          value={text}
          onChange={(v) => {
            setText(v);
            setError(null);
          }}
          onCommit={commit}
          error={error}
          data-testid="line-planned"
        />
      ) : (
        <p className="type-body text-ink-2" data-testid="line-planned-readonly">
          Planned <Money value={planned} />
        </p>
      )}
      <Disclosure summary="Where this comes from">
        <p>{sourceWords(line)}</p>
        {line.plannedSource?.kind === "bills" && line.plannedSource.bills.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {line.plannedSource.bills.map((b) => (
              <li key={b.id} className="flex items-baseline justify-between gap-4">
                <span>{b.name}</span>
                <Money value={b.amount} />
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
    </li>
  );
}

export default function PlanCategories({ now }: { now?: Date }) {
  const [monthStart, setMonthStart] = useState(() => firstOfMonth(householdToday(now)));
  const data = usePlanCategoriesData(monthStart);
  return <CategoriesView data={data} monthStart={monthStart} onMonth={setMonthStart} now={now} />;
}

/**
 * ⭐ CATEGORIES — the month's plan, line by line. Planned is yours to type
 * where it is an envelope you set; spent so far is the server's posted plus
 * pending, and tapping it opens that category's Activity for the month.
 *
 * The one subtraction here is "left" / "over by" (planned less spent, in whole
 * cents); every other figure is a field of `GET /budget/months/:monthStart`.
 */
export function CategoriesView({
  data,
  monthStart,
  onMonth,
  now,
}: {
  data: CategoriesData;
  monthStart: string;
  onMonth: (m: string) => void;
  now?: Date;
}) {
  const { month } = data;
  const upsert = useUpsertBudgetLine();
  const invalidate = usePlanInvalidate();
  const { say, node: toast } = useToast();
  const m = month.data && month.data.monthStart.startsWith(monthStart.slice(0, 7)) ? month.data : undefined;
  const to = monthEnd(monthStart);

  const save = (line: BudgetLineWithActual, raw: string): string | null => {
    const amount = parseDollars(raw);
    if (!amount) return "Enter a dollar amount, like 250. Use 0 for none.";
    upsert.mutate(
      { data: { monthStart, categoryId: line.categoryId, plannedAmount: amount } },
      {
        onSuccess: () => {
          invalidate();
          say(`${line.categoryName} planned at ${fmtMoney(Number(amount))}.`);
        },
        onError: (e) => say(errorWords(e), "error"),
      },
    );
    return null;
  };

  const picker = (
    <div className="mb-6 flex items-center justify-between gap-3" data-testid="month-picker">
      <Button variant="quiet" size="sm" onClick={() => onMonth(shiftMonth(monthStart, -1))} aria-label="Previous month">
        Previous
      </Button>
      <h2 className="type-section text-ink" aria-live="polite" data-testid="month-label">
        {monthLabel(monthStart)}
      </h2>
      <Button variant="quiet" size="sm" onClick={() => onMonth(shiftMonth(monthStart, 1))} aria-label="Next month">
        Next
      </Button>
    </div>
  );

  if (!m && month.state === "cold") {
    return (
      <PlanFrame current="categories">
        {picker}
        <div className="flex flex-col gap-3" data-testid="plan-skeleton" aria-busy="true">
          <SkeletonFigure size="md" />
          <SkeletonLine className="w-64" />
          <SkeletonLine className="w-56" />
        </div>
      </PlanFrame>
    );
  }
  if (!m) {
    return (
      <PlanFrame current="categories">
        {picker}
        <Note kind="error" onRetry={month.refetch} retrying={month.isFetching}>
          Couldn't load this month's plan.
        </Note>
      </PlanFrame>
    );
  }

  const groups = m.groups.filter((g) => g.lines.length > 0);
  const expenses = m.summary.expenses;
  return (
    <PlanFrame current="categories">
      {picker}
      {month.state === "refresh-failed" && (
        <div className="mb-6">
          <RefreshNote state="refresh-failed" updatedAt={null} onRetry={month.refetch} retrying={month.isFetching} now={now} />
        </div>
      )}
      <div className="pb-8">
        <Figure
          size="md"
          label="Planned spending this month"
          amount={toAmount(expenses.budget)}
          state={month.state}
          sub={
            <>
              <Money value={expenses.actual} /> spent so far
            </>
          }
          data-testid="figure-month"
        />
      </div>
      {groups.length === 0 ? (
        <Note kind="empty">Nothing is planned for {monthLabel(monthStart)} yet.</Note>
      ) : (
        groups.map((g) => (
          <Section key={g.groupName} label={g.groupName} data-testid="group">
            <p className="mb-2 type-caption text-ink-3">
              <Money value={g.plannedTotal} /> planned · <Money value={g.actualTotal} /> spent
            </p>
            <ul className="flex flex-col">
              {g.lines.map((l) => (
                <LineRow key={l.categoryId} line={l} from={monthStart} to={to} onSave={save} busy={upsert.isPending} />
              ))}
            </ul>
          </Section>
        ))
      )}
      {toast}
    </PlanFrame>
  );
}
