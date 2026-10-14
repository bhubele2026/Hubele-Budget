import { Link } from "wouter";
import type { PeriodBreakdown, PeriodBreakdownCategory, PeriodBreakdownGroup, PeriodBreakdownRow } from "@workspace/api-client-react";
import { CssFillMeter } from "@/lib/cssBars";
import { shortDate } from "@/components/next/shortDate";
import { cn, formatCurrency } from "@/lib/utils";
import type { TxnRoute } from "@/lib/accountRoute";

/**
 * (W5) The categories behind a period's figure and the transactions behind each.
 * Display only: every amount, share, "usual" and reason is the server's
 * (`GET /money/period-breakdown`); the only comparisons here decide whether a
 * chip is drawn. Each row opens its register through `routeOf` (`txnRoute`).
 */
export const UNFILED_TOKEN = "unfiled";
export const NO_CATEGORY_TOKEN = "none";

export const categoryToken = (c: PeriodBreakdownCategory): string => c.categoryId ?? NO_CATEGORY_TOKEN;

const cents = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 100);

/** Largest first, ties by name: the order the page lists them in. */
export function sortedCategories(cats: readonly PeriodBreakdownCategory[]): PeriodBreakdownCategory[] {
  return [...cats].sort((a, b) => cents(b.amount) - cents(a.amount) || (a.name ?? "").localeCompare(b.name ?? ""));
}

function reasonWords(r: PeriodBreakdownRow): string {
  const parts: string[] = [];
  if (r.reason.coverage === "refund") parts.push("Refund");
  else if (r.reason.rule === "weekly_flag") parts.push("Marked weekly");
  else if (r.reason.rule === "monthly_flag") parts.push("Marked monthly");
  else if (r.reason.rule === "unfiled") parts.push("Not filed yet");
  if (r.splitPart) parts.push(`Part ${r.splitPart.index + 1} of ${r.splitPart.count} of ${formatCurrency(r.splitPart.parentAmount)}`);
  return parts.join(" · ");
}

function accountWords(a: PeriodBreakdownRow["account"]): string {
  const name = a.name ?? a.institution;
  if (!name) return "No linked account";
  return a.mask ? `${name} ••${a.mask}` : name;
}

