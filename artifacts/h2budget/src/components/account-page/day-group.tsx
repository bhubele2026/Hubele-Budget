import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function formatDayHeader(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function DayGroup({
  dayKey,
  count,
  isToday,
  totalNode,
  selectionState,
  onToggleAll,
  todayAccent = "blue",
  headerLabel,
  todayBadgeLabel = "Today",
  containerRef,
  children,
}: {
  dayKey: string;
  count: number;
  isToday: boolean;
  totalNode: ReactNode;
  selectionState: boolean | "indeterminate";
  onToggleAll: (on: boolean) => void;
  // (#728) Added "amber" for the pinned "Pending" pseudo-day-group on
  // the Transactions page — pending charges are mid-lifecycle and
  // should look distinct from the emerald "today" and blue
  // per-account accents.
  todayAccent?: "blue" | "emerald" | "amber";
  // (#728) Override the date-style header for non-ISO group keys
  // (e.g. the "Pending" pinned group). When omitted, we fall back
  // to formatDayHeader(dayKey).
  headerLabel?: string;
  // (#728) Override the "Today" badge text for pseudo-day-groups
  // that still want the accented header treatment ("Pending" reads
  // better than "Today" on the rate-limited pinned section).
  todayBadgeLabel?: string;
  containerRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const todayBorder =
    todayAccent === "emerald"
      ? "border-positive/30 bg-positive/10"
      : todayAccent === "amber"
        ? "border-warning/30 bg-warning/10"
        : "border-primary/30 bg-primary/10";
  const todayBadge =
    todayAccent === "emerald"
      ? "border-positive/30 text-positive bg-positive/10"
      : todayAccent === "amber"
        ? "border-warning/30 text-warning bg-warning/10"
        : "border-primary/30 text-primary bg-primary/10";
  return (
    <div ref={containerRef} className="space-y-2">
      <div
        className={cn(
          "sticky z-10 flex items-center justify-between gap-3 rounded-md border bg-background/95 backdrop-blur px-3 py-2",
          isToday && todayBorder,
        )}
        style={{ top: "var(--pinned-pane-h, 0px)" }}
      >
        <div className="flex items-center gap-3">
          <Checkbox
            checked={selectionState}
            onCheckedChange={(v) => onToggleAll(!!v)}
            aria-label="Select day"
          />
          <div className="font-semibold text-sm">
            {headerLabel ?? formatDayHeader(dayKey)}
          </div>
          {isToday && (
            <Badge variant="outline" className={cn("text-[10px]", todayBadge)}>
              {todayBadgeLabel}
            </Badge>
          )}
          <Badge variant="secondary" className="text-[10px]">
            {count} txn{count === 1 ? "" : "s"}
          </Badge>
        </div>
        <div className="text-sm font-mono tabular-nums font-semibold">
          {totalNode}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">{children}</CardContent>
      </Card>
    </div>
  );
}
