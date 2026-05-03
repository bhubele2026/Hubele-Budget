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
  containerRef,
  children,
}: {
  dayKey: string;
  count: number;
  isToday: boolean;
  totalNode: ReactNode;
  selectionState: boolean | "indeterminate";
  onToggleAll: (on: boolean) => void;
  todayAccent?: "blue" | "emerald";
  containerRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const todayBorder =
    todayAccent === "emerald" ? "border-emerald-300 bg-emerald-50/80" : "border-blue-300 bg-blue-50/80";
  const todayBadge =
    todayAccent === "emerald"
      ? "border-emerald-300 text-emerald-700 bg-emerald-50"
      : "border-blue-300 text-blue-700 bg-blue-50";
  return (
    <div ref={containerRef} className="space-y-2">
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center justify-between gap-3 rounded-md border bg-background/95 backdrop-blur px-3 py-2",
          isToday && todayBorder,
        )}
      >
        <div className="flex items-center gap-3">
          <Checkbox
            checked={selectionState}
            onCheckedChange={(v) => onToggleAll(!!v)}
            aria-label="Select day"
          />
          <div className="font-semibold text-sm">{formatDayHeader(dayKey)}</div>
          {isToday && (
            <Badge variant="outline" className={cn("text-[10px]", todayBadge)}>
              Today
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
