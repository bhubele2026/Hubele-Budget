import { useMemo } from "react";
import { TrendingUp, Copy } from "lucide-react";
import type { RecurringItem, Transaction } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { computeSubscriptionInsights } from "@/lib/subscriptionInsights";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Subscriptions section for the Reports → Behavior tab. Surfaces the
 * yearly cost of every true subscription, flags likely price increases and
 * duplicates, and notes services with no recent charge. Pure-derived from
 * the household's recurring items + ~1y of transactions (passed in by the
 * parent, so no extra fetch).
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

      <Card>
        <CardContent className="p-5">
          {insights.count === 0 ? (
            <p className="text-sm text-muted-foreground">
              No subscriptions detected yet. Recurring services you add (Netflix,
              Spotify, a gym, software) will show up here with their yearly cost.
            </p>
          ) : (
            <div className="space-y-4">
              {/* Hero: annual total + alert chips */}
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
                      className="text-amber-700 border-amber-300 bg-amber-50"
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

              {/* Per-subscription list, priciest first */}
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
                            className="gap-1 text-amber-700 border-amber-300 bg-amber-50"
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
