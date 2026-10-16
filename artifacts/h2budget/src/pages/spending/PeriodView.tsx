import { useEffect, useMemo } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useGetBudgetMonth,
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
import { useOwner } from "@/hooks/useOwner";
import { scoped } from "@/lib/queryState";
import { planStatusWords } from "@/lib/planWords";
import { QueryRefreshBanner } from "@/components/query-refresh-banner";
import { householdToday } from "@/lib/householdDay";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries } from "@/pages/next/accounts/entries";
import { SpendingWhy } from "@/pages/next/dashboard/SpendingPanel";
import { cn, formatCurrency } from "@/lib/utils";
import { figLabel } from "@/ui";
import { periodParams, PERIOD_MIN } from "./periodParams";
import { Breakdown, provisionalLine } from "./Breakdown";
import { weekStatus, withinOfRemaining } from "@/lib/weekFigures";
import { Details } from "./Details";
import { PlanPrompt } from "./PlanPrompt";
import { AmexWeekLine } from "./AmexWeekLine";
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
const accountCodec: UrlCodec<string> = { read: (raw) => raw || null, write: (v) => v || null };
/** (C5) `?plan=1`: opened from the Forecast's "Set a weekly plan →" — the plan dialog opens on its choices. */
const planCodec: UrlCodec<boolean> = { read: (raw) => (raw === "1" ? true : null), write: (v) => (v ? "1" : null) };
const NONE: string[] = [];
const MIN = PERIOD_MIN;

const CELL = "surface rounded-card px-4 py-3 ring-1 ring-brand-line";
const CELL_LABEL = figLabel;
const CELL_VALUE = "mt-1 whitespace-nowrap font-mono text-kpi font-semibold tabular-nums";

