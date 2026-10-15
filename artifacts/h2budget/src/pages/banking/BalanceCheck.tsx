import { Link } from "wouter";
import type { BankingReviewBalanceCheck } from "@workspace/api-client-react/features";
import { BankBalanceWhy } from "@/components/bank-balance-why";
import { checkView } from "@/lib/bankConfidenceView";
import { householdToday } from "@/lib/householdDay";
import { dayWords } from "./words";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * (F4, Q5) BALANCE CHECK — does H2's balance match the bank's? The last manual
 * Sync's answer (`balanceCheck`), said as ONE chip and one comparison line:
 *   Matches bank · Off by $X — bank higher/lower · Not checked yet — <why> ·
 *   and, when the answer is old, a grey "Checked 9 days ago".
 * Green only for a check that matched and is not stale. "Bank $X · H2 $Y" are
 * the two figures the check compared. Kept apart from "Updated …" (the fetch)
 * and from the review count. Every amount is the server's.
 */
export function BalanceCheck({ check, registerHref, now }: { check: BankingReviewBalanceCheck; registerHref: string | null; now?: Date }) {
  const view = checkView(check, (now ?? new Date()).getTime());
  const stale = check.stale && check.status !== "not_checked";
  const was = check.lastDrift ? formatCurrency(check.lastDrift.difference) : null;
  // Named by its moment: H2's figure AT THE CHECK is not H2's balance today (a Sync moves H2 to the bank).
  const checkedOn = check.checkedAt ? dayWords(householdToday(new Date(check.checkedAt))) : null;
  const compared = check.bank && check.h2 ? `At the check${checkedOn ? ` (${checkedOn})` : ""}: bank ${formatCurrency(check.bank.balance)} · H2 ${formatCurrency(check.h2.balance)}` : null;
  return (
    <div className="space-y-1" data-testid="br-check" data-state={check.status} data-stale={stale ? "true" : "false"} data-tone={view.tone}>
      <div className="mt-1.5">
        <span className={cn("chip", view.tone === "grey" ? "gray" : view.tone)} data-testid="br-tie">{view.word}</span>
      </div>
      {compared ? <div className="font-mono text-micro tabular-nums text-neutral-700" data-testid="br-check-compared">{compared}</div> : null}
      {check.status === "off_by" && !stale ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro">
          <BankBalanceWhy
            trigger={<button type="button" className="press font-semibold text-brand-navy underline" data-testid="br-investigate">Investigate</button>}
          />
          {registerHref ? <Link href={registerHref} className="font-semibold text-brand-navy underline" data-testid="br-check-register">Open register</Link> : null}
        </div>
      ) : null}
      {check.status === "resolved_since" && was ? (
        <div className="text-micro text-neutral-700" data-testid="br-check-was">It was off by {was}. Rows that arrived later explain it.</div>
      ) : null}
      {stale ? <div className="text-micro text-neutral-600" data-testid="br-check-when">Sync to recheck</div> : null}
    </div>
  );
}
