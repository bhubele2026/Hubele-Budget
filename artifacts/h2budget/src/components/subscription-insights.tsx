import { useMemo } from "react";
import { TrendingUp, Copy, Ban, X, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateRecurringItem,
  getGetBillsSummaryQueryKey,
  getListRecurringItemsQueryKey,
  type RecurringItem,
  type Transaction,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn, formatCurrency } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { computeSubscriptionInsights } from "@/lib/subscriptionInsights";
import {
  detectSubscriptionsFromTransactions,
  type DetectedSub,
} from "@/lib/detectedSubscriptions";
import { useToCancelList, toCancelKey } from "@/hooks/useToCancelList";

/** Map a detected cadence label to a recurring-item frequency string. */
const CADENCE_TO_FREQUENCY: Record<string, string> = {
  weekly: "weekly",
  biweekly: "biweekly",
  monthly: "monthly",
  "every 2 months": "monthly",
  quarterly: "quarterly",
  "twice a year": "yearly",
  yearly: "yearly",
};

/** Compact button that flags a subscription onto the "To cancel" list (or
 *  un-flags it). Kept here so both row types render an identical control. */
function ToCancelButton({
  marked,
  onToggle,
}: {
  marked: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant={marked ? "secondary" : "ghost"}
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={onToggle}
      data-testid="button-to-cancel"
      title={
        marked
          ? "On your To-cancel list — click to remove"
          : "Add to your To-cancel list"
      }
    >
      <Ban className="w-3.5 h-3.5 mr-1.5" />
      {marked ? "On list" : "To cancel"}
    </Button>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const fmtShort = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

const confidenceClass = (c: DetectedSub["confidence"]): string =>
  c === "high"
    ? "text-positive border-positive/30 bg-positive/10"
    : c === "medium"
      ? "text-warning border-warning/30 bg-warning/10"
      : "text-muted-foreground";

/**
 * Subscriptions section for Reports → Behavior. Two cards:
 *  1. "Found in your spending" — likely subscriptions detected from raw
 *     transaction patterns (same merchant, steady amount, regular cadence),
 *     including ones never set up as recurring items.
 *  2. "Set up as recurring" — cost / price-increase / duplicate insights for
 *     the subscriptions the user explicitly added.
 *
 * Pure-derived from data the parent already loads (recurring items + ~1y of
 * transactions), so no extra fetch.
 */
export function SubscriptionInsightsSection({
  recurringItems,
  txns,
  catNameById,
}: {
  recurringItems: RecurringItem[] | undefined;
  txns: Transaction[] | undefined;
  catNameById: Map<string, string>;
}) {
  const detected = useMemo(
    () =>
      detectSubscriptionsFromTransactions(txns, (id) =>
        id ? catNameById.get(id) ?? null : null,
      ),
    [txns, catNameById],
  );
  const insights = useMemo(
    () =>
      computeSubscriptionInsights(
        recurringItems,
        txns,
        (id) => (id ? catNameById.get(id) ?? null : null),
        new Date(),
      ),
    [recurringItems, txns, catNameById],
  );

  const detectedAnnual = detected
    .filter((d) => d.confidence !== "low")
    .reduce((s, d) => s + d.annual, 0);

  const toCancel = useToCancelList();

  // (#set-up) Promote a detected recurring charge to a tracked recurring item
  // (so it shows up in Bills / Forecast). Maps the detected cadence + amount.
  const createRecurring = useCreateRecurringItem();
  const qc = useQueryClient();
  const { toast } = useToast();
  const setupRecurring = (d: DetectedSub) => {
    createRecurring.mutate(
      {
        data: {
          name: d.merchant,
          kind: "subscription",
          amount: d.typical.toFixed(2),
          frequency: CADENCE_TO_FREQUENCY[d.cadence] ?? "monthly",
          anchorDate: d.nextDate ?? d.lastDate,
          active: "true",
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListRecurringItemsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
          toast({ title: `Now tracking ${d.merchant} as recurring` });
        },
        onError: (e: unknown) => {
          toast({
            title: "Couldn't set it up",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        },
      },
    );
  };

  // Annual savings still on the table = items flagged but not yet cancelled.
  const pendingCancelAnnual = toCancel.items
    .filter((i) => !i.cancelled)
    .reduce((s, i) => s + i.annual, 0);
  const cancelledAnnual = toCancel.items
    .filter((i) => i.cancelled)
    .reduce((s, i) => s + i.annual, 0);

  return (
    <div className="space-y-3" data-testid="subscription-insights">
      <div>
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Section · Subscriptions
        </p>
        <h3 className="text-xl font-semibold">What you&rsquo;re subscribed to</h3>
        <p className="text-sm text-muted-foreground">
          The yearly bite of every recurring service — where the quiet money goes.
        </p>
      </div>

      {/* To-cancel bucket — the user's shortlist, with a check-off once
          actually cancelled. Only shown once something has been flagged. */}
      {toCancel.items.length > 0 && (
        <Card
          className="border-warning/30 bg-warning/10"
          data-testid="to-cancel-bucket"
        >
          <CardContent className="p-5">
            <div className="mb-3 flex items-baseline justify-between flex-wrap gap-2">
              <div>
                <div className="font-semibold">To cancel</div>
                <p className="text-sm text-muted-foreground">
                  Tick each one off once you&rsquo;ve actually cancelled it.
                </p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold tabular-nums text-warning">
                  {formatCurrency(pendingCancelAnnual)}
                  <span className="text-sm font-normal text-muted-foreground">
                    /yr
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  still to cancel
                  {cancelledAnnual > 0 &&
                    ` · ${formatCurrency(cancelledAnnual)}/yr cancelled`}
                </div>
              </div>
            </div>
            <div className="divide-y divide-border">
              {toCancel.items.map((i) => (
                <div
                  key={i.key}
                  className="flex items-center gap-3 py-2.5"
                  data-testid={`to-cancel-row-${i.key}`}
                  data-cancelled={i.cancelled ? "true" : "false"}
                >
                  <Checkbox
                    checked={i.cancelled}
                    onCheckedChange={() => toCancel.toggleCancelled(i.key)}
                    aria-label="Mark cancelled"
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "font-medium truncate",
                        i.cancelled && "line-through text-muted-foreground",
                      )}
                    >
                      {i.name}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatCurrency(i.monthly)}/mo · {formatCurrency(i.annual)}
                      /yr
                    </div>
                  </div>
                  {i.cancelled && (
                    <Badge
                      variant="outline"
                      className="text-positive border-positive/30 bg-positive/10"
                    >
                      Cancelled
                    </Badge>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => toCancel.remove(i.key)}
                    aria-label="Remove from list"
                    data-testid={`to-cancel-remove-${i.key}`}
                  >
                    <X className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Card 1 — detected from raw spending */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <div className="font-semibold">Found in your spending</div>
              <p className="text-sm text-muted-foreground">
                Recurring charges that look like subscriptions — including ones
                you haven&rsquo;t set up. Auto-detected from the last year of
                transactions.
              </p>
            </div>
            {detectedAnnual > 0 && (
              <div className="text-right">
                <div className="text-2xl font-bold tabular-nums">
                  {formatCurrency(detectedAnnual)}
                  <span className="text-sm font-normal text-muted-foreground">
                    /yr
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  likely subscriptions
                </div>
              </div>
            )}
          </div>
          {detected.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recurring same-amount charges found in your transactions.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {detected.map((d) => (
                <div
                  key={`${d.merchant}-${d.cadence}`}
                  className="flex items-start justify-between gap-3 py-2.5"
                  data-testid={`detected-sub-${d.merchant}`}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{d.merchant}</div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                      <Badge
                        variant="outline"
                        className={`${confidenceClass(d.confidence)} capitalize`}
                      >
                        {d.confidence}
                      </Badge>
                      <span className="tabular-nums">
                        {formatCurrency(d.typical)} · {d.cadence} · ×{d.count}
                      </span>
                      {d.nextDate && (
                        <span className="tabular-nums">
                          · next ~{fmtShort(d.nextDate)}
                        </span>
                      )}
                      {d.amountVaries && (
                        <span className="text-warning">amount varies</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-semibold tabular-nums">
                      {formatCurrency(d.annual)}
                      <span className="text-xs font-normal text-muted-foreground">
                        /yr
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatCurrency(d.monthly)}/mo
                    </div>
                    {(() => {
                      const key = toCancelKey(d.merchant);
                      const marked = toCancel.has(key);
                      return (
                        <div className="mt-1.5 flex justify-end gap-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setupRecurring(d)}
                            disabled={createRecurring.isPending}
                            title="Track this as a recurring item (Bills + Forecast)"
                            data-testid={`button-setup-recurring-${d.merchant}`}
                          >
                            <Plus className="w-3.5 h-3.5 mr-1" />
                            Set up
                          </Button>
                          <ToCancelButton
                            marked={marked}
                            onToggle={() =>
                              marked
                                ? toCancel.remove(key)
                                : toCancel.add({
                                    key,
                                    name: d.merchant,
                                    monthly: d.annual / 12,
                                    annual: d.annual,
                                  })
                            }
                          />
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 2 — subscriptions explicitly set up as recurring items */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 font-semibold">Set up as recurring</div>
          {insights.count === 0 ? (
            <p className="text-sm text-muted-foreground">
              You haven&rsquo;t added any subscriptions as recurring items yet.
              The list above is detected straight from your spending.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <div>
                  <div
                    className="text-3xl font-bold tabular-nums"
                    data-testid="subs-annual-total"
                  >
                    {formatCurrency(insights.annualTotal)}
                    <span className="text-base font-normal text-muted-foreground">
                      /yr
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground tabular-nums">
                    {formatCurrency(insights.monthlyTotal)}/mo ·{" "}
                    {plural(insights.count, "subscription")}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {insights.priceIncreases.length > 0 && (
                    <Badge
                      variant="outline"
                      className="text-warning border-warning/30 bg-warning/10"
                    >
                      {plural(insights.priceIncreases.length, "price increase")}
                    </Badge>
                  )}
                  {insights.duplicateGroups.length > 0 && (
                    <Badge variant="outline">
                      {plural(insights.duplicateGroups.length, "possible duplicate")}
                    </Badge>
                  )}
                  {insights.noRecentCharge.length > 0 && (
                    <Badge variant="outline" className="text-muted-foreground">
                      {insights.noRecentCharge.length} with no recent charge
                    </Badge>
                  )}
                </div>
              </div>
              <div className="divide-y divide-border">
                {insights.items.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-start justify-between gap-3 py-2.5"
                    data-testid={`sub-row-${s.id}`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{s.name}</div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        {s.priceChange && (
                          <Badge
                            variant="outline"
                            className="gap-1 text-warning border-warning/30 bg-warning/10"
                            title="The latest charge is higher than before"
                          >
                            <TrendingUp className="w-3 h-3" />
                            {formatCurrency(s.priceChange.from)} →{" "}
                            {formatCurrency(s.priceChange.to)}
                          </Badge>
                        )}
                        {s.duplicateIds.length > 0 && (
                          <Badge variant="outline" className="gap-1">
                            <Copy className="w-3 h-3" />
                            Possible duplicate
                          </Badge>
                        )}
                        {s.noRecentCharge && (
                          <Badge
                            variant="outline"
                            className="text-muted-foreground"
                            title="No matching charge found recently — is it still active?"
                          >
                            No recent charge
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold tabular-nums">
                        {formatCurrency(s.annual)}
                        <span className="text-xs font-normal text-muted-foreground">
                          /yr
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {formatCurrency(s.monthly)}/mo
                      </div>
                      {(() => {
                        const key = toCancelKey(s.name);
                        const marked = toCancel.has(key);
                        return (
                          <div className="mt-1.5 flex justify-end">
                            <ToCancelButton
                              marked={marked}
                              onToggle={() =>
                                marked
                                  ? toCancel.remove(key)
                                  : toCancel.add({
                                      key,
                                      name: s.name,
                                      monthly: s.monthly,
                                      annual: s.annual,
                                    })
                              }
                            />
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
