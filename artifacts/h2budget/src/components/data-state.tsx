import { useEffect, useState } from "react";
import type { SpineBank } from "@workspace/api-client-react";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { formatRelativeTime } from "@/lib/utils";
import type { DataState } from "@/lib/queryState";
import { btnLink, errorBanner } from "@/ui";

type BankFreshnessFields = Pick<
  SpineBank,
  "asOfDate" | "source" | "lastContactAt" | "stale" | "staleReason"
>;

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) > Date.parse(b) ? a : b;
}

/**
 * ⭐ HOW FRESH IS THE BANK BALANCE? Read from the spine; the server decides.
 *
 * Fresh, it is the calm line the app always showed: "Last auto-updated …" or
 * "Set manually …". Stale, the words say why. Only a failed refresh takes the
 * alarm colour, because only that one means something is wrong rather than
 * merely old. Status is never colour alone.
 *
 * Re-renders once a minute so the relative time keeps moving, unless the caller
 * pins `now` (tests).
 */
export function FreshnessLine({
  bank,
  now,
}: {
  bank: BankFreshnessFields | null | undefined;
  now?: Date;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (now) return;
    const id = setInterval(() => setTick((n) => n + 1), 60 * 1000);
    return () => clearInterval(id);
  }, [now]);

  if (!bank || !bank.source || !bank.asOfDate) return null;
  const at = now ?? new Date();

  if (!bank.stale) {
    return <BankSnapshotFreshness source={bank.source} at={bank.asOfDate} now={at} />;
  }

  if (bank.staleReason === "refresh_failed") {
    return (
      <span data-testid="text-bank-freshness-stale" data-reason="refresh_failed">
        <span className="font-semibold text-bad">Refresh failed</span> · last updated{" "}
        {formatRelativeTime(bank.asOfDate, at)}
      </span>
    );
  }

  if (bank.staleReason === "old") {
    return (
      <span data-testid="text-bank-freshness-stale" data-reason="old">
        <span className="font-semibold text-neutral-600">No bank update in 2 days</span> · last
        updated {formatRelativeTime(later(bank.asOfDate, bank.lastContactAt), at)}
      </span>
    );
  }

  return (
    <span data-testid="text-bank-freshness-stale" data-reason="manual_old">
      <span className="font-semibold text-neutral-600">
        Set manually {formatRelativeTime(bank.asOfDate, at)}
      </span>{" "}
      · over a week old
    </span>
  );
}

/**
 * ⭐ THE NUMBERS COULD NOT BE REFRESHED — SAY SO, KEEP THEM, OFFER A RETRY.
 *
 * After a failed refresh the last good numbers stay on screen with the time
 * they are from. After a failed first load there are no numbers, and the page's
 * own placeholders stand in rather than zeros. Renders nothing otherwise.
 */
export function RefreshBanner({
  state,
  updatedAt,
  onRetry,
  now,
  "data-testid": testId = "refresh-banner",
}: {
  state: DataState;
  updatedAt: string | null;
  onRetry: () => void;
  now?: Date;
  "data-testid"?: string;
}) {
  if (state === "refresh-failed") {
    const from = formatRelativeTime(updatedAt, now ?? new Date());
    return (
      <div className={errorBanner} role="alert" data-testid={testId}>
        Couldn't refresh. Showing numbers from {from || "earlier"}.{" "}
        <button type="button" className={btnLink} onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className={errorBanner} role="alert" data-testid={testId}>
        Couldn't load these numbers.{" "}
        <button type="button" className={btnLink} onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}
