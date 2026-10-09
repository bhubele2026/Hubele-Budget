import type { ReactNode } from "react";
import { cn, formatCurrency } from "@/lib/utils";
import { emptyNote } from "@/ui";
import { shortDate } from "@/components/next";
import { householdDayOfAt } from "@/lib/householdDay";

/** Money for a figure that may be missing: an em dash, never $0. */
export function money(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? formatCurrency(n) : "—";
}

/** "Oct 7" from a timestamp or date, on the household calendar. */
export function dayLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : householdDayOfAt(iso);
  return shortDate(d);
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Entry stagger on the existing dial (shared with the account pages). */
export { rise } from "@/components/next/PageGrid";

export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div data-testid="panel-skeleton" className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-5 w-full rounded-control" />
      ))}
    </div>
  );
}

export function PanelError({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div data-testid="panel-error" role="alert" className="text-body text-neutral-600">
      <p>{what} did not load.</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-1 text-label font-semibold text-brand-navy underline">
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Skeleton while the first answer is on its way, an error if it never came,
 *  the content otherwise. A failed refresh keeps the last good data. */
export function Gate({
  q, what, rows, children,
}: {
  q: { data: unknown; isLoading?: boolean; isError?: boolean; refetch?: () => unknown };
  what: string;
  rows?: number;
  children: () => ReactNode;
}) {
  if (q.data === undefined) {
    if (q.isError) return <PanelError what={what} onRetry={q.refetch ? () => void q.refetch!() : undefined} />;
    return <PanelSkeleton rows={rows} />;
  }
  return <>{children()}</>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className={cn(emptyNote, "px-0")}>{children}</p>;
}

export function LinkRow({ children }: { children: ReactNode }) {
  return <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-label">{children}</div>;
}
