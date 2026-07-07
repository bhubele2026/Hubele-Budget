import { useEffect, useMemo, useRef } from "react";
import { Check, Ban, X, Sparkles, RotateCcw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  postReportsRecurringReviewSummary,
  type RecurringItem,
  type Transaction,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/stat";
import { cn, formatCurrency } from "@/lib/utils";
import {
  detectSubscriptionsFromTransactions,
  type DetectedSub,
} from "@/lib/detectedSubscriptions";

type ReviewStatus = "keep" | "cancel" | "not_sub";
type ReviewMap = Record<string, ReviewStatus>;

/** Stable key for a detected charge's verdict — name-based so the same service
 *  maps to one entry regardless of the exact spelling in a given charge. */
function reviewKey(merchant: string): string {
  return merchant.trim().toLowerCase().replace(/\s+/g, " ");
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const confidenceClass = (c: DetectedSub["confidence"]): string =>
  c === "high"
    ? "text-positive border-positive/30 bg-positive/10"
    : c === "medium"
      ? "text-warning border-warning/30 bg-warning/10"
      : "text-muted-foreground";

/**
 * Subscriptions section — a "recurring charges to review" triage. Detects
 * recurring charges from the household's transactions and surfaces only the
 * NEW ones (first seen on/after a baseline set the first time this renders), so
 * the owner reviews subscriptions going forward rather than years of history.
 * Each charge is marked Keep / Cancel / Not a subscription, saved household-wide
 * in settings.preferences (cross-device). Fable 5 narrates the queue; every
 * dollar figure is computed in our code (CLAUDE.md §1).
 */
export function SubscriptionInsightsSection({
  txns,
  catNameById,
}: {
  recurringItems: RecurringItem[] | undefined;
  txns: Transaction[] | undefined;
  catNameById: Map<string, string>;
}) {
  const { data: settings } = useGetSettings();
  const updateSettings = useUpdateSettings();
  const qc = useQueryClient();

  const reviewSince = settings?.preferences?.recurringReviewSince;
  const reviewMap = useMemo(
    () => (settings?.preferences?.recurringChargeReview ?? {}) as ReviewMap,
    [settings],
  );
  // Effective baseline — use today until the persisted value lands so the queue
  // is correct on first render.
  const since = reviewSince ?? todayISO();

  // Set the baseline once, the first time the section is seen.
  const initRef = useRef(false);
  useEffect(() => {
    if (!settings || reviewSince || initRef.current) return;
    initRef.current = true;
    const prefs = settings.preferences ?? {};
    void updateSettings
      .mutateAsync({
        data: { preferences: { ...prefs, recurringReviewSince: todayISO() } },
      })
      .then(() => qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() }));
  }, [settings, reviewSince, updateSettings, qc]);

  const detected = useMemo(
    () =>
      detectSubscriptionsFromTransactions(txns, (id) =>
        id ? catNameById.get(id) ?? null : null,
      ),
    [txns, catNameById],
  );

  // Queue = newly-appeared recurring charges (first seen on/after the baseline)
  // that haven't been given a verdict yet.
  const queue = useMemo(
    () =>
      detected.filter(
        (d) => d.firstDate >= since && !reviewMap[reviewKey(d.merchant)],
      ),
    [detected, since, reviewMap],
  );
  // Charges the owner marked "cancel" — kept visible with an undo.
  const cancelList = useMemo(
    () => detected.filter((d) => reviewMap[reviewKey(d.merchant)] === "cancel"),
    [detected, reviewMap],
  );

  const setStatus = async (d: DetectedSub, status: ReviewStatus | null) => {
    const prefs = settings?.preferences ?? {};
    const prevMap = (prefs.recurringChargeReview ?? {}) as ReviewMap;
    const nextMap: ReviewMap = { ...prevMap };
    if (status === null) delete nextMap[reviewKey(d.merchant)];
    else nextMap[reviewKey(d.merchant)] = status;
    await updateSettings.mutateAsync({
      data: {
        preferences: {
          ...prefs,
          recurringReviewSince: prefs.recurringReviewSince ?? todayISO(),
          recurringChargeReview: nextMap,
        },
      },
    });
    await qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
  };

  // Fable 5 read of the review queue. Numbers are our client-computed detection
  // facts; the model only writes the language. Keyed on the queue signature.
  const queueCharges = useMemo(
    () =>
      queue.map((d) => ({
        merchant: d.merchant,
        annual: d.annual,
        monthly: d.monthly,
        cadence: d.cadence,
        confidence: d.confidence,
      })),
    [queue],
  );
  const queueSig = queueCharges.map((c) => `${c.merchant}:${Math.round(c.annual)}`).join("|");
  const { data: fable } = useQuery({
    queryKey: ["recurring-review-summary", queueSig],
    queryFn: () => postReportsRecurringReviewSummary({ charges: queueCharges }),
    enabled: queueCharges.length > 0,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });

  return (
    <div className="space-y-3" data-testid="subscription-insights">
      <div>
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Section · Subscriptions
        </p>
        <h3 className="text-xl font-semibold">What you&rsquo;re subscribed to</h3>
        <p className="text-sm text-muted-foreground">
          New recurring charges show up here to review — keep it, cancel it, or
          tell me it&rsquo;s not a subscription.
        </p>
      </div>

      {queue.length > 0 && fable?.headline && (
        <Callout tone="info" icon={<Sparkles className="h-4 w-4" />}>
          <div className="space-y-1">
            <div className="text-sm font-bold leading-snug">{fable.headline}</div>
            {fable.bullets.length > 0 && (
              <ul className="space-y-0.5 text-[13px] font-normal text-muted-foreground">
                {fable.bullets.map((b, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
                    <span className="leading-snug">{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Callout>
      )}

      {/* Review queue */}
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 font-semibold">Recurring charges to review</div>
          {queue.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No new recurring charges to review right now — I&rsquo;ll flag new
              ones as they appear.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {queue.map((d) => (
                <div
                  key={reviewKey(d.merchant)}
                  className="flex flex-wrap items-start justify-between gap-3 py-2.5"
                  data-testid={`review-row-${reviewKey(d.merchant)}`}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{d.merchant}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge
                        variant="outline"
                        className={cn(confidenceClass(d.confidence), "capitalize")}
                      >
                        {d.confidence}
                      </Badge>
                      <span className="tabular-nums">
                        {formatCurrency(d.annual)}/yr · {formatCurrency(d.monthly)}/mo ·{" "}
                        {d.cadence}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-positive hover:bg-positive/10"
                      onClick={() => setStatus(d, "keep")}
                      data-testid={`review-keep-${reviewKey(d.merchant)}`}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" />
                      Keep
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-warning hover:bg-warning/10"
                      onClick={() => setStatus(d, "cancel")}
                      data-testid={`review-cancel-${reviewKey(d.merchant)}`}
                    >
                      <Ban className="mr-1 h-3.5 w-3.5" />
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => setStatus(d, "not_sub")}
                      data-testid={`review-notsub-${reviewKey(d.merchant)}`}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      Not a subscription
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Marked to cancel */}
      {cancelList.length > 0 && (
        <Card className="border-warning/30 bg-warning/10">
          <CardContent className="p-5">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <div className="font-semibold">Marked to cancel</div>
              <div className="text-sm font-bold tabular-nums text-warning">
                {formatCurrency(cancelList.reduce((s, d) => s + d.annual, 0))}
                <span className="text-xs font-normal text-muted-foreground">/yr</span>
              </div>
            </div>
            <div className="divide-y divide-border">
              {cancelList.map((d) => (
                <div
                  key={reviewKey(d.merchant)}
                  className="flex items-center justify-between gap-3 py-2"
                  data-testid={`cancel-row-${reviewKey(d.merchant)}`}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{d.merchant}</div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatCurrency(d.annual)}/yr · {formatCurrency(d.monthly)}/mo
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setStatus(d, null)}
                    data-testid={`cancel-undo-${reviewKey(d.merchant)}`}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    Undo
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