export function PeriodView({ view }: { view: PeriodView }) {
  const today = useMemo(() => householdToday(new Date()), []);
  const [startParam, setStartParam] = useUrlState<string>("start", startCodec, "");
  const [open, setOpen] = useUrlState<string[]>("open", openCodec, NONE);
  // (T4) `?account=` (a card's "Why over?"): that account's contribution; the plan stays the household's.
  const [account, setAccount] = useUrlState<string>("account", accountCodec, "");
  const [planParam, setPlanParam] = useUrlState<boolean>("plan", planCodec, false);
  const start = resolveStart(view, startParam, today);
  const currentStart = resolveStart(view, "", today);

  const params: GetPeriodBreakdownParams = periodParams(view, start, account);
  const q = useGetPeriodBreakdown(params, {
    query: { queryKey: getGetPeriodBreakdownQueryKey(params), staleTime: MIN },
  });
  // (Q4) The breakdown on screen is THIS period's: the old period's (kept while this one loads) is not.
  const own = scoped(q, (r) => r.start === start && r.period === view && (r.scope.id ?? "") === account);
  const d = own.data;
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
  const canSet = useOwner();
  // (C5) A plan already set (or another period on screen): nothing to open; the param goes.
  const promptShown = d != null && d.plan.status === "not_set" && d.isCurrent;
  useEffect(() => {
    if (planParam && d != null && !promptShown) setPlanParam(false);
  }, [planParam, d, promptShown, setPlanParam]);

  const budgetMonth = view === "month" ? start : "";
  const budgetQ = useGetBudgetMonth(budgetMonth || start, { query: { enabled: view === "month", staleTime: 5 * MIN } as never });
  // (Q4) Another month's budget is not this month's.
  const budget = { ...budgetQ, data: scoped(budgetQ, (b) => b.monthStart === start).data };

  const go = (dir: -1 | 1) => {
    const next = shiftPeriod(view, start, dir);
    setOpen(NONE);
    setStartParam(next === currentStart ? "" : next);
  };
  const toggle = (token: string) => setOpen(open.includes(token) ? open.filter((t) => t !== token) : [...open, token]);

  const planWord = view === "week" ? "weekly" : "monthly";
  const over = d?.over != null && Math.round(Number(d.over) * 100) > 0;
  // (Round 3) The same status rule as the landing's tile: over on the known figure reads Over (rust) even when the period is not final.
  const bad = weekStatus(withinOfRemaining(d?.remaining), d?.provisional ?? false).tone === "bad";
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
        <p className="text-label text-neutral-600" data-testid="sp-scope">
          {account && d?.scope.kind === "account" ? (
            <>
              {[d.scope.institution, d.scope.name].filter(Boolean).join(" ")}{d.scope.mask ? ` ••${d.scope.mask.slice(-4)}` : ""} · household {planWord} plan{" · "}
              <button type="button" className="font-medium text-brand-navy underline" onClick={() => setAccount("")} data-testid="sp-scope-household">Household</button>
            </>
          ) : (
            <>Household · {planWord} plan</>
          )}
        </p>
      </header>

      <QueryRefreshBanner q={q} data-testid="sp-error" />
      {d === undefined ? (
        q.isError ? null : (
          <div className="skeleton h-24 w-full rounded-card" aria-busy="true" data-testid="sp-loading" />
        )
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3" data-testid="sp-summary">
            <div className={CELL}>
              <div className={CELL_LABEL}>Plan</div>
              {d.plan.status === "not_set" ? (
                <div className="mt-1 text-title font-semibold text-neutral-700" data-testid="sp-plan">{planStatusWords(d.plan)}</div>
              ) : (
                <div className={cn(CELL_VALUE, "text-brand-ink")} data-testid="sp-plan">{formatCurrency(d.plan.amount)}</div>
              )}
            </div>
            <div className={CELL}>
              <div className={CELL_LABEL}>Counts toward plan</div>
              <div className={cn(CELL_VALUE, "text-brand-ink")} data-testid="sp-actual">{formatCurrency(d.known)}</div>
              {d.provisional ? <span className="chip warn mt-1.5" data-testid="sp-provisional">Not final</span> : null}
            </div>
            <div className={CELL}>
              {d.remaining == null ? (
                <>
                  <div className={CELL_LABEL}>Left</div>
                  <div className="mt-1 text-title text-neutral-600" data-testid="sp-left">—</div>
                </>
              ) : over ? (
                <>
                  <div className={CELL_LABEL}>{d.provisional ? "Over so far" : "Over"}</div>
                  <div className={cn(CELL_VALUE, bad ? "text-bad-ink" : "text-brand-navy")} data-testid="sp-left" data-tone={bad ? "bad" : "neutral"}>{formatCurrency(d.over)}</div>
                </>
              ) : (
                <>
                  <div className={CELL_LABEL}>{d.provisional ? "Left so far" : "Left"}</div>
                  <div className={cn(CELL_VALUE, "text-brand-navy")} data-testid="sp-left">{formatCurrency(d.remaining)}</div>
                </>
              )}
            </div>
          </div>
          {provisionalLine(d) ? (
            <p className="text-label text-neutral-700" data-testid="sp-provisional-line">{provisionalLine(d)}</p>
          ) : null}

          {view === "week" && !account ? (
            <AmexWeekLine
              start={d.start}
              end={d.end}
              onOpen={() => {
                const el = document.getElementById("sp-breakdown");
                if (el && "scrollIntoView" in el) el.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
              }}
            />
          ) : null}

          {d.plan.status === "not_set" && d.isCurrent ? (
            <PlanPrompt
              view={view}
              start={d.start}
              prefills={plans.data?.prefills ?? []}
              canSet={canSet}
              openOnMount={planParam}
              onDismiss={() => setPlanParam(false)}
            />
          ) : null}

          <Breakdown data={d} open={open} onToggle={toggle} routeOf={routeOf} />
          <Details data={d} view={view} openOnMount={open.includes("details")} />

          {view === "month" ? (
            <section className="surface rounded-card px-4 py-3 ring-1 ring-brand-line" data-testid="sp-household-budget">
              <h2 className="text-title font-semibold text-brand-navy">Household budget</h2>
              <p className="text-micro text-neutral-600">Separate from the monthly allowance · includes debt payments</p>
              {budget.data === undefined ? (
                <p className="mt-2 text-label text-neutral-600">{budget.isError ? "The budget did not load." : "Loading…"}</p>
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
            <p className="text-micro text-neutral-600">A plan starts this {view}. Earlier {view === "week" ? "weeks" : "months"} stay as they were.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
