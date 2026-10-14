import type { ReactNode } from "react";
import type { Spine } from "@workspace/api-client-react";
import { useGetPeriodBreakdown, getGetPeriodBreakdownQueryKey } from "@workspace/api-client-react/features";
import { cn } from "@/lib/utils";
import { currentPeriodParams, PERIOD_MIN } from "@/pages/spending/periodParams";
import { money } from "./shared";
import { Fig, Tile, Why, type TileStatus } from "./tileParts";

/**
 * (F4) This week, on the KNOWN figure: confirmed purchases against the plan
 * (`GET /money/period-breakdown`: known, remaining, over, provisional). When
 * unconfirmed rows may change the answer it says "Provisional" and never the
 * bare word "Over". Lazy: the read sits in the `features` sub-module, which
 * the landing path must not import. Every figure is the server's.
 */
export default function WeekKnownTile({ s, base }: { s: Spine; base: ReactNode }) {
  const params = currentPeriodParams("week");
  const q = useGetPeriodBreakdown(params, { query: { queryKey: getGetPeriodBreakdownQueryKey(params), staleTime: PERIOD_MIN } });
  const d = q.data;
  if (!d) return <>{base}</>;
  const planSet = d.remaining != null;
  const over = d.over != null && Math.round(Number(d.over) * 100) > 0;
  const status: TileStatus = !planSet
    ? { word: "Plan not set", tone: "neutral" }
    : d.provisional ? { word: "Provisional", tone: "neutral" }
    : over ? { word: "Over", tone: "bad" }
    : s.position.withinPlan === "tight" ? { word: "Tight", tone: "neutral" }
    : { word: "On plan", tone: "ok" };
  const line = over
    ? d.provisional ? `Over ${money(d.over)} so far · provisional` : `Over ${money(d.over)}`
    : d.provisional ? `${money(d.remaining)} left so far · provisional` : `${money(d.remaining)} left`;
  return (
    <Tile
      testid="week" title="This week" href="/spending/week" accent="checking" index={3} status={status}
      why={<Why>Confirmed purchases only. Rows H2 is not sure about are not counted until you confirm them.</Why>}
    >
      <Fig label="Counts toward plan" big testid="tile-week-spent" value={money(d.known)} />
      {planSet ? (
        <>
          <Fig label="Plan" value={money(d.plan.amount)} testid="tile-week-plan" />
          <div className={cn("font-mono text-body font-semibold tabular-nums", over && !d.provisional ? "text-bad-ink" : "text-brand-navy")} data-testid="tile-week-left">{line}</div>
        </>
      ) : null}
      {d.provisional ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-neutral-600" data-testid="tile-week-provisional">
          {/* The header chip says "Plan not set" without a plan, so the marker rides here. */}
          {planSet ? null : <span className="chip warn">Provisional</span>}
          <span>Unconfirmed {money(d.unresolved.amount)} may change this</span>
        </div>
      ) : null}
    </Tile>
  );
}
