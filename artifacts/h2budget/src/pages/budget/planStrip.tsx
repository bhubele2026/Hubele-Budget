import { StackBar } from "@/components/viz";
import { CHART } from "@/lib/chartTokens";
import { card, cardHead, fieldLabel, Foot, Help } from "@/ui";
import { formatCurrency } from "@/lib/utils";
import type { BudgetMonthDetail } from "@workspace/api-client-react";

const n = (v: string | number | null | undefined): number => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
};

/**
 * ⭐ THE PICTURE THAT ANSWERS THE BRIEF — "animated so everyone knows what
 * they are looking at".
 *
 * Two segments, because the plan has two sources. Everything else on the page
 * is arranged under them, and the two figures beside the bar are the ones that
 * are deliberately NOT in it:
 *
 *   - the allowance, whose money is already inside Bills as the recurring
 *     items that fund it, and
 *   - the hand-planned envelopes, which are not in the plan at all yet.
 *
 * Stating those two beside the bar rather than inside it is the whole fix for
 * "there is a 1800 weekly, but also weekly in dining and groceries": the page
 * now shows the overlap instead of quietly adding it up.
 */
export function PlanStrip({
  plan,
  allowanceActual,
  allowancePlanned,
}: {
  plan: BudgetMonthDetail["planBySource"];
  allowanceActual: number;
  allowancePlanned: number;
}) {
  const bills = n(plan.bills.planned);
  const debts = n(plan.debts.planned);
  const unbacked = n(plan.unbacked.planned);
  const total = bills + debts;

  const segments = [
    { label: "Bills", value: bills, color: CHART.navy },
    { label: "Debt payments", value: debts, color: CHART.orange },
  ].filter((s) => s.value > 0);

  return (
    <section className={card} data-testid="budget-plan-strip">
      <div className={cardHead}>
        <span className={`${fieldLabel} flex-1 truncate`}>
          Where the plan comes from
        </span>
        <Help>
          The plan is bills plus debt payments, and nothing else. The allowance
          and any hand-planned envelope are listed beside it rather than added
          to it, because their money is either already inside a bill or not in
          the plan yet.
        </Help>
        <span
          className="font-mono text-label font-semibold tabular-nums text-brand-navy"
          data-testid="plan-strip-total"
        >
          {formatCurrency(total)}
        </span>
      </div>

      <div className="px-4 pb-1 pt-3">
        {segments.length > 0 ? (
          <StackBar segments={segments} height={12} money legendMax={2} />
        ) : (
          <p className="py-2 text-body text-neutral-400">
            No bills or debt payments in this month yet.
          </p>
        )}
      </div>

      {/* ── The two that are NOT in the bar ──────────────────────────────── */}
      <div className="grid grid-cols-1 gap-px border-t border-brand-line bg-brand-line sm:grid-cols-2">
        <Aside
          testId="plan-strip-allowance"
          label="Allowance"
          value={formatCurrency(allowanceActual)}
          sub={
            allowancePlanned > 0
              ? `of ${formatCurrency(allowancePlanned)} · already inside Bills`
              : "already inside Bills"
          }
        />
        <Aside
          testId="plan-strip-unbacked"
          label="Not from a bill"
          value={formatCurrency(unbacked)}
          sub={
            plan.unbacked.lineCount === 0
              ? "nothing planned by hand"
              : `${plan.unbacked.lineCount} envelope${
                  plan.unbacked.lineCount === 1 ? "" : "s"
                } · not in the plan`
          }
        />
      </div>

      <Foot>
        Bills and debt payments are the plan. The allowance is tracked, not
        planned again — it is spent out of the Weekly and Monthly Spend bills
        already counted above.
      </Foot>
    </section>
  );
}

function Aside({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  testId: string;
}) {
  return (
    <div className="bg-platinum-1 px-4 py-2.5" data-testid={testId}>
      <div className={fieldLabel}>{label}</div>
      <div className="mt-0.5 font-mono text-label font-semibold tabular-nums text-neutral-700">
        {value}
      </div>
      <div className="mt-0.5 text-micro text-neutral-400">{sub}</div>
    </div>
  );
}
