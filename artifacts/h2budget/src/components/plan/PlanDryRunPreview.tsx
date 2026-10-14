import type { AllowancePlanDryRun, AllowancePlanDryRunOccurrencesItem } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { startWords } from "@/pages/spending/periodDates";

/**
 * (F4) What a plan would do to the forecast, before it is saved. Display only:
 * every figure is the dry run's (`POST /allowance-plans?dryRun=1`), which
 * writes nothing. Per Saturday the Weekly Spend reserve is shown as the three
 * things that make it: card purchases made + carried from an earlier week +
 * what is left to spend. `paid` (already paid on evidence) appears only when
 * it is not zero, so the parts always add to the reserve to the cent.
 */
const SHOWN = 4;

const isZero = (v: string | null | undefined) => Math.round(Number(v ?? 0) * 100) === 0;

export function reserveLine(o: AllowancePlanDryRunOccurrencesItem): string {
  const a = o.after;
  const name = o.hook === "weekly" ? "Weekly Spend reserve" : "Monthly Spend reserve";
  const parts = [`card purchases ${formatCurrency(a.incurred)}`];
  if (!isZero(a.paid)) parts.push(`already paid ${formatCurrency(a.paid)}`);
  parts.push(`carried ${formatCurrency(a.carried)}`, `left to spend ${formatCurrency(a.allowanceLeft)}`);
  const before = o.before ? formatCurrency(o.before.amount) : "none";
  return `${name} ${before} → ${formatCurrency(a.amount)} = ${parts.join(" + ")}`;
}

function Row({ o }: { o: AllowancePlanDryRunOccurrencesItem }) {
  return (
    <li className="py-1.5" data-testid="dry-occurrence">
      <div className="text-micro font-semibold text-neutral-600">{startWords(o.occurrenceDate)}</div>
      <div className="font-mono text-label tabular-nums text-brand-ink" data-testid="dry-reserve">{reserveLine(o)}</div>
    </li>
  );
}

export function PlanDryRunPreview({ dry }: { dry: AllowancePlanDryRun }) {
  const shown = dry.occurrences.slice(0, SHOWN);
  const rest = dry.occurrences.slice(SHOWN);
  const lp = dry.lowPoint;
  const low = (x: { amount: string | null; date: string | null }) => (x.amount == null ? "—" : `${formatCurrency(x.amount)}${x.date ? ` on ${startWords(x.date)}` : ""}`);
  return (
    <div className="space-y-2" data-testid="plan-dry-run">
      <ul className="divide-y divide-brand-line">{shown.map((o) => <Row key={o.planKey} o={o} />)}</ul>
      {rest.length ? (
        <details data-testid="dry-more">
          <summary className="press cursor-pointer text-label font-semibold text-brand-navy">Show {rest.length} more</summary>
          <ul className="divide-y divide-brand-line">{rest.map((o) => <Row key={o.planKey} o={o} />)}</ul>
        </details>
      ) : null}
      <div className="flex flex-wrap justify-between gap-x-3 text-label" data-testid="dry-low">
        <span className="text-neutral-600">Lowest point</span>
        <span className="font-mono tabular-nums text-brand-ink">{low(lp.before)} → {low(lp.after)}</span>
      </div>
    </div>
  );
}
