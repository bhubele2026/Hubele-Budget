import { Link } from "wouter";
import type { AmexSummary, AmexSummaryAttentionGroup, AmexSummaryRow } from "@workspace/api-client-react";
import { Panel } from "@/components/next/Panel";
import { moneyFace } from "@/components/data-state";
import { cn } from "@/lib/utils";
import {
  FIGURE_WORDS,
  amexPlanLine,
  householdLine,
  type AmexFigure,
} from "@/lib/amexSummaryView";
import type { RangeMode } from "@/lib/timeRange";

/**
 * ⭐ (W4) THE AMEX PAGE, SUMMARY FIRST. What is owed, what was bought, what was
 * paid, what came back — each its own figure, each one opens its rows in the
 * activity below — then the plan line and what to look at. Every amount is the
 * server's (`GET /amex/summary`); this file formats and links, it adds nothing.
 * An unknown amount is "—", never $0.
 */

const FIG_BASE =
  "press flex min-w-0 flex-col gap-0.5 rounded-card p-3 text-left ring-1 ring-brand-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";

function countWord(n: number) {
  return n === 1 ? "1 row" : `${n} rows`;
}

function Figure({
  testId, label, amount, sub, active, onClick,
}: {
  testId: string;
  label: string;
  amount: string | null;
  sub?: string | null;
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="text-micro font-semibold uppercase tracking-wide text-neutral-500">{label}</span>
      <span className="font-mono text-title font-semibold leading-tight tabular-nums text-brand-navy">{moneyFace(amount)}</span>
      {sub ? <span className="text-micro text-neutral-500">{sub}</span> : null}
    </>
  );
  if (!onClick) {
    return <div className={cn(FIG_BASE, "bg-platinum-1")} data-testid={testId}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(FIG_BASE, "hover:bg-platinum-1", active && "bg-brand-tint ring-2 ring-brand-navy/40")}
    >
      {body}
    </button>
  );
}

