import { useMemo } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useGetBudgetMonth,
  useGetMe,
  useListPlaidItems,
  type GetPeriodBreakdownParams,
  type PeriodBreakdownRow,
} from "@workspace/api-client-react";
import {
  getGetPeriodBreakdownQueryKey,
  useGetPeriodBreakdown,
  useListAllowancePlans,
} from "@workspace/api-client-react/features";
import { useUrlState, type UrlCodec } from "@/hooks/useUrlState";
import { householdToday } from "@/lib/householdDay";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries } from "@/pages/next/accounts/entries";
import { SpendingWhy } from "@/pages/next/dashboard/SpendingPanel";
import { cn, formatCurrency } from "@/lib/utils";
import { Breakdown } from "./Breakdown";
import { Details } from "./Details";
import { PlanPrompt } from "./PlanPrompt";
import { canGoBack, isIsoDay, monthWords, periodTitle, resolveStart, shiftPeriod, type PeriodView } from "./periodDates";

/**
 * (W5) One week or one month of the allowance: the plan, what counts toward it,
 * what is left or over, the categories that drove it and the purchases behind
 * them. Every figure is `GET /money/period-breakdown`'s; the page adds nothing up.
 *
 * URL state: `?start=` (the period's first day) and `?open=` (expanded groups),
 * so a refresh, a shared link and Back from a register land on the same view.
 */
const startCodec: UrlCodec<string> = { read: (raw) => (isIsoDay(raw) ? raw : null), write: (v) => v || null };
const openCodec: UrlCodec<string[]> = {
  read: (raw) => (raw ? raw.split(",").filter(Boolean) : null),
  write: (v) => (v.length ? v.join(",") : null),
};
const NONE: string[] = [];
const MIN = 60_000;

const CELL = "surface rounded-card px-4 py-3 ring-1 ring-brand-line";
const CELL_LABEL = "text-micro font-semibold uppercase tracking-wide text-neutral-500";
const CELL_VALUE = "mt-1 font-mono text-display font-semibold tabular-nums";

