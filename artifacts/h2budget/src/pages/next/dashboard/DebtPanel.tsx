import { Link } from "wouter";
import { Panel } from "@/components/next";
import { CssFillMeter } from "@/lib/cssBars";
import { useSpine } from "@/hooks/useSpine";
import { cn } from "@/lib/utils";
import { BELOW_FOLD } from "./belowFoldSizes";
import { Gate, LABEL, LINK, money, rise } from "./shared";

export function monthName(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  if (!m) return ym;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/**
 * "Are we making progress on debt?" Every figure is the spine's own
 * (`computeDebtHeadline`): % paid as a meter that sweeps once, what the bank
 * confirms was paid down this month, new charges on the debts' own accounts
 * this month, and the next milestone the plan passes. The amount left is in
 * the summary row's debt tile (same shared total as the Avalanche page).
 */
export default function DebtPanel() {
  const spine = useSpine();
  const d = spine.data?.debt;
  const q = { data: spine.data, isError: spine.state === "failed", refetch: spine.refetch };
  return (
    <Panel title="Debt progress" span={6} variant="static"
      className={cn(rise(BELOW_FOLD.debt.rise), BELOW_FOLD.debt.minH)} data-testid="dash-debt">
      <Gate q={q} what="Debt progress" rows={5}>
        {() => (
          <div className="space-y-4">
            <div data-testid="dash-debt-paid">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-label font-semibold text-brand-ink">Paid off so far</span>
                <span className="font-mono text-label font-semibold tabular-nums text-brand-navy">
                  {d?.payoffPct == null ? "—" : `${Math.round(d.payoffPct)}%`}
                </span>
              </div>
              <CssFillMeter value={d?.payoffPct ?? 0} ceiling={100} className="mt-1.5" />
            </div>
            {d ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3" data-testid="dash-debt-month">
                <div>
                  <dt className={LABEL}>Paid down this month</dt>
                  <dd className="font-mono text-body tabular-nums text-brand-ink" data-testid="dash-debt-paid-down">{money(d.paidDownMtd)}</dd>
                  <dd className="text-micro text-neutral-500">confirmed by the bank</dd>
                </div>
                <div>
                  <dt className={LABEL}>New charges this month</dt>
                  <dd className="font-mono text-body tabular-nums text-brand-ink" data-testid="dash-debt-new">{money(d.newChargesMtd)}</dd>
                  <dd className="text-micro text-neutral-500">on the debts' own accounts</dd>
                </div>
                <div className="col-span-2" data-testid="dash-debt-milestone">
                  <dt className={LABEL}>Next milestone</dt>
                  <dd className="text-body text-brand-ink">
                    {d.nextMilestone ? `${d.nextMilestone.label} · ${monthName(d.nextMilestone.estimatedMonth)}` : "None on the plan yet"}
                  </dd>
                </div>
              </dl>
            ) : null}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-label">
              <Link href="/avalanche" className={LINK}>Payoff plan</Link>
              <Link href="/reports/debt" className={LINK}>Debt report</Link>
            </div>
          </div>
        )}
      </Gate>
    </Panel>
  );
}
