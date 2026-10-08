import { Link } from "wouter";
import type { AllowancePlans, MoneyPosition, Settings, Spine } from "@workspace/api-client-react";
import type { LedgerPage } from "@workspace/api-client-react/ledger";
import { Disclosure } from "@/kit/Disclosure";
import { Figure } from "@/kit/Figure";
import { Meter, type MeterStatus } from "@/kit/Meter";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonMeter } from "@/kit/Skeleton";
import { buttonClass } from "@/kit/Button";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import type { Read } from "@/data/todayData";

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

function LimitSource({ plans, limit, plan }: { plans: AllowancePlans | undefined; limit: number; plan: AllowancePlans["plans"][number] | null }) {
  const d = plans?.suggested.derivation;
  const lines: Array<[string, string]> = d
    ? [
        ["Take-home", d.takeHomeMonthly],
        ["Bills", d.committedMonthly],
        ["Debt minimums", d.debtMinimumsMonthly],
        ["Extra to debt", d.extraMonthly],
        ["Goals", d.goalsMonthly],
        ["Left to spend", d.discretionaryMonthly],
      ]
    : [];
  return (
    <Disclosure summary="How the limit is set">
      <p data-testid="limit-source">
        {plan?.source === "derived"
          ? `${fmtMoney(limit)} a week, suggested from your income, bills and debt payments.`
          : `${fmtMoney(limit)} a week, set by you.`}
      </p>
      {plans && (
        <p className="mt-2" data-testid="limit-suggested">
          H2 suggests {fmtMoney(toAmount(plans.suggested.weekly))} a week.
        </p>
      )}
      {plan?.source === "derived" && lines.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1" data-testid="limit-derivation">
          {lines.map(([k, v]) => {
            const n = toAmount(v);
            return (
              <li key={k}>
                {k}{" "}
                {n == null ? (
                  "—"
                ) : (
                  <data value={centsValue(n)} className="tnum">
                    {fmtMoney(n)}
                  </data>
                )}{" "}
                a month
              </li>
            );
          })}
        </ul>
      )}
    </Disclosure>
  );
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
}: {
  spine: Spine | undefined;
  position: Read<MoneyPosition>;
  plans: Read<AllowancePlans>;
  settings: Read<Settings>;
  unfiled: Read<LedgerPage>;
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
        {unplanned != null && unplanned > 0 && (
          <p className="mt-3 type-caption text-ink-3" data-testid="week-caption">
            <data value={centsValue(spent)} className="tnum">
              {fmtMoney(spent)}
            </data>{" "}
            so far ·{" "}
            <data value={centsValue(unplanned)} className="tnum">
              {fmtMoney(unplanned)}
            </data>{" "}
            unplanned on top
          </p>
        )}
        {filing > 0 && (
          <p className="mt-2 type-caption text-ink-2" data-testid="needs-filing">
            <data value={String(filing)} className="tnum">
              {filing}
            </data>{" "}
            {filing === 1 ? "charge needs" : "charges need"} filing ·{" "}
            <Link href="/activity?unfiled=1" className={buttonClass({ variant: "link", size: "sm" })}>
              {filing === 1 ? "File it" : "File them"}
            </Link>
          </p>
        )}
      </>
    );
  }

  return (
    <Section label="This week" data-testid="section-week">
      {body}
      {limit != null && !cold && (
        <div className="mt-4">
          <LimitSource plans={plans.data} limit={limit} plan={plan} />
        </div>
      )}
    </Section>
  );
}