export function AmexSummaryPanel({
  summary, failed, periodLabel, mode, isThisWeek, figure, onFigure,
}: {
  summary: AmexSummary | undefined;
  failed: boolean;
  periodLabel: string;
  mode: RangeMode;
  isThisWeek: boolean;
  figure: AmexFigure | null;
  onFigure: (f: AmexFigure | null) => void;
}) {
  const toggle = (f: AmexFigure) => onFigure(figure === f ? null : f);
  const plan = summary ? amexPlanLine(summary.planLink) : null;
  return (
    <Panel title="Summary" sub={periodLabel} span={12} accent="amex" variant="static" data-testid="amex-summary">
      {failed && !summary ? (
        <p className="text-body text-neutral-600" role="alert" data-testid="amex-summary-error">The summary did not load.</p>
      ) : !summary ? (
        <div className="h-24 animate-pulse rounded-card bg-platinum-2" data-testid="amex-summary-loading" aria-busy="true" />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Figure
              testId="amex-fig-owed"
              label="Owed"
              amount={summary.owed.current}
              sub={summary.owed.statement != null ? `Statement ${moneyFace(summary.owed.statement)}` : summary.owed.current == null ? "Not known yet" : null}
            />
            <Figure
              testId="amex-fig-purchases"
              label="Purchases"
              amount={summary.purchases.amount}
              sub={countWord(summary.purchases.count)}
              active={figure === "purchases"}
              onClick={() => toggle("purchases")}
            />
            <Figure
              testId="amex-fig-payments"
              label="Payments"
              amount={summary.payments.amount}
              sub={countWord(summary.payments.count)}
              active={figure === "payments"}
              onClick={() => toggle("payments")}
            />
            <Figure
              testId="amex-fig-credits"
              label="Credits & refunds"
              amount={summary.refunds.amount}
              sub={
                summary.otherCredits.count > 0
                  ? `${countWord(summary.refunds.count)} · other credits ${moneyFace(summary.otherCredits.amount)}`
                  : countWord(summary.refunds.count)
              }
              active={figure === "credits"}
              onClick={() => toggle("credits")}
            />
          </div>
          <div className="space-y-1 text-body text-brand-ink" data-testid="amex-plan-lines">
            {plan ? (
              <p data-testid="amex-plan-line">
                {plan.label} <span className="font-mono font-semibold tabular-nums">{moneyFace(plan.amount)}</span>
                {" · "}
                <Link href={plan.to} className="font-semibold text-brand-navy underline" data-testid="amex-plan-link">{plan.linkText}</Link>
              </p>
            ) : null}
            <p data-testid="amex-household-line">
              {householdLine(summary.householdContribution, mode, isThisWeek)}
              {" · "}
              <Link href={summary.householdContribution.link} className="font-semibold text-brand-navy underline" data-testid="amex-household-link">Spending</Link>
            </p>
          </div>
          {summary.limitations.some((l) => l.startsWith("tracking_start:")) ? (
            <p className="text-micro text-neutral-500" data-testid="amex-summary-limit">
              Starts {summary.limitations.find((l) => l.startsWith("tracking_start:"))!.slice("tracking_start:".length)}, when H2 began tracking.
            </p>
          ) : null}
          {figure ? (
            <p className="text-micro text-neutral-600" data-testid="amex-figure-note">
              Showing {FIGURE_WORDS[figure].toLowerCase()} in the activity below.{" "}
              <button type="button" className="font-semibold text-brand-navy underline" onClick={() => onFigure(null)}>Show all</button>
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

const GROUPS: Array<{ key: "unplanned" | "unfiled" | "uncategorized"; title: string }> = [
  { key: "unplanned", title: "Unplanned" },
  { key: "unfiled", title: "Not filed yet" },
  { key: "uncategorized", title: "No category" },
];

function rowDay(d: string) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

function GroupList({
  title, group, showCard, onOpenRow,
}: {
  title: string;
  group: AmexSummaryAttentionGroup;
  showCard: boolean;
  onOpenRow: (row: AmexSummaryRow) => void;
}) {
  return (
    <section data-testid={`amex-attn-${title}`} className="min-w-0">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-label font-semibold text-brand-navy">
        {title}
        <span className="font-mono text-micro font-normal tabular-nums text-neutral-600">
          {group.count} · {moneyFace(group.amount)}
        </span>
      </h3>
      <ul className="m-0 mt-1 list-none divide-y divide-brand-line/70 p-0">
        {group.rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onOpenRow(r)}
              data-testid={`amex-attn-row-${r.id}`}
              className="press flex w-full min-w-0 items-baseline gap-3 py-2 text-left hover:bg-platinum-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
            >
              <span className="w-12 shrink-0 text-micro text-neutral-500">{rowDay(r.date)}</span>
              <span className="min-w-0 flex-1 text-body text-brand-ink [overflow-wrap:anywhere]">
                {r.displayName}
                {r.pending ? <span className="ml-1 text-micro text-neutral-500">pending</span> : null}
                {showCard ? <span className="block text-micro text-neutral-500">{r.card.name}{r.card.mask ? ` ••${r.card.mask}` : ""}</span> : null}
              </span>
              <span className="shrink-0 font-mono text-body font-semibold tabular-nums text-brand-navy">{moneyFace(r.amount)}</span>
            </button>
          </li>
        ))}
      </ul>
      {group.truncated ? (
        <p className="mt-1 text-micro text-neutral-500">Showing the largest {group.rows.length} of {group.count}.</p>
      ) : null}
    </section>
  );
}

export function AmexNeedsAttention({
  summary, showCard, onOpenRow,
}: {
  summary: AmexSummary | undefined;
  showCard: boolean;
  onOpenRow: (row: AmexSummaryRow) => void;
}) {
  if (!summary) return null;
  const na = summary.needsAttention;
  const shown = GROUPS.filter((g) => na[g.key].count > 0);
  return (
    <Panel title="Needs attention" span={12} accent="amex" variant="static" data-testid="amex-needs-attention">
      {shown.length === 0 ? (
        <p className="text-body text-neutral-600" data-testid="amex-attn-none">Nothing to sort out in this period.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {shown.map((g) => (
            <GroupList key={g.key} title={g.title} group={na[g.key]} showCard={showCard} onOpenRow={onOpenRow} />
          ))}
        </div>
      )}
    </Panel>
  );
}
