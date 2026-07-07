import { useMemo } from "react";
import { TrendingUp, Copy, Ban } from "lucide-react";
import {
  type RecurringItem,
  type Transaction,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { computeSubscriptionInsights } from "@/lib/subscriptionInsights";
import { useToCancelList, toCancelKey } from "@/hooks/useToCancelList";

/** Compact button that flags a subscription onto the "To cancel" list (or
 *  un-flags it). */
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

/**
 * Subscriptions section for Reports → Behavior (and the Command Center). Shows
 * the "Set up as recurring" card: cost / price-increase / duplicate insights for
 * the subscriptions the user explicitly added.
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

  const toCancel = useToCancelList();

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

      {/* Subscriptions explicitly set up as recurring items */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 font-semibold">Set up as recurring</div>
          {insights.count === 0 ? (
            <p className="text-sm text-muted-foreground">
              You haven&rsquo;t added any subscriptions as recurring items yet.
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
