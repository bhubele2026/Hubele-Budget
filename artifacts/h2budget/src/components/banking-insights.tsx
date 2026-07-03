import { useCallback, useMemo } from "react";
import {
  ThumbsUp,
  AlertTriangle,
  Ban,
  Ghost,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBankingInsightsSummary,
  getGetBankingInsightsSummaryQueryKey,
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
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
import { expenseMagnitude } from "@/lib/bucketSpend";

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

  // ✅ Going well — categories where you're spending LESS this month than at the
  // SAME point last month (real behavioural wins, e.g. "Dining down $45"). This
  // deliberately excludes transfers / card payments / debt so it never shows an
  // unpaid bill (mortgage, loan) as a "win" — those aren't spending you improved.
  const spentLessRows = useMemo<BucketRow[]>(() => {
    const list = txns ?? [];
    const now = new Date();
    const curM = now.getMonth();
    const curY = now.getFullYear();
    const lastRef = new Date(curY, curM - 1, 1);
    const lastM = lastRef.getMonth();
    const lastY = lastRef.getFullYear();
    const throughDay = now.getDate();
    const cur = new Map<string, number>();
    const last = new Map<string, number>();
    for (const t of list) {
      if (!t.occurredOn) continue;
      if (t.isTransfer || t.isExternalCardPayment || t.debtId || t.reimbursable)
        continue;
      const spend = expenseMagnitude(t);
      if (spend <= 0) continue;
      const d = new Date(t.occurredOn + "T00:00:00");
      if (d.getDate() > throughDay) continue; // month-to-date, like-for-like
      const cid = t.categoryId ?? "_uncat";
      if (d.getFullYear() === curY && d.getMonth() === curM)
        cur.set(cid, (cur.get(cid) ?? 0) + spend);
      else if (d.getFullYear() === lastY && d.getMonth() === lastM)
        last.set(cid, (last.get(cid) ?? 0) + spend);
    }
    const rows: BucketRow[] = [];
    for (const [cid, lastAmt] of last) {
      const curAmt = cur.get(cid) ?? 0;
      const drop = lastAmt - curAmt;
      if (drop > 0.5)
        rows.push({
          key: cid,
          name:
            cid === "_uncat"
              ? "Uncategorized"
              : catNameById.get(cid) ?? "Uncategorized",
          sub: `${formatCurrency(curAmt)} vs ${formatCurrency(lastAmt)} last month`,
          amount: drop,
        });
    }
    return rows.sort((a, b) => b.amount - a.amount).slice(0, 12);
  }, [txns, catNameById]);

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
        .slice(0, 12),
    [expenseLines],
  );

  // Dismissed detected-subs — the user already cancelled these in real life, so
  // hide them one at a time. Persisted per household in settings.preferences
  // (mirrors the amexExcludedTxnIds pattern), keyed by merchant name.
  const { data: settings } = useGetSettings();
  const updateSettings = useUpdateSettings();
  const qc = useQueryClient();
  const dismissedSubs = useMemo(
    () =>
      new Set(
        (settings?.preferences?.dismissedDetectedSubs as string[] | undefined) ??
          [],
      ),
    [settings],
  );
  const dismissSub = useCallback(
    async (merchant: string) => {
      const prefs = settings?.preferences ?? {};
      const cur = new Set(
        (prefs.dismissedDetectedSubs as string[] | undefined) ?? [],
      );
      cur.add(merchant);
      await updateSettings.mutateAsync({
        data: { preferences: { ...prefs, dismissedDetectedSubs: [...cur] } },
      });
      await qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
    },
    [settings, updateSettings, qc],
  );

  // 🚫 Cancel these — the existing detector, straight off the page's txns,
  // minus anything the user has dismissed.
  const detected = useMemo(
    () =>
      detectSubscriptionsFromTransactions(txns, (id) =>
        id ? catNameById.get(id) ?? null : null,
      )
        .filter((d) => d.confidence !== "low")
        .filter((d) => !dismissedSubs.has(d.merchant)),
    [txns, catNameById, dismissedSubs],
  );
  const cancelRows = useMemo<BucketRow[]>(
    () =>
      detected.slice(0, 12).map((d) => ({
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
        .slice(0, 8)
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
      return zeroPlanned.sort((a, b) => b.amount - a.amount).slice(0, 8);
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
      .slice(0, 8);
  }, [expenseLines, budgetMonth, topCategories]);
  const notInBudgetRows = useMemo(
    () => [...untrackedRecurring, ...unbudgetedCategories].slice(0, 12),
    [untrackedRecurring, unbudgetedCategories],
  );

  // Honest early-month framing: this compares month-to-date against the same
  // point last month, so label it "so far" rather than a finished-month verdict.
  const goingWellChips: string[] = [];
  if (momCompare.pctChange != null && momCompare.pctChange < 0)
    goingWellChips.push(
      `${Math.abs(Math.round(momCompare.pctChange))}% less than last month so far`,
    );
  if (streak.direction === "under" && streak.weeks >= 2)
    goingWellChips.push(`${streak.weeks} weeks under the cap`);

  return (
    <div className="space-y-3" data-testid="banking-insights">
      <SectionHeader
        eyebrow="Section · Insights"
        title="The four buckets"
        sub="What's working, what's leaking, and what to cut."
      />
      <div className="grid gap-4 sm:grid-cols-2 stagger-children">
        <BucketCard
          icon={<ThumbsUp className="h-4 w-4" />}
          title="Going well"
          tone="good"
          caption={captions?.goingWell}
          fallbackHeadline="The wins"
          fallbackCaption={
            spentLessRows.length
              ? "You're spending less in these than at this point last month."
              : "Nothing down vs last month yet — early days."
          }
          rows={spentLessRows}
          amountClass="text-positive"
          amountSuffix="less vs last mo"
          chips={goingWellChips}
          empty="No categories down vs last month yet."
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
          empty="Nothing over budget yet."
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
              ? `${detected.length} detected · ${formatCurrency(cancelAnnualTotal)}/yr total — ✕ any you've already cancelled`
              : undefined
          }
          empty="No subscription leaks found."
          dismissKeyFor={(r) => r.key}
          onDismiss={dismissSub}
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
          dismissKeyFor={(r) => (r.key.startsWith("sub-") ? r.key.slice(4) : null)}
          onDismiss={dismissSub}
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
  dismissKeyFor,
  onDismiss,
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
  /** Given a row, the merchant key to dismiss — or null if the row isn't
   *  dismissable (e.g. a budget-category row). Enables the per-row ✕. */
  dismissKeyFor?: (row: BucketRow) => string | null;
  onDismiss?: (merchant: string) => void;
}) {
  const headline = caption?.headline?.trim() || fallbackHeadline;
  const line = caption?.caption?.trim() || fallbackCaption;
  const TONE: Record<string, { bg: string; ink: string }> = {
    good: { bg: "hsl(var(--frost-green))", ink: "hsl(var(--frost-green-ink))" },
    warning: { bg: "hsl(var(--frost-amber))", ink: "hsl(var(--frost-amber-ink))" },
    danger: { bg: "hsl(var(--frost-rose))", ink: "hsl(var(--frost-rose-ink))" },
    neutral: { bg: "hsl(var(--frost-slate))", ink: "hsl(var(--frost-slate-ink))" },
  };
  const t = TONE[tone as string] ?? TONE.neutral;
  return (
    <Card className="h-full overflow-hidden">
      <CardContent className="flex h-full flex-col p-0">
        {/* Tone-colored header strip — gives each bucket a distinct, calm identity. */}
        <div
          className="flex items-center gap-1.5 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide [&_svg]:h-3.5 [&_svg]:w-3.5"
          style={{ background: t.bg, color: t.ink }}
        >
          {icon}
          {title}
        </div>
        <div className="flex h-full flex-col p-4">
        <div className="text-[15px] font-bold tracking-tight leading-snug">
          {headline}
        </div>
        <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground leading-snug">
          {line}
        </p>
        {chips && chips.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <PillBadge key={c} tone="good" dot={false}>
                {c}
              </PillBadge>
            ))}
          </div>
        ) : null}
        <div className="mt-3 max-h-56 overflow-y-auto divide-y divide-border pr-1 [scrollbar-width:thin]">
          {rows.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">{empty}</p>
          ) : (
            rows.map((r) => {
              const dismissKey = dismissKeyFor?.(r) ?? null;
              return (
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
                <div className="flex shrink-0 items-center gap-2">
                  <div className={cn("text-sm font-semibold tabular-nums", amountClass)}>
                    <MoneyText amount={r.amount} abs />
                    {amountSuffix ? (
                      <span className="ml-1 text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                        {amountSuffix}
                      </span>
                    ) : null}
                  </div>
                  {dismissKey && onDismiss ? (
                    <button
                      type="button"
                      aria-label={`Dismiss ${r.name} — already cancelled`}
                      title="Already cancelled — remove from this list"
                      onClick={() => onDismiss(dismissKey)}
                      className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      data-testid={`bucket-row-dismiss-${r.key}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
              );
            })
          )}
        </div>
        {footer ? (
          <div className="mt-auto pt-3 text-[11px] text-muted-foreground">
            {footer}
          </div>
        ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
