import { useEffect, useState } from "react";
import type { SpineBank } from "@workspace/api-client-react";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { formatCurrency, formatRelativeTime } from "@/lib/utils";
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
 * Re-renders once a minute so relative times keep moving. Skipped when `now` is
 * pinned (tests) or when nothing on screen shows a relative time.
 */
function useMinuteTick(now?: Date, active = true): Date {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (now || !active) return;
    const id = setInterval(() => setTick((n) => n + 1), 60 * 1000);
    return () => clearInterval(id);
  }, [now, active]);
  return now ?? new Date();
}

/**
 * Money for a figure that may not have arrived: "—" until it has, never "$0.00".
 *
 * ⚠️ Do not reach for `MoneyText` here: it turns a missing amount into $0.00.
 */
export function moneyFace(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? formatCurrency(n) : "—";
}

/**
 * ⭐ HOW FRESH IS THE BANK BALANCE? Read from the spine; the server decides.
 *
 * Fresh, it is the calm line the app always showed: "Last auto-updated …" or
 * "Set manually …". Stale, the words say why. Only a failed refresh takes the
 * alarm colour, because only that one means something is wrong rather than
 * merely old. Status is never colour alone.
 *
 * "Last updated" is the last time the bank told us anything — a balance re-read
 * or a successful sync — the same moment the server judges staleness by.
 */
export function FreshnessLine({
  bank,
  now,
}: {
  bank: BankFreshnessFields | null | undefined;
  now?: Date;
}) {
  const at = useMinuteTick(now);

  if (!bank || !bank.source || !bank.asOfDate) return null;

  if (!bank.stale) {
    return <BankSnapshotFreshness source={bank.source} at={bank.asOfDate} now={at} />;
  }

  const lastHeard = formatRelativeTime(later(bank.asOfDate, bank.lastContactAt), at);

  switch (bank.staleReason) {
    case "refresh_failed":
      return (
        <span data-testid="text-bank-freshness-stale" data-reason="refresh_failed">
          <span className="font-semibold text-bad">Refresh failed</span> · last updated{" "}
          {lastHeard}
        </span>
      );
    case "old":
      return (
        <span data-testid="text-bank-freshness-stale" data-reason="old">
          <span className="font-semibold text-neutral-600">Bank last updated {lastHeard}</span>
        </span>
      );
    case "manual_old":
      return (
        <span data-testid="text-bank-freshness-stale" data-reason="manual_old">
          <span className="font-semibold text-neutral-600">
            Set manually {formatRelativeTime(bank.asOfDate, at)}
          </span>{" "}
          · needs an update
        </span>
      );
    default:
      // A reason this build does not know yet: say it may be out of date, and
      // never borrow another reason's words.
      return (
        <span data-testid="text-bank-freshness-stale" data-reason="unknown">
          <span className="font-semibold text-neutral-600">May be out of date</span> · last
          updated {lastHeard}
        </span>
      );
  }
}

/**
 * ⭐ THE NUMBERS COULD NOT BE REFRESHED — SAY SO, KEEP THEM, OFFER A RETRY.
 *
 * After a failed refresh the last good numbers stay on screen with the time
 * they are from, and that age keeps ticking. After a failed first load there
 * are no numbers, and the page's own placeholders stand in rather than zeros.
 * While a Retry is in flight the button gives way to "Refreshing…". Renders
 * nothing otherwise.
 */
export function RefreshBanner({
  state,
  updatedAt,
  onRetry,
  refreshing = false,
  now,
  "data-testid": testId = "refresh-banner",
}: {
  state: DataState;
  updatedAt: string | null;
  onRetry: () => void;
  refreshing?: boolean;
  now?: Date;
  "data-testid"?: string;
}) {
  // Only a failed refresh shows an age that can go stale on screen.
  const at = useMinuteTick(now, state === "refresh-failed");
  if (state !== "refresh-failed" && state !== "failed") return null;

  const action = refreshing ? (
    <span className="text-neutral-500" aria-live="polite">
      Refreshing…
    </span>
  ) : (
    <button type="button" className={btnLink} onClick={onRetry}>
      Retry
    </button>
  );

  if (state === "refresh-failed") {
    const from = formatRelativeTime(updatedAt, at);
    return (
      <div className={errorBanner} role="alert" data-testid={testId}>
        Couldn't refresh. Showing numbers from {from || "earlier"}. {action}
      </div>
    );
  }
  return (
    <div className={errorBanner} role="alert" data-testid={testId}>
      Couldn't load these numbers. {action}
    </div>
  );
}
