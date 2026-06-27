import { Badge } from "@/components/ui/badge";
import type { PlanLine } from "@/lib/forecastMatch";

// (#456) Shared predicate: a plan row can accept a drag-to-match drop iff
// it's a still-open occurrence (pending or upcoming). Used by both the
// `PlanDropRow` visual treatment and the page-level `onDragEnd` handler so
// the rendered "blocked" state and the actual rejection logic can never
// drift apart.
export function isPlanRowMatchEligible(row: Pick<PlanLine, "status">): boolean {
  return row.status === "pending_plan" || row.status === "future";
}

export function statusBadge(s: string) {
  const map: Record<string, { label: string; cls: string }> = {
    pending_plan: { label: "Pending plan", cls: "bg-warning/15 text-warning border-warning/30" },
    pending_bank: { label: "Pending bank", cls: "bg-[hsl(var(--chart-2)/0.15)] text-[hsl(var(--chart-2))] border-[hsl(var(--chart-2)/0.3)]" },
    future: { label: "Upcoming", cls: "bg-muted text-muted-foreground" },
    matched: { label: "Matched", cls: "bg-primary/15 text-primary border-primary/30" },
    missed: { label: "Missed", cls: "bg-destructive/10 text-destructive border-destructive/30" },
    rescheduled: { label: "Rescheduled", cls: "bg-primary/15 text-primary border-primary/30" },
    ignored_unforecasted: { label: "Unplanned", cls: "bg-muted text-muted-foreground" },
    unplanned: { label: "Unplanned", cls: "bg-muted text-muted-foreground" },
  };
  const v = map[s] ?? { label: s, cls: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={v.cls}>{v.label}</Badge>;
}
