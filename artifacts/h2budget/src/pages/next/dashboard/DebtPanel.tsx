import { Link } from "wouter";
import { Panel, StatBlock } from "@/components/next";
import { CssFillMeter } from "@/lib/cssBars";
import { useSpine } from "@/hooks/useSpine";
import { formatCurrency } from "@/lib/utils";
import { useDebtsQ } from "./queries";
import { Gate, LinkRow, money, rise } from "./shared";

function monthName(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  if (!m) return ym;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export default function DebtPanel() {
  const debts = useDebtsQ();
  const spine = useSpine();
  const d = spine.data?.debt;
  const active = (debts.data ?? []).filter((x) => x.status !== "archived");
  const total = active.reduce((n, x) => n + (Number(x.balance) || 0), 0);
  return (
    <Panel title="Debt" span={4} className={rise(5)} data-testid="dash-debt">
      <Gate q={debts} what="Debt" rows={5}>
        {() => (
          <div className="space-y-4">
            <StatBlock label="Total balance" value={active.length ? formatCurrency(total) : "—"} data-testid="dash-debt-total"
              hint={`${active.length} ${active.length === 1 ? "account" : "accounts"}`} />
            <div data-testid="dash-debt-paid">
              <div className="flex items-baseline justify-between">
                <span className="text-label font-medium">Paid off</span>
                <span className="font-mono text-label tabular-nums">{d?.payoffPct == null ? "—" : `${Math.round(d.payoffPct)}%`}</span>
              </div>
              <CssFillMeter value={d?.payoffPct ?? 0} ceiling={100} className="mt-1" />
            </div>
            {d ? (
              <div className="space-y-1 text-label" data-testid="dash-debt-month">
                <p>Paid down {formatCurrency(d.paidDownMtd)} this month, confirmed by the bank.</p>
                <p className="text-neutral-600">New charges this month: <span className="font-mono tabular-nums">{money(d.newChargesMtd)}</span></p>
                <p className="text-neutral-600" data-testid="dash-debt-milestone">
                  Next milestone: {d.nextMilestone ? `${d.nextMilestone.label} · ${monthName(d.nextMilestone.estimatedMonth)}` : "—"}
                </p>
              </div>
            ) : null}
            <LinkRow>
              <Link href="/avalanche" className="text-brand-navy underline">Payoff plan</Link>
              <Link href="/reports/debt" className="text-brand-navy underline">Debt report</Link>
            </LinkRow>
          </div>
        )}
      </Gate>
    </Panel>
  );
}
