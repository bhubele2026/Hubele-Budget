import { useEffect, useState } from "react";
import type { SpineBank } from "@workspace/api-client-react";
import { bankFreshWords, freshKindOf } from "@/lib/bankFreshWords";
import { formatCurrency, formatRelativeTime } from "@/lib/utils";
import type { DataState } from "@/lib/queryState";
import { btnLink, errorBanner } from "@/ui";

type BankFreshnessFields = Pick<SpineBank, "source" | "stale" | "staleReason">;

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
 * ⭐ HOW FRESH IS THE BANK BALANCE? The server decides; the words are `lib/bankFreshWords`.
 *
 * "Updated 2 h ago" is the SERVER's `fetchedAt` (`spine.bankConfidence.fetchedAt`, or the
 * review's `freshness.fetchedAt`: the same instant) — the browser never takes a "later of"
 * itself. Stale, a status leads ("Last sync failed", "Out of date", "Needs an update"); only a
 * failed sync takes the alarm colour. Status is never colour alone.
 */
export function FreshnessLine({
  bank,
  fetchedAt,
  now,
}: {
  bank: BankFreshnessFields | null | undefined;
  fetchedAt: string | null | undefined;
  now?: Date;
}) {
  const at = useMinuteTick(now);

  if (!bank || !bank.source) return null;

  const f = bankFreshWords({ kind: freshKindOf(bank.stale, bank.staleReason), fetchedAt, now: at.getTime() });
  const updated = f.updated ?? "Not updated yet";
  if (!f.status) {
    return <div data-testid="text-bank-snapshot-freshness">{updated}</div>;
  }
  return (
    <span data-testid="text-bank-freshness-stale" data-reason={bank.staleReason ?? "unknown"}>
      <span className={f.alarm ? "font-semibold text-bad-ink" : "font-semibold text-neutral-600"}>{f.status}</span> · {updated}
    </span>
  );
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
