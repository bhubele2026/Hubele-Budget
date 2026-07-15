// (#826) Avalanche extra-payment schedule card for /forecast.
//
// A multi-date extra-payment schedule: 4-12 dated payments (amount, rationale,
// confidence badge), the avalanche-target debt, and a footer total. All numbers
// are deterministic (server-computed).

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useGetForecastAvalancheSchedule } from "@workspace/api-client-react";
import { Mountain, ChevronDown, ChevronUp } from "lucide-react";

const CONFIDENCE_META = {
  high: {
    label: "High",
    className:
      "border-positive/40 text-positive",
  },
  medium: {
    label: "Medium",
    className:
      "border-warning/40 text-warning",
  },
  low: {
    label: "Low",
    className:
      "border-destructive/50 text-destructive dark:border-destructive/60",
  },
} as const;

export function AvalancheScheduleCard() {
  const { data, isLoading } = useGetForecastAvalancheSchedule();
  const [expanded, setExpanded] = useState(false);

  if (isLoading || !data) {
    return (
      <Card data-testid="card-avalanche-schedule">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-8 w-20" />
          </div>
          <Skeleton className="h-12 w-full" />
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="h-4 w-56" />
        </CardContent>
      </Card>
    );
  }

  const payments = data.proposedPayments ?? [];
  const hasPayments = payments.length > 0;
  const target = data.currentAvalancheTarget;

  return (
    <Card className="border-2" data-testid="card-avalanche-schedule">
      <CardContent className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Mountain className="w-5 h-5 text-primary" />
            <div>
              <div className="text-xs font-bold tracking-widest uppercase text-primary">
                Avalanche Schedule
              </div>
              {target && (
                <div className="text-xs text-muted-foreground">
                  Targeting{" "}
                  <span className="font-medium text-foreground">
                    {target.debtName}
                  </span>{" "}
                  · {(target.apr * 100).toFixed(2)}% APR
                </div>
              )}
            </div>
          </div>
        </div>

        <Separator />

        {/* Payment schedule (collapsed by default) */}
        {hasPayments ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              data-testid="button-toggle-avalanche-schedule"
              className="flex w-full items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>
                {payments.length} payment{payments.length === 1 ? "" : "s"}{" "}
                totaling{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {formatCurrency(data.totalProposed)}
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-medium text-foreground">
                {expanded ? "Hide schedule" : "Show schedule"}
              </span>
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>

            {expanded && (
              <>
                <ul
                  className="space-y-2"
                  data-testid="list-avalanche-payments"
                >
                  {payments.map((p, i) => {
                    const meta = CONFIDENCE_META[p.confidence];
                    return (
                      <li
                        key={`${p.date}-${i}`}
                        className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3"
                        data-testid={`row-avalanche-payment-${i}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold tabular-nums">
                              {formatCurrency(p.amount)}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatDate(p.date)}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {p.rationale}
                          </div>
                        </div>
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[10px] ${meta.className}`}
                        >
                          {meta.label}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>

                {/* Footer total */}
                <Separator />
                <div
                  className="flex items-center justify-between text-sm"
                  data-testid="text-avalanche-total"
                >
                  <span className="text-muted-foreground">
                    Total across {payments.length} payment
                    {payments.length === 1 ? "" : "s"}
                    {data.scheduleThroughDate && (
                      <> through {formatDate(data.scheduleThroughDate)}</>
                    )}
                  </span>
                  <span className="font-bold tabular-nums text-primary">
                    {formatCurrency(data.totalProposed)}
                  </span>
                </div>
              </>
            )}
          </div>
        ) : (
          <div
            className="text-sm text-muted-foreground"
            data-testid="text-avalanche-empty"
          >
            No safe extra-payment windows over the next 12 months. Keep an eye
            on your projected balance — windows open up as bills clear.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
