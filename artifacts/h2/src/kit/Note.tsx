import type { ReactNode } from "react";
import { AlertCircle, Clock, Minus } from "lucide-react";
import { cx } from "@/lib/cx";
import { relativeTime } from "@/lib/dates";
import type { DataState } from "@/lib/queryState";
import { Button } from "./Button";
import { useMinuteTick } from "./useMinuteTick";

export type NoteKind = "empty" | "error" | "stale";

const RULE: Record<NoteKind, string> = {
  empty: "border-rule-strong",
  error: "border-clay",
  stale: "border-ochre",
};
const ICON = { empty: Minus, error: AlertCircle, stale: Clock } as const;
const ICON_TONE: Record<NoteKind, string> = {
  empty: "text-ink-3",
  error: "text-clay",
  stale: "text-ochre",
};

/**
 * A short line set against a rule on its left: nothing here yet (empty),
 * something failed (error), or the data is old (stale). The words carry the
 * meaning; the rule colour and the icon only repeat it.
 *
 * With `onRetry`, a Retry button sits at the end — replaced by "Refreshing…"
 * while `retrying`, so a click visibly did something.
 */
export function Note({
  kind,
  children,
  onRetry,
  retrying = false,
  action,
  "data-testid": testId,
}: {
  kind: NoteKind;
  children: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  action?: ReactNode;
  "data-testid"?: string;
}) {
  const Icon = ICON[kind];
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cx("flex items-start gap-3 border-l-2 py-1 pl-3", RULE[kind])}
      data-kind={kind}
      data-testid={testId}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden className={cx("mt-0.5 shrink-0", ICON_TONE[kind])} />
      <div className="min-w-0 flex-1 type-body text-ink">{children}</div>
      {onRetry &&
        (retrying ? (
          <span className="type-label text-ink-2" aria-live="polite">
            Refreshing…
          </span>
        ) : (
          <Button variant="link" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ))}
      {action}
    </div>
  );
}

/**
 * ⭐ THE NUMBERS COULD NOT BE REFRESHED — SAY SO, KEEP THEM, OFFER A RETRY.
 * The classic `RefreshBanner`, on the Note.
 *
 * After a failed refresh the last good numbers stay on screen with their age,
 * which keeps ticking. After a failed first load there are no numbers, and the
 * screen's "—" stands in rather than zeros. Renders nothing otherwise.
 */
export function RefreshNote({
  state,
  updatedAt,
  onRetry,
  retrying = false,
  now,
}: {
  state: DataState;
  updatedAt: string | null;
  onRetry: () => void;
  retrying?: boolean;
  now?: Date;
}) {
  const at = useMinuteTick(now, state === "refresh-failed");
  if (state !== "refresh-failed" && state !== "failed") return null;
  if (state === "refresh-failed") {
    const from = relativeTime(updatedAt, at);
    return (
      <Note kind="error" onRetry={onRetry} retrying={retrying} data-testid="refresh-note">
        Couldn't refresh. Showing numbers from {from || "earlier"}.
      </Note>
    );
  }
  return (
    <Note kind="error" onRetry={onRetry} retrying={retrying} data-testid="refresh-note">
      Couldn't load these numbers.
    </Note>
  );
}
