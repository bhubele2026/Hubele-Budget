import type { Debt } from "@workspace/api-client-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  effectiveDebtBalance,
  pendingPaymentCountOf,
  pendingPaymentTotalOf,
} from "@/lib/debtBalance";

/**
 * ⭐ WHY THE NUMBER ABOVE IT IS NOT THE NUMBER ON THE STATEMENT.
 *
 * Every surface that nets pending payments out of a debt balance owes the
 * reader the arithmetic — otherwise the app quietly shows a figure the
 * creditor's website disagrees with and the user has no way to tell whether
 * that is a feature or a bug. The face carries the delta in three words; the
 * hover carries `reported − pending = shown`.
 *
 * This lived as an IIFE inside the Avalanche page's Balance cell. It is a
 * component now for the same reason `effectiveDebtBalance` moved to
 * `@/lib/debtBalance`: the Debts page has to disclose the netting the SAME
 * way, and two hand-copied disclosures drift.
 *
 * Renders nothing when there is nothing pending.
 */
export function DebtPendingHint({
  debt,
  fmt,
}: {
  debt: Debt;
  /** The page's own money formatter, so neither page changes how it prints. */
  fmt: (n: number) => string;
}) {
  const pendingTotal = pendingPaymentTotalOf(debt);
  if (pendingTotal <= 0) return null;
  const pendingCount = pendingPaymentCountOf(debt);
  const reported = Number(debt.balance) || 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // The Avalanche row this sits in opens a drill-down on click; the
          // hint must explain itself without navigating away.
          onClick={(e) => e.stopPropagation()}
          data-testid={`debt-pending-${debt.id}`}
          className="mt-0.5 cursor-help font-mono text-micro tabular-nums text-neutral-400 underline decoration-dotted underline-offset-2"
        >
          −{fmt(pendingTotal)} pending
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-left">
        <div className="space-y-1">
          <div>
            {pendingCount === 1
              ? "1 tagged payment hasn't reached the creditor yet."
              : `${pendingCount} tagged payments haven't reached the creditor yet.`}
          </div>
          <div className="opacity-90">
            Reported {fmt(reported)} − pending {fmt(pendingTotal)} ={" "}
            {fmt(effectiveDebtBalance(debt))}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
