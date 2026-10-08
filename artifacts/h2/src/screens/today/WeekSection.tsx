import { lazy, Suspense } from "react";
import type { AllowancePlans, MoneyPosition, Settings, Spine } from "@workspace/api-client-react";
import type { LedgerPage } from "@workspace/api-client-react/ledger";
import { Figure } from "@/kit/Figure";
import { Meter, type MeterStatus } from "@/kit/Meter";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonMeter } from "@/kit/Skeleton";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import type { Read } from "@/data/todayData";

const limitSource = () => import("./LimitSource");
const LimitSource = lazy(limitSource);
// (V4) The lines under the meter (the household's choice, unplanned spend, charges to file) load right behind it.
const WeekNotes = lazy(() => limitSource().then((m) => ({ default: m.WeekNotes })));

const STATUS: Record<"yes" | "tight" | "over", MeterStatus> = { yes: "on", tight: "tight", over: "over" };

/**
 * The week's limit, in the order that is true to the server: the cap the
 * position itself measured against (`weekCap`, override-aware), then the
 * household's shared weekly plan, then the old settings amount. A $0 is none.
 */
export function weeklyLimit(
  position: MoneyPosition | undefined,
  plans: AllowancePlans | undefined,
  settings: Settings | undefined,
): { limit: number | null; plan: AllowancePlans["plans"][number] | null } {
  const shared =
    plans?.plans
      .filter((pl) => pl.memberUserId === null && pl.period === "weekly")
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
  for (const v of [position?.weekCap, shared?.amount, settings?.weeklyAllowanceAmount]) {
    const n = toAmount(v);
    if (n != null && n > 0) return { limit: n, plan: shared };
  }
  return { limit: null, plan: shared };
}

/**
 * ⭐ THIS WEEK — spent against the limit, the status in words from the
 * server's `withinPlan`. The only subtraction on screen is "Over by $x": the
 * server's `remainingWeek` with its sign dropped.
 */
export function WeekSection({
  spine,
  position,
  plans,
  settings,
  unfiled,
  today,
}: {
  spine: Spine | undefined;
  position: Read<MoneyPosition>;
  plans: Read<AllowancePlans>;
  settings: Read<Settings>;
  unfiled: Read<LedgerPage>;
  /** The household's date, to tell this week's adjustment from next week's. */
  today: string;
}) {
  const pos = position.data;
  const within = spine?.position.withinPlan ?? pos?.withinPlan ?? null;
  const { limit, plan } = weeklyLimit(pos, plans.data, settings.data);
  const spent = toAmount(pos?.spentWeekDiscretionary);
  const unplanned = toAmount(pos?.unplannedWeek);
  // A COUNT OF CHARGES, from the ledger's own filter (uncategorized, this week).
  const filing = unfiled.data?.matchingCount ?? 0;
  const remaining = toAmount(spine?.position.remainingWeek ?? pos?.remainingWeek);
  const cold = !spine || position.state === "cold" || settings.state === "cold";

  const adjustment = spine?.position.weekAdjustment ?? pos?.weekAdjustment ?? null;
  let body;
  if (cold && !pos) {
    body = <SkeletonMeter />;
  } else if (position.state === "failed" || spent == null) {
    body = (
      <>
        <Figure size="md" label="Spent so far" amount={null} state="failed" />
        <div className="mt-3">
          <Note kind="error" onRetry={position.refetch} retrying={position.isFetching}>
            Couldn't load this week.
          </Note>
        </div>
      </>
    );
  } else {
    const status = within ? STATUS[within] : "on";
    const words =
      within === "over" && remaining != null && remaining < 0 ? `Over by ${fmtMoney(-remaining)}` : undefined;
    body = (
      <>
        <Meter
          label="Spent so far"
          spent={spent}
          limit={limit}
          status={status}
          words={words}
          data-testid="meter-week"
        />
        <Suspense fallback={null}>
          <WeekNotes spent={spent} unplanned={unplanned} filing={filing} adjustment={adjustment} today={today} />
        </Suspense>
      </>
    );
  }

  return (
    <Section label="This week" data-testid="section-week">
      {body}
      {limit != null && !cold && (
        <div className="mt-4">
          <Suspense fallback={null}>
            <LimitSource plans={plans.data} limit={limit} plan={plan} />
          </Suspense>
        </div>
      )}
    </Section>
  );
}
