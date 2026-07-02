import { useMemo } from "react";
import {
  ThumbsUp,
  AlertTriangle,
  Ban,
  Ghost,
} from "lucide-react";
import {
  useGetBankingInsightsSummary,
  getGetBankingInsightsSummaryQueryKey,
  type BudgetMonthDetail,
  type DashboardSummaryTopCategoriesItem,
  type Transaction,
  type BankingInsightsBucketCaption,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader } from "@/components/stat";
import { PillBadge, type PillTone } from "@/components/pill-badge";
import { MoneyText } from "@/components/viz";
import { cn, formatCurrency } from "@/lib/utils";
import { detectSubscriptionsFromTransactions } from "@/lib/detectedSubscriptions";
import { makeRecurringMatcher } from "@/lib/discretionarySpend";

/** One row inside a bucket — a name and the dollar figure our code computed. */
type BucketRow = { key: string; name: string; sub?: string; amount: number };

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * The four Banking insight buckets. EVERY dollar figure here is computed in
 * this component from data the page already loads (budget plan-vs-actual,
 * the subscription detector, the 90-day transaction window) — the AI only
 * supplies the headline + one-line caption per bucket (with a deterministic
 * server-side fallback), per the "model never does arithmetic" rule.
 */
export function BankingInsights({
  budgetMonth,
  topCategories,
  txns,
  recurringNames,
  catNameById,
  momCompare,
  streak,
}: {
  budgetMonth: BudgetMonthDetail | undefined;
  topCategories: DashboardSummaryTopCategoriesItem[] | undefined;
  txns: Transaction[] | undefined;
  recurringNames: string[];
  catNameById: Map<string, string>;
  momCompare: { cur: number; last: number; pctChange: number | null };
  streak: { weeks: number; direction: "under" | "over" | "none" };
}) {
  // Captions: computed server-side from the same household data and written
  // by the advisor (Fable 5) — deterministic fallback when AI is off.
  const { data: captions } = useGetBankingInsightsSummary(undefined, {
    query: {
      queryKey: getGetBankingInsightsSummaryQueryKey(),
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
    },
  });

  // ── Bucket math (all client-side, all from data already on the page) ────
  const expenseLines = useMemo(
    () => (budgetMonth?.lines ?? []).filter((l) => l.kind !== "income"),
    [budgetMonth],
  );

  // ✅ Going well — categories UNDER budget this month (plan > 0, actual < plan).
  const underBudget = useMemo<BucketRow[]>(
    () =>
      expenseLines
        .filter((l) => num(l.plannedAmount) > 0 && num(l.actualAmount) < num(l.plannedAmount))
        .map((l) => ({
          key: l.categoryId,
          name: l.categoryName,
          sub: `${formatCurrency(num(l.actualAmount))} of ${formatCurrency(num(l.plannedAmount))}`,
          amount: num(l.plannedAmount) - num(l.actualAmount),
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 4),
    [expenseLines],
  );

  // ⚠️ Could improve — categories OVER budget, biggest overspends first.
  const overBudget = useMemo<BucketRow[]>(
    () =>
      expenseLines
        .filter((l) => num(l.plannedAmount) > 0 && num(l.actualAmount) > num(l.plannedAmount))
        .map((l) => ({
          key: l.categoryId,
          name: l.categoryName,
          sub: `${formatCurrency(num(l.actualAmount))} against ${formatCurrency(num(l.plannedAmount))}`,
          amount: num(l.actualAmount) - num(l.plannedAmount),
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 4),
    [expenseLines],
  );

  // 🚫 Cancel these — the existing detector, straight off the page's txns.
  const detected = useMemo(
    () =>
      detectSubscriptionsFromTransactions(txns, (id) =>
        id ? catNameById.get(id) ?? null : null,
      ).filter((d) => d.confidence !== "low"),
    [txns, catNameById],
  );
  const cancelRows = useMemo<BucketRow[]>(
    () =>
      detected.slice(0, 4).map((d) => ({
        key: d.merchant,
        name: d.merchant,
        sub: `${formatCurrency(d.typical)} · ${d.cadence}`,
        amount: d.annual,
      })),
    [detected],
  );
  const cancelAnnualTotal = useMemo(
    () => detected.reduce((s, d) => s + d.annual, 0),
    [detected],
  );

  // 💸 Paying for, not in the budget — detected recurring charges that were
  // never set up as bills, plus categories with real spend but no budget line.
  const isTracked = useMemo(() => makeRecurringMatcher(recurringNames), [recurringNames]);
  const untrackedRecurring = useMemo<BucketRow[]>(
    () =>
      detected
        .filter((d) => !isTracked(d.merchant))
        .slice(0, 3)
        .map((d) => ({
          key: `sub-${d.merchant}`,
          name: d.merchant,
          sub: "recurring, never set up as a bill",
          amount: d.monthly,
        })),
    [detected, isTracked],
  );
  const unbudgetedCategories = useMemo<BucketRow[]>(() => {
    // Prefer the budget month's own lines (server-truth actuals): spend with
    // a $0 plan. Fall back to top spend categories with no budget line.
    const zeroPlanned = expenseLines
      .filter((l) => num(l.plannedAmount) === 0 && num(l.actualAmount) > 0)
      .map((l) => ({
        key: `cat-${l.categoryId}`,
        name: l.categoryName,
        sub: "spent this month, no budget line",
        amount: num(l.actualAmount),
      }));
    if (zeroPlanned.length > 0 || !topCategories?.length) {
      return zeroPlanned.sort((a, b) => b.amount - a.amount).slice(0, 3);
    }
    const budgeted = new Set(
      (budgetMonth?.lines ?? [])
        .filter((l) => num(l.plannedAmount) > 0)
        .map((l) => l.categoryName.toLowerCase()),
    );
    return topCategories
      .filter((c) => !budgeted.has(c.categoryName.toLowerCase()))
      .map((c) => ({
        key: `cat-${c.categoryName}`,
        name: c.categoryName,
        sub: "spent this month, no budget line",
        amount: num(c.total),
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3);
  }, [expenseLines, budgetMonth, topCategories]);
  const notInBudgetRows = useMemo(
    () => [...untrackedRecurring, ...unbudgetedCategories].slice(0, 4),
    [untrackedRecurring, unbudgetedCategories],
  );

  const goingWellChips: string[] = [];
  if (momCompare.pctChange != null && momCompare.pctChange < 0)
    goingWellChips.push(`${Math.abs(Math.round(momCompare.pctChange))}% less than last month`);
  if (streak.direction === "under" && streak.weeks >= 2)
    goingWellChips.push(`${streak.weeks} weeks under the cap`);

  return (
    <div className="space-y-3" data-testid="banking-insights">
      <SectionHeader
        eyebrow="Section · Insights"
        title="The four buckets"
        sub="What's working, what's leaking, what to kill. Numbers from your data; the mouth is the advisor's."
      />
      <div className="grid gap-4 sm:grid-cols-2 stagger-children">
        <BucketCard
          icon={<ThumbsUp className="h-4 w-4" />}
          title="Going well"
          tone="good"
          caption={captions?.goingWell}
          fallbackHeadline="The wins"
          fallbackCaption={
            underBudget.length
              ? "These categories are still under plan this month."
              : "No category is under budget yet this month."
          }
          rows={underBudget}
          amountClass="text-positive"
          amountSuffix="left"
          chips={goingWellChips}
          empty="No wins on the board yet. Fix that."
        />
        <BucketCard
          icon={<AlertTriangle className="h-4 w-4" />}
          title="Could improve"
          tone="warning"
          caption={captions?.couldImprove}
          fallbackHeadline="The budget-busters"
          fallbackCaption={
            overBudget.length
              ? "Biggest overspends against this month's plan."
              : "Every budgeted category is at or under plan."
          }
          rows={overBudget}
          amountClass="text-[hsl(var(--negative))]"
          amountSuffix="over"
          empty="Nothing over budget. Shockingly."
        />
        <BucketCard
          icon={<Ban className="h-4 w-4" />}
          title="Cancel these"
          tone="danger"
          caption={captions?.cancelThese}
          fallbackHeadline="Subscription bleed"
          fallbackCaption={
            detected.length
              ? `Detected recurring charges worth ${formatCurrency(cancelAnnualTotal)}/yr. Full hit list below.`
              : "No recurring subscription-looking charges detected."
          }
          rows={cancelRows}
          amountClass="text-[hsl(var(--negative))]"
          amountSuffix="/yr"
          footer={
            detected.length > 0
              ? `${detected.length} detected · ${formatCurrency(cancelAnnualTotal)}/yr total — flag them in the list below`
              : undefined
          }
          empty="No subscription leaks found."
        />
        <BucketCard
          icon={<Ghost className="h-4 w-4" />}
          title="Paying for, not in the budget"
          tone="warning"
          caption={captions?.notInBudget}
          fallbackHeadline="Money with no plan"
          fallbackCaption={
            notInBudgetRows.length
              ? "Recurring charges never set up as bills, and spend with no budget line."
              : "Everything recurring is tracked and budgeted."
          }
          rows={notInBudgetRows}
          amountClass="text-[hsl(var(--warning))]"
          empty="Everything's accounted for. Rare."
        />
      </div>
    </div>
  );
}

function BucketCard({
  icon,
  title,
  tone,
  caption,
  fallbackHeadline,
  fallbackCaption,
  rows,
  amountClass,
  amountSuffix,
  chips,
  footer,
  empty,
}: {
  icon: React.ReactNode;
  title: string;
  tone: PillTone;
  caption: BankingInsightsBucketCaption | undefined;
  fallbackHeadline: string;
  fallbackCaption: string;
  rows: BucketRow[];
  amountClass: string;
  amountSuffix?: string;
  chips?: string[];
  footer?: string;
  empty: string;
}) {
  const headline = caption?.headline?.trim() || fallbackHeadline;
  const line = caption?.caption?.trim() || fallbackCaption;
  return (
    <Card className="h-full">
      <CardContent className="p-5 flex h-full flex-col">
        <div className="flex items-center justify-between gap-2">
          <PillBadge tone={tone}>
            <span className="inline-flex items-center gap-1.5 normal-case tracking-normal text-[11px]">
              {icon}
              {title}
            </span>
          </PillBadge>
        </div>
        <div className="mt-2.5 text-base font-bold tracking-tight leading-snug">
          {headline}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground leading-snug">{line}</p>
        {chips && chips.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <PillBadge key={c} tone="good" dot={false}>
                {c}
              </PillBadge>
            ))}
          </div>
        ) : null}
        <div className="mt-3 divide-y divide-border">
          {rows.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">{empty}</p>
          ) : (
            rows.map((r) => (
              <div
                key={r.key}
                className="flex items-center justify-between gap-3 py-2"
                data-testid={`bucket-row-${r.key}`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{r.name}</div>
                  {r.sub ? (
                    <div className="text-xs text-muted-foreground tabular-nums truncate">
                      {r.sub}
                    </div>
                  ) : null}
                </div>
                <div className={cn("shrink-0 text-sm font-semibold tabular-nums", amountClass)}>
                  <MoneyText amount={r.amount} abs />
                  {amountSuffix ? (
                    <span className="ml-1 text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                      {amountSuffix}
                    </span>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
        {footer ? (
          <div className="mt-auto pt-3 text-xs text-muted-foreground">{footer}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
