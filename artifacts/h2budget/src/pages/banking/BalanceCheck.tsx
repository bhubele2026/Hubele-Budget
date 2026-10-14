import { Link } from "wouter";
import type { BankingReviewBalanceCheck } from "@workspace/api-client-react/features";
import { BankBalanceWhy } from "@/components/bank-balance-why";
import { cn, formatCurrency, formatRelativeTime } from "@/lib/utils";

/**
 * (F4) BALANCE CHECK — does H2's balance match the bank's? The last manual
 * Sync's answer (`balanceCheck`), in five states:
 *   Matches bank · Off by $X (which way, and Investigate) · Resolved since ·
 *   Not checked yet (with the reason) · and any of them greyed when the answer
 *   is old ("Checked N days ago — Sync to recheck").
 * Kept apart from "Review inbox" and "Synced …". Every amount is the server's.
 */

export const NOT_CHECKED_WORDS: Record<string, string> = {
  never: "A Sync on the register checks it.",
  not_forecast_account: "H2 checks the balance on the planned account only.",
  anchor_too_old: "The last balance was too old to check. Sync again.",
  balance_unavailable: "The bank gave no balance. Sync again.",
};

/** "Bank is $62.50 lower than H2" — which way the difference runs. */
export function directionWords(c: BankingReviewBalanceCheck): string | null {
  if (c.difference == null || c.direction == null) return null;
  const amount = formatCurrency(c.difference);
  return c.direction === "bank_higher" ? `Bank is ${amount} higher than H2` : `Bank is ${amount} lower than H2`;
}

/** "9 days ago" (whole days; under a day is the relative time). A label only. */
export function ageWords(iso: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return days >= 2 ? `${days} days ago` : formatRelativeTime(iso, now);
}

export function BalanceCheck({ check, registerHref, now }: { check: BankingReviewBalanceCheck; registerHref: string | null; now?: Date }) {
  const when = check.checkedAt ? formatRelativeTime(check.checkedAt, now) : "";
  const stale = check.stale && check.status !== "not_checked";
  // Stale is shown by the grey chip and the "Checked … — Sync to recheck" line, never by fading the
  // text (opacity dropped the chip below 4.5:1 contrast).
  const grey = "";
  const recheck = stale && check.checkedAt ? `Checked ${ageWords(check.checkedAt, now)} — Sync to recheck` : when ? `Checked ${when}` : "";
  const was = check.lastDrift ? formatCurrency(check.lastDrift.difference) : null;
  let chip: { cls: string; text: string };
  switch (check.status) {
    case "matches":
      chip = { cls: stale ? "gray" : "ok", text: "Matches bank" };
      break;
    case "off_by":
      chip = { cls: stale ? "gray" : "bad", text: check.difference != null ? `Off by ${formatCurrency(check.difference)}` : "Off from bank" };
      break;
    case "resolved_since":
      chip = { cls: stale ? "gray" : "ok", text: "Resolved since" };
      break;
    default:
      chip = { cls: "gray", text: "Not checked yet" };
  }
  return (
    <div className={cn("space-y-1", grey)} data-testid="br-check" data-state={check.status} data-stale={stale ? "true" : "false"}>
      <div className="mt-1.5">
        <span className={cn("chip", chip.cls)} data-testid="br-tie">{chip.text}</span>
      </div>
      {check.status === "off_by" ? (
        <>
          {directionWords(check) ? <div className="text-micro text-neutral-700" data-testid="br-check-direction">{directionWords(check)}</div> : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro">
            <BankBalanceWhy
              trigger={<button type="button" className="press font-semibold text-brand-navy underline" data-testid="br-investigate">Investigate</button>}
            />
            {registerHref ? <Link href={registerHref} className="font-semibold text-brand-navy underline" data-testid="br-check-register">Open register</Link> : null}
          </div>
        </>
      ) : null}
      {check.status === "resolved_since" && was ? (
        <div className="text-micro text-neutral-700" data-testid="br-check-was">It was off by {was}. Rows that arrived later explain it.</div>
      ) : null}
      {check.status === "not_checked" ? (
        <div className="text-micro text-neutral-600" data-testid="br-check-reason">{NOT_CHECKED_WORDS[check.reason ?? "never"] ?? NOT_CHECKED_WORDS.never}</div>
      ) : recheck ? (
        <div className="text-micro text-neutral-600" data-testid="br-check-when">{recheck}</div>
      ) : null}
    </div>
  );
}