export function PeriodView({ view }: { view: PeriodView }) {
  const today = useMemo(() => householdToday(new Date()), []);
  const [startParam, setStartParam] = useUrlState<string>("start", startCodec, "");
  const [open, setOpen] = useUrlState<string[]>("open", openCodec, NONE);
  const start = resolveStart(view, startParam, today);
  const currentStart = resolveStart(view, "", today);

  const params: GetPeriodBreakdownParams = { period: view, start, rowsPerGroup: 50 };
  const q = useGetPeriodBreakdown(params, {
    query: { queryKey: getGetPeriodBreakdownQueryKey(params), staleTime: MIN },
  });
  const d = q.data;
  const isCurrent = d?.isCurrent ?? start === currentStart;

  const items = useListPlaidItems({ query: { staleTime: MIN } as never });
  const entries = useMemo(() => buildEntries(items.data), [items.data]);
  const entriesKnown = items.data !== undefined;
  const byRow = useMemo(() => new Map(entries.map((e) => [e.rowId, e.plaidAccountId])), [entries]);
  const routeOf = (r: PeriodBreakdownRow) =>
    txnRoute(
      { id: r.id, occurredOn: r.date, plaidAccountId: r.account.id ? byRow.get(r.account.id) ?? null : null, source: null },
      entries,
      { entriesKnown },
    );

  // Only the current period can be given a plan, and only when none is set.
  const needsPrompt = d != null && d.isCurrent && d.plan.status === "not_set";
  const plans = useListAllowancePlans({ query: { staleTime: 5 * MIN, enabled: needsPrompt } as never });
  const me = useGetMe({ query: { staleTime: 30 * MIN } as never });
  const canSet = me.data ? (me.data as { isOwner?: boolean }).isOwner === true : !me.isLoading;

  const budgetMonth = view === "month" ? start : "";
  const budget = useGetBudgetMonth(budgetMonth || start, { query: { enabled: view === "month", staleTime: 5 * MIN } as never });

  const go = (dir: -1 | 1) => {
    const next = shiftPeriod(view, start, dir);
    setOpen(NONE);
    setStartParam(next === currentStart ? "" : next);
  };
  const toggle = (token: string) => setOpen(open.includes(token) ? open.filter((t) => t !== token) : [...open, token]);

  const planWord = view === "week" ? "weekly" : "monthly";
  const over = d?.over != null && Math.round(Number(d.over) * 100) > 0;
  const arrow = "press inline-flex size-9 items-center justify-center rounded-control bg-white text-neutral-700 ring-1 ring-brand-line hover:bg-neutral-50 disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="space-y-4" data-testid={`spending-${view}`}>
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 text-display font-semibold text-brand-navy" data-testid="sp-title">{periodTitle(view, start, isCurrent)}</h1>
          <div className="flex shrink-0 gap-2">
            <button type="button" className={arrow} aria-label={view === "week" ? "Previous week" : "Previous month"} disabled={!canGoBack(view, start)} onClick={() => go(-1)} data-testid="sp-prev">
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button type="button" className={arrow} aria-label={view === "week" ? "Next week" : "Next month"} disabled={start >= currentStart} onClick={() => go(1)} data-testid="sp-next">
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        <p className="text-label text-neutral-600" data-testid="sp-scope">Household · {planWord} plan</p>
      </header>

      {d === undefined ? (
        q.isError ? (
          <div className="surface rounded-card px-4 py-4 text-body text-neutral-700 ring-1 ring-brand-line" role="alert" data-testid="sp-error">
            This {view} did not load.{" "}
            <button type="button" className="underline" onClick={() => void q.refetch()}>Try again</button>
          </div>
        ) : (
          <div className="skeleton h-24 w-full rounded-card" aria-busy="true" data-testid="sp-loading" />
        )
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3" data-testid="sp-summary">
            <div className={CELL}>
              <div className={CELL_LABEL}>Plan</div>
              {d.plan.status === "not_set" ? (
                <div className="mt-1 text-title font-semibold text-neutral-700" data-testid="sp-plan">Plan not set</div>
              ) : (
                <div className={cn(CELL_VALUE, "text-brand-ink")} data-testid="sp-plan">{formatCurrency(d.plan.amount)}</div>
              )}
            </div>
            <div className={CELL}>
              <div className={CELL_LABEL}>Counts toward plan</div>
              <div className={cn(CELL_VALUE, "text-brand-ink")} data-testid="sp-actual">{formatCurrency(d.actual)}</div>
            </div>
            <div className={CELL}>
              {d.remaining == null ? (
                <>
                  <div className={CELL_LABEL}>Left</div>
                  <div className="mt-1 text-title text-neutral-500" data-testid="sp-left">—</div>
                </>
              ) : over ? (
                <>
                  <div className={CELL_LABEL}>Over</div>
                  <div className={cn(CELL_VALUE, "text-bad")} data-testid="sp-left">{formatCurrency(d.over)}</div>
                </>
              ) : (
                <>
                  <div className={CELL_LABEL}>Left</div>
                  <div className={cn(CELL_VALUE, "text-brand-navy")} data-testid="sp-left">{formatCurrency(d.remaining)}</div>
                </>
              )}
            </div>
          </div>

          {d.plan.status === "not_set" && d.isCurrent ? (
            <PlanPrompt view={view} start={d.start} prefills={plans.data?.prefills ?? []} canSet={canSet} />
          ) : null}

          <Breakdown data={d} open={open} onToggle={toggle} routeOf={routeOf} />
          <Details data={d} view={view} />

          {view === "month" ? (
            <section className="surface rounded-card px-4 py-3 ring-1 ring-brand-line" data-testid="sp-household-budget">
              <h2 className="text-title font-semibold text-brand-navy">Household budget</h2>
              <p className="text-micro text-neutral-500">Separate from the monthly allowance · includes debt payments</p>
              {budget.data === undefined ? (
                <p className="mt-2 text-label text-neutral-500">{budget.isError ? "The budget did not load." : "Loading…"}</p>
              ) : (
                <>
                  <dl className="mt-2 space-y-1 text-body">
                    <div className="flex justify-between gap-3"><dt className="text-neutral-700">Planned</dt><dd className="font-mono tabular-nums text-brand-ink" data-testid="sp-hb-planned">{formatCurrency(budget.data.summary.expenses.budget)}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-neutral-700">Actual</dt><dd className="font-mono tabular-nums text-brand-ink" data-testid="sp-hb-actual">{formatCurrency(budget.data.summary.expenses.actual)}</dd></div>
                  </dl>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-label">
                    <Link href={`/budget?month=${start}`} className="font-medium text-brand-navy underline" data-testid="sp-hb-link">Open the budget</Link>
                    {budget.data.spendingReconciliation ? (
                      <SpendingWhy r={budget.data.spendingReconciliation} month={monthWords(start).slice(0, 3)} />
                    ) : null}
                  </div>
                </>
              )}
            </section>
          ) : null}

          {d.plan.status === "not_set" && !d.isCurrent ? (
            <p className="text-micro text-neutral-500">A plan starts this {view}. Earlier {view === "week" ? "weeks" : "months"} stay as they were.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
