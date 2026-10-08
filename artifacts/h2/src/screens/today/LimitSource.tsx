import type { AllowancePlans } from "@workspace/api-client-react";
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
