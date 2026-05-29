// (#826) Avalanche extra-payment schedule card for /forecast.
//
// Replaces the static single-number "MAX SAFE EXTRA PAYMENT" tile with a
// multi-date schedule: 4-12 dated payments (amount, rationale, confidence
// badge), a Claude-written summary naming the real avalanche-target debt,
// a footer total, and a Refresh button that forces a fresh AI call.
//
// Numbers are deterministic (server-computed). When the AI narrative is
// unavailable, the server falls back to a deterministic template and sets
// summarySource === "fallback", which we surface as a small note.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  useGetForecastAvalancheSchedule,
  getForecastAvalancheSchedule,
  getGetForecastAvalancheScheduleQueryKey,
} from "@workspace/api-client-react";
import { Mountain, RefreshCw, Info, ChevronDown, ChevronUp } from "lucide-react";

const CONFIDENCE_META = {
  high: {
    label: "High",
    className:
      "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400",
  },
  medium: {
    label: "Medium",
    className:
      "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400",
  },
  low: {
    label: "Low",
    className:
      "border-destructive/50 text-destructive dark:border-destructive/60",
  },
} as const;

export function AvalancheScheduleCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetForecastAvalancheSchedule();
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // Force a fresh Anthropic regeneration, then prime the cache so the
      // hook re-renders with the new narrative.
      const fresh = await getForecastAvalancheSchedule({ refresh: "true" });
      qc.setQueryData(getGetForecastAvalancheScheduleQueryKey(), fresh);
    } catch {
      // Surface nothing fancy — leave the existing schedule on screen and
      // let a manual retry happen. The button re-enables in finally.
      await qc.invalidateQueries({
        queryKey: getGetForecastAvalancheScheduleQueryKey(),
      });
    } finally {
      setRefreshing(false);
    }
  }

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
  const fallback = data.summarySource === "fallback";

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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            data-testid="button-refresh-avalanche-schedule"
            className="shrink-0"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`}
            />
            {refreshing ? "Refreshing" : "Refresh"}
          </Button>
        </div>

        {/* AI summary */}
        <p
          className="text-sm leading-relaxed text-foreground/90"
          data-testid="text-avalanche-summary"
        >
          {data.summary}
        </p>
        {fallback && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5" />
            AI summary unavailable — showing a computed plan.
          </div>
        )}

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
                    const label = data.paymentsText?.[i];
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
                            {label ?? p.rationale}
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
                  <span className="font-serif font-bold tabular-nums text-primary">
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
