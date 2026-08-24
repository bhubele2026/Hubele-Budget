// (#826) Avalanche extra-payment schedule — the dated plan of extra payments
// the forecast says are safe to make: 4–12 payments (date, amount, why,
// confidence), the current avalanche target, and a footer total.
//
// Every number here is server-computed and deterministic. This file is
// PRESENTATION ONLY — it reads `useGetForecastAvalancheSchedule()` and renders
// it; it does not derive, round, or re-sum anything.

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { card, cardHead, th, td, tdNum, Help, Foot } from "@/ui";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useGetForecastAvalancheSchedule } from "@workspace/api-client-react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * Confidence, as a `.chip`.
 *
 * ⚠️ THE WORD CARRIES THE STATE, NOT THE COLOUR. `ok` is the same navy as body
 * text on purpose — under the palette rule good is the resting state and does
 * not shout, so "High" has to be legible as high without the chip's fill doing
 * any work. Only `low` spends the one alarm colour the app has.
 */
const CONFIDENCE_META = {
  high: { label: "High", tone: "ok" },
  medium: { label: "Medium", tone: "gray" },
  low: { label: "Low", tone: "bad" },
} as const;

export function AvalancheScheduleCard() {
  const { data, isLoading } = useGetForecastAvalancheSchedule();
  const [expanded, setExpanded] = useState(false);

  if (isLoading || !data) {
    return (
      <div className={card} data-testid="card-avalanche-schedule">
        <div className={cardHead}>
          <Skeleton className="h-4 w-44" />
        </div>
        <div className="space-y-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    );
  }

  const payments = data.proposedPayments ?? [];
  const hasPayments = payments.length > 0;
  const target = data.currentAvalancheTarget;

  return (
    <div className={card} data-testid="card-avalanche-schedule">
      <div className={cardHead}>
        <span className="text-title font-semibold text-brand-navy">Schedule</span>
        {target && (
          <span className="truncate text-micro uppercase tracking-wide text-neutral-400">
            {target.debtName} · {(target.apr * 100).toFixed(2)}% APR
          </span>
        )}
        <Help className="ml-auto">
          Dated extra payments the cash forecast says clear without dipping the
          projected balance. Amounts and dates are computed on the server.
        </Help>
      </div>

      {hasPayments ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid="button-toggle-avalanche-schedule"
            className="press flex w-full items-center gap-2 px-4 py-2.5 text-left text-body text-neutral-600 hover:text-brand-navy"
          >
            <span className="font-mono text-label font-semibold tabular-nums text-brand-navy">
              {formatCurrency(data.totalProposed)}
            </span>
            <span className="text-micro uppercase tracking-wide text-neutral-400">
              over {payments.length} payment{payments.length === 1 ? "" : "s"}
            </span>
            <span className="ml-auto inline-flex items-center gap-1 text-micro font-semibold uppercase tracking-wide">
              {expanded ? "Hide" : "Show"}
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </span>
          </button>

          {expanded && (
            <>
              <div className="overflow-x-auto">
                <table
                  className="w-full border-t border-brand-line"
                  data-testid="list-avalanche-payments"
                >
                  <thead>
                    <tr>
                      <th className={th}>Date</th>
                      <th className={`${th} text-right`}>Amount</th>
                      <th className={th}>Why</th>
                      <th className={th}>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p, i) => {
                      const meta = CONFIDENCE_META[p.confidence];
                      return (
                        <tr key={`${p.date}-${i}`} data-testid={`row-avalanche-payment-${i}`}>
                          <td className={`${td} whitespace-nowrap text-neutral-500`}>
                            {formatDate(p.date)}
                          </td>
                          <td className={tdNum}>{formatCurrency(p.amount)}</td>
                          <td className={`${td} text-neutral-500`}>{p.rationale}</td>
                          <td className={td}>
                            <span className={`chip ${meta.tone}`}>{meta.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr data-testid="text-avalanche-total">
                      <td className={`${td} text-micro font-semibold uppercase tracking-wide text-neutral-400`}>
                        Total
                      </td>
                      <td className={`${tdNum} font-semibold`}>
                        {formatCurrency(data.totalProposed)}
                      </td>
                      <td className={`${td} text-neutral-400`} colSpan={2}>
                        {payments.length} payment{payments.length === 1 ? "" : "s"}
                        {data.scheduleThroughDate && (
                          <> through {formatDate(data.scheduleThroughDate)}</>
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </>
      ) : (
        <Foot data-testid="text-avalanche-empty">
          No safe payment window in the next 12 months. Windows open as bills
          clear.
        </Foot>
      )}
    </div>
  );
}
