import type { ReactNode } from "react";
import type { SpineBank } from "@workspace/api-client-react";
import { relativeTime } from "@/lib/dates";
import type { DataState } from "@/lib/queryState";
import { SkeletonLine } from "./Skeleton";
import { StatusWord } from "./StatusWord";
import { useMinuteTick } from "./useMinuteTick";

export type BankFreshness = Pick<
  SpineBank,
  "asOfDate" | "source" | "lastContactAt" | "stale" | "staleReason"
>;

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) > Date.parse(b) ? a : b;
}

/**
 * ⭐ HOW FRESH IS THE BANK BALANCE? Read from the spine; the server decides
 * what "stale" means and why. Ported from the classic `FreshnessLine`.
 *
 * Fresh, it is a calm line ("Synced 12 minutes ago"). Stale, a word says why,
 * and "last updated" is the last time the bank told us anything (a balance
 * re-read or a successful sync), the moment the server judges staleness by.
 * Only a failed refresh takes the clay colour: it is the one that means
 * something is wrong rather than merely old. A word is always present.
 *
 * `state` is the spine query's: "Updating" while a newer copy is on its way.
 */
export function FreshnessBadge({
  bank,
  state = "loaded",
  now,
}: {
  bank: BankFreshness | null | undefined;
  state?: DataState;
  now?: Date;
}) {
  const at = useMinuteTick(now, state !== "cold");

  if (state === "cold") return <SkeletonLine className="w-32" />;

  let body: ReactNode;
  let reason = "fresh";

  if (state === "refreshing") {
    reason = "updating";
    body = <StatusWord tone="neutral">Updating</StatusWord>;
  } else if (state === "failed") {
    reason = "not-loaded";
    body = <StatusWord tone="over">Not loaded</StatusWord>;
  } else if (!bank || !bank.source || !bank.asOfDate) {
    reason = "no-bank";
    body = <StatusWord tone="neutral">No bank balance yet</StatusWord>;
  } else if (!bank.stale) {
    body = (
      <StatusWord tone="fresh">
        {bank.source === "plaid" ? "Synced" : "Set by hand"} {relativeTime(bank.asOfDate, at)}
      </StatusWord>
    );
  } else {
    const lastHeard = relativeTime(later(bank.asOfDate, bank.lastContactAt), at);
    switch (bank.staleReason) {
      case "refresh_failed":
        reason = "refresh_failed";
        body = (
          <>
            <StatusWord tone="over">Refresh failed</StatusWord>
            <span className="type-caption text-ink-2">last updated {lastHeard}</span>
          </>
        );
        break;
      case "old":
        reason = "old";
        body = (
          <>
            <StatusWord tone="stale">Out of date</StatusWord>
            <span className="type-caption text-ink-2">last updated {lastHeard}</span>
          </>
        );
        break;
      case "manual_old":
        reason = "manual_old";
        body = (
          <>
            <StatusWord tone="stale">Needs an update</StatusWord>
            <span className="type-caption text-ink-2">
              set by hand {relativeTime(bank.asOfDate, at)}
            </span>
          </>
        );
        break;
      default:
        // A reason this build does not know yet: say it may be out of date and
        // never borrow another reason's words.
        reason = "unknown";
        body = (
          <>
            <StatusWord tone="stale">May be out of date</StatusWord>
            <span className="type-caption text-ink-2">last updated {lastHeard}</span>
          </>
        );
    }
  }

  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="freshness-badge"
      data-reason={reason}
    >
      {body}
    </span>
  );
}
