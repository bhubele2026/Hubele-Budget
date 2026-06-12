import { useMemo } from "react";
import { TrendingUp, Copy } from "lucide-react";
import type { RecurringItem, Transaction } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { computeSubscriptionInsights } from "@/lib/subscriptionInsights";
import {
  detectSubscriptionsFromTransactions,
  type DetectedSub,
} from "@/lib/detectedSubscriptions";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const confidenceClass = (c: DetectedSub["confidence"]): string =>
  c === "high"
    ? "text-emerald-700 border-emerald-300 bg-emerald-50"
    : c === "medium"
      ? "text-amber-700 border-amber-300 bg-amber-50"
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
    () => detectSubscriptionsFromTransactions(txns),
    [txns],
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
                      {d.amountVaries && (
                        <span className="text-amber-700">amount varies</span>
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
                    <div className="text-xs text-muted-foreground">
                      last {d.lastDate}
                    </div>
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
