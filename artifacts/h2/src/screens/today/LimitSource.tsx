import type { AllowancePlans } from "@workspace/api-client-react";
import { Link } from "wouter";
import { buttonClass } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";

/** "How the limit is set": the derivation lines, loaded off the open path. */
export default function LimitSource({ plans, limit, plan }: { plans: AllowancePlans | undefined; limit: number; plan: AllowancePlans["plans"][number] | null }) {
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
 * (V4) The lines under the week meter: what the household chose for a week (next week's start,
 * or this week's), unplanned spend on top, and the charges that need filing. All read, none worked out.
 */
export function WeekNotes({
  spent,
  unplanned,
  filing,
  adjustment,
  today,
}: {
  spent: number;
  unplanned: number | null;
  filing: number;
  adjustment: { amount: string; weekStart: string } | null;
  today: string;
}) {
  const by = toAmount(adjustment?.amount);
  return (
    <>
      {adjustment && by != null && by !== 0 && (
        <p className="mt-3 type-caption text-ink-2" data-testid="week-adjustment">
          {adjustment.weekStart > today ? "Next week starts " : "This week started "}
          <data value={centsValue(Math.abs(by))} className="tnum">
            {fmtMoney(Math.abs(by))}
          </data>{" "}
          lower (you chose this)
        </p>
      )}
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
