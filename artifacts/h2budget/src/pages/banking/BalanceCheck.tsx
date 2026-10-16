import { Link } from "wouter";
import type { BankingReviewBalanceCheck } from "@workspace/api-client-react/features";
import { checkState, type CheckToday } from "@/lib/bankConfidenceView";
import { cn } from "@/lib/utils";
import { CheckExplain } from "./CheckExplain";

/**
 * (F4, Q5, T2) BALANCE CHECK — does H2's balance match the bank's? The last
 * manual Sync's answer (`balanceCheck`), in ONE state machine
 * (`lib/bankConfidenceView` `checkState`): one chip, one line about the check's
 * own moment, one action.
 *
 *   Balances match · Difference needs review (→ Review difference) ·
 *   Resolved since · Check is out of date (→ Sync to check) · Not checked
 *
 * When a difference stands but today's two figures are one reading (the Sync
 * re-anchored H2 to the bank), a first line says so: "Today H2 $0.00 and the
 * bank $0.00 agree." An earlier difference stays visible as history. Nothing
 * here clears or changes the check. Every amount is the server's.
 */
export function BalanceCheck({
  check,
  registerHref,
  now,
  today,
  onSync,
  syncing = false,
  explain,
}: {
  check: BankingReviewBalanceCheck;
  registerHref: string | null;
  now?: Date;
  /** Today's balance and the reading under it (the review's own `balance`), for the "agree" line. */
  today?: CheckToday | null;
  /** "Sync to check": a manual Sync of this account's bank. Absent: the words only. */
  onSync?: () => void;
  syncing?: boolean;
  /** Review difference, controlled by the page (`?check=1`, or "Why this number?" → Review difference). */
  explain?: { open: boolean; onOpenChange: (open: boolean) => void };
}) {
  const s = checkState(check, (now ?? new Date()).getTime(), today);
  return (
    <div
      className="space-y-1"
      data-testid="br-check"
      data-state={check.status}
      data-stale={check.stale && check.status !== "not_checked" ? "true" : "false"}
      data-tone={s.tone}
    >
      <div className="mt-1.5">
        <span className={cn("chip", s.tone === "grey" ? "gray" : s.tone)} data-testid="br-tie">{s.chip}</span>
      </div>
      {s.agree ? <div className="text-micro text-neutral-700" data-testid="br-check-agree">{s.agree}</div> : null}
      {s.line ? <div className="text-micro text-neutral-700" data-testid="br-check-line">{s.line}</div> : null}
      {s.history ? <div className="text-micro text-neutral-600" data-testid="br-check-history">{s.history}</div> : null}
      {s.action === "review" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro">
          <CheckExplain open={explain?.open} onOpenChange={explain?.onOpenChange} />
          {registerHref ? <Link href={registerHref} className="font-semibold text-brand-navy underline" data-testid="br-check-register">Open register</Link> : null}
        </div>
      ) : s.action === "sync" && onSync ? (
        <button
          type="button"
          className="press text-micro font-semibold text-brand-navy underline disabled:opacity-60"
          onClick={onSync}
          disabled={syncing}
          data-testid="br-check-sync"
        >
          {syncing ? "Syncing…" : "Sync to check"}
        </button>
      ) : s.action === "sync" ? (
        <div className="text-micro text-neutral-600" data-testid="br-check-when">Sync to check</div>
      ) : null}
    </div>
  );
}