function RowList({ rows, count, truncated, routeOf }: {
  rows: readonly PeriodBreakdownRow[];
  count: number;
  truncated: boolean;
  routeOf: (r: PeriodBreakdownRow) => TxnRoute;
}) {
  return (
    <div className="border-t border-brand-line bg-brand-tint/40" data-testid="sp-rows">
      <ul className="divide-y divide-brand-line">
        {rows.map((r, i) => {
          const route = routeOf(r);
          const merchant = <span className="min-w-0 truncate font-medium text-brand-ink">{r.displayName}</span>;
          return (
            <li key={`${r.id}-${i}`} className="px-4 py-2" data-testid="sp-row">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2 text-body">
                  <span className="shrink-0 text-micro text-neutral-500">{shortDate(r.date)}</span>
                  {route.href ? (
                    <Link href={route.href} className="min-w-0 truncate hover:underline" data-testid="sp-row-link">{merchant}</Link>
                  ) : (
                    <span className="min-w-0 truncate" title={route.note ?? undefined}>{merchant}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-body tabular-nums text-brand-ink" data-testid="sp-row-amount">{formatCurrency(r.amount)}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-neutral-500">
                <span className="chip gray" data-testid="sp-row-account">{accountWords(r.account)}</span>
                {r.pending ? <span className="chip warn">Pending</span> : null}
                <span>{reasonWords(r)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {truncated ? (
        <p className="px-4 py-2 text-micro text-neutral-500" data-testid="sp-truncated">
          Showing the largest {rows.length} of {count}.
        </p>
      ) : null}
    </div>
  );
}

function GroupHead({ id, open, onToggle, title, amount, sub, bar, chips }: {
  id: string;
  open: boolean;
  onToggle: () => void;
  title: string;
  amount: string;
  sub?: string;
  bar?: React.ReactNode;
  chips?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={`sp-${id}`}
      onClick={onToggle}
      className="press block w-full px-4 py-3 text-left hover:bg-brand-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy"
      data-testid={`sp-group-${id}`}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-body font-semibold text-brand-ink">{title}</span>
        <span className="shrink-0 font-mono text-body font-semibold tabular-nums text-brand-ink" data-testid={`sp-group-amount-${id}`}>{amount}</span>
      </span>
      {sub ? <span className="mt-0.5 block text-micro text-neutral-500">{sub}</span> : null}
      {bar}
      {chips ? <span className="mt-1 flex flex-wrap items-center gap-2 text-micro text-neutral-500">{chips}</span> : null}
    </button>
  );
}

export function Breakdown({ data, open, onToggle, routeOf }: {
  data: PeriodBreakdown;
  open: readonly string[];
  onToggle: (token: string) => void;
  routeOf: (r: PeriodBreakdownRow) => TxnRoute;
}) {
  const cats = sortedCategories(data.categories);
  const actual = Number(data.actual);
  const over = data.over != null && cents(data.over) > 0;
  const unfiled: PeriodBreakdownGroup = data.needsClassification;
  const showUnfiled = unfiled.count > 0 || cents(unfiled.amount) !== 0;
  return (
    <section className="surface rounded-card ring-1 ring-brand-line" data-testid="sp-breakdown">
      <h2 className="border-b border-brand-line px-4 py-2.5 text-title font-semibold text-brand-navy">
        {over ? "Why over?" : "Where it went"}
      </h2>
      {cats.length === 0 && !showUnfiled ? (
        <p className="px-4 py-4 text-body text-neutral-600" data-testid="sp-empty">Nothing counted against this plan.</p>
      ) : null}
      <ul className="divide-y divide-brand-line">
        {cats.map((c) => {
          const token = categoryToken(c);
          const isOpen = open.includes(token);
          const amount = Number(c.amount);
          return (
            <li key={token}>
              <GroupHead
                id={token}
                open={isOpen}
                onToggle={() => onToggle(token)}
                title={c.name ?? "No category"}
                amount={formatCurrency(c.amount)}
                sub={`${c.count} ${c.count === 1 ? "purchase" : "purchases"}`}
                bar={<CssFillMeter className="mt-1.5" value={Math.max(0, amount)} ceiling={Math.max(actual, amount, 0)} />}
                chips={
                  <>
                    {c.usual != null ? <span data-testid={`sp-usual-${token}`}>usual {formatCurrency(c.usual)}</span> : null}
                    {c.aboveUsual != null && cents(c.aboveUsual) > 0 ? (
                      <span className="chip bad" data-testid={`sp-above-${token}`}>above usual {formatCurrency(c.aboveUsual)}</span>
                    ) : null}
                  </>
                }
              />
              {isOpen ? (
                <div id={`sp-${token}`}>
                  <RowList rows={c.rows} count={c.count} truncated={c.truncated} routeOf={routeOf} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {showUnfiled ? (
        <div className={cn("border-t border-brand-line")} data-testid="sp-unfiled">
          <GroupHead
            id={UNFILED_TOKEN}
            open={open.includes(UNFILED_TOKEN)}
            onToggle={() => onToggle(UNFILED_TOKEN)}
            title="Not filed yet"
            amount={formatCurrency(unfiled.amount)}
            sub={unfiled.countsAgainstPlan ? "Counts toward the weekly plan until filed" : "Not counted against this plan"}
          />
          {open.includes(UNFILED_TOKEN) ? (
            <div id={`sp-${UNFILED_TOKEN}`}>
              <RowList rows={unfiled.rows} count={unfiled.count} truncated={unfiled.truncated} routeOf={routeOf} />
            </div>
          ) : null}
          <div className="px-4 pb-3">
            {/* More › Categories: the filing queue. */}
            <Link href="/review/categories" className="text-label font-medium text-brand-navy underline" data-testid="sp-file-link">
              File them in Categories
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
