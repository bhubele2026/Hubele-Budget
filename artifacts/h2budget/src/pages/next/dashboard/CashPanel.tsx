import { Panel, StatBlock } from "@/components/next";
import { BankBalanceWhy } from "@/components/bank-balance-why";
import { FreshnessLine } from "@/components/data-state";
import { useSpine } from "@/hooks/useSpine";
import { formatCurrency } from "@/lib/utils";
import { dayLabel, Gate, LinkRow, money, rise } from "./shared";
import { Link } from "wouter";

export default function CashPanel() {
  const spine = useSpine();
  const s = spine.data;
  const q = { data: s, isError: spine.state === "failed", refetch: spine.refetch };
  return (
    <Panel title="Cash position" span={4} className={rise(1)} data-testid="dash-cash">
      <Gate q={q} what="Cash position" rows={5}>
        {() => {
          const f = s!.forecast;
          const p = s!.position;
          const noForecast = f.status === "no_data" || f.status === "not_yet";
          const low = noForecast ? null : Number(f.lowPoint);
          const buf = Number(f.cashBuffer);
          const under = low != null && Number.isFinite(buf) && low < buf ? buf - low : null;
          const caption =
            p.horizonKind === "payday"
              ? `Until payday${p.paydayDate ? ` · ${dayLabel(p.paydayDate)}` : ""}`
              : "This week's limit";
          return (
            <div className="space-y-4">
              <div>
                <StatBlock label="Bank today" value={money(s!.bank.balance)} data-testid="dash-bank" />
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-micro text-neutral-500" data-testid="dash-freshness">
                  <FreshnessLine bank={s!.bank} />
                  <BankBalanceWhy />
                </div>
              </div>
              <StatBlock
                label="Room in the plan"
                value={money(p.safeToSpendNow)}
                tone={p.withinPlan === "over" ? "bad" : "neutral"}
                hint={caption}
                data-testid="dash-room"
              />
              <StatBlock
                label="Low point"
                value={noForecast ? "—" : money(f.lowPoint)}
                tone={low != null && low < 0 ? "bad" : "neutral"}
                hint={
                  <>
                    {!noForecast && f.lowPointDate ? <span>{dayLabel(f.lowPointDate)}</span> : null}
                    {under != null ? <span data-testid="dash-under-buffer"> · under the buffer by {formatCurrency(under)}</span> : null}
                    {!noForecast ? (
                      <span data-testid="dash-runway">
                        {" · "}
                        {f.runwayDays != null ? `negative in ${f.runwayDays} days` : "stays positive, next 90 days"}
                      </span>
                    ) : null}
                  </>
                }
                data-testid="dash-low"
              />
              <StatBlock label="Buffer" value={money(f.cashBuffer)} data-testid="dash-buffer" />
              <LinkRow>
                <Link href="/banking" className="text-brand-navy underline">Banking</Link>
              </LinkRow>
            </div>
          );
        }}
      </Gate>
    </Panel>
  );
}
