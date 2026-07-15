import { useCallback, useMemo } from "react";
import {
  TrendingDown,
  TrendingUp,
  Ban,
  Sparkles,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBankingInsightsSummary,
  getGetBankingInsightsSummaryQueryKey,
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  type BankingInsightsBucket,
  type BankingInsightsMoverRow,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader } from "@/components/stat";
import { MiniBars } from "@/components/viz";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * The four reworked, MERCHANT-LEVEL Banking buckets. Everything shown here —
 * the merchant names, the dollar figures, the visit-count deltas, the annual
 * run-rates, the per-row detail strings — is computed SERVER-SIDE in code
 * (bankingInsightsSummary.ts) and delivered ready to render. The advisor (Fable
 * 5) only classified each merchant and wrote the per-bucket headline + caption.
 * This component just paints the server truth, so card figures and captions can
 * never disagree. Per "the model never does arithmetic" — no math happens here
 * beyond summing already-computed row figures for a small header chip.
 */

type Tone = "good" | "warning" | "danger" | "info";

// Neutral, professional: every bucket header is the same muted strip; the icon
// differentiates them. Only the row AMOUNT keeps a semantic money color.
const NEUTRAL = {
  bg: "hsl(var(--muted))",
  ink: "hsl(var(--muted-foreground))",
  bar: "hsl(var(--muted-foreground))",
} as const;
const TONE: Record<Tone, { bg: string; ink: string; bar: string; amount: string }> = {
  good: { ...NEUTRAL, amount: "text-positive" },
  warning: { ...NEUTRAL, amount: "text-[hsl(var(--warning))]" },
  danger: { ...NEUTRAL, amount: "text-[hsl(var(--negative))]" },
  info: { ...NEUTRAL, amount: "text-foreground" },
};

const EMPTY: Record<string, string> = {
  spendingLess: "No merchant is below last month's pace yet — early days.",
  creepingUp: "Nothing creeping up right now. Keep it there.",
  recurringToCut: "No real subscriptions to cut — restaurants and stores don't count.",
  newOrUnusual: "No first-time merchants this month.",
};

export function BankingInsights() {
  // The whole section — merchant rows AND captions — is one server call.
  const { data: summary } = useGetBankingInsightsSummary(undefined, {
    query: {
      queryKey: getGetBankingInsightsSummaryQueryKey(),
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
    },
  });

  // Let the user hide a subscription they've already cancelled in real life
  // (client-side, keyed by merchant name — persisted in settings.preferences,
  // mirrors the amexExcludedTxnIds pattern). Only the "cancel these" bucket.
  const { data: settings } = useGetSettings();
  const updateSettings = useUpdateSettings();
  const qc = useQueryClient();
  const dismissed = useMemo(
    () =>
      new Set(
        (settings?.preferences?.dismissedDetectedSubs as string[] | undefined) ??
          [],
      ),
    [settings],
  );
  const dismiss = useCallback(
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

  return (
    <div className="space-y-3" data-testid="banking-insights">
      <SectionHeader
        eyebrow="Section · Insights"
        title="Where the money's moving"
        sub="Merchant by merchant — what you cut, what's creeping up, what to cancel."
      />
      <div className="grid gap-4 sm:grid-cols-2 stagger-children">
        <BucketCard
          icon={<TrendingDown className="h-4 w-4" />}
          title="Spending less"
          tone="good"
          bucket={summary?.spendingLess}
          bucketKey="spendingLess"
        />
        <BucketCard
          icon={<TrendingUp className="h-4 w-4" />}
          title="Creeping up"
          tone="warning"
          bucket={summary?.creepingUp}
          bucketKey="creepingUp"
        />
        <BucketCard
          icon={<Ban className="h-4 w-4" />}
          title="Cancel these"
          tone="danger"
          bucket={summary?.recurringToCut}
          bucketKey="recurringToCut"
          dismissed={dismissed}
          onDismiss={dismiss}
        />
        <BucketCard
          icon={<Sparkles className="h-4 w-4" />}
          title="New or unusual"
          tone="info"
          bucket={summary?.newOrUnusual}
          bucketKey="newOrUnusual"
        />
      </div>
    </div>
  );
}

function BucketCard({
  icon,
  title,
  tone,
  bucket,
  bucketKey,
  dismissed,
  onDismiss,
}: {
  icon: React.ReactNode;
  title: string;
  tone: Tone;
  bucket: BankingInsightsBucket | undefined;
  bucketKey: string;
  /** Merchant names the user has hidden (only used for "cancel these"). */
  dismissed?: Set<string>;
  onDismiss?: (merchant: string) => void;
}) {
  const t = TONE[tone];
  const rows = (bucket?.rows ?? []).filter(
    (r) => !dismissed || !dismissed.has(r.display),
  );

  // A bar per merchant row, sized to its figure. Neutral tint.
  const bars = useMemo(
    () => rows.slice(0, 10).map((r) => ({ value: Math.abs(r.amount), color: t.bar })),
    [rows, t.bar],
  );
  // A subtle header chip totalling the figures already computed server-side.
  const total = useMemo(
    () => rows.reduce((s, r) => s + Math.abs(r.amount), 0),
    [rows],
  );
  const chip = summaryChip(bucketKey, rows.length, total);

  return (
    <Card className="h-full overflow-hidden">
      <CardContent className="flex h-full flex-col p-0">
        <div
          className="flex items-center justify-between gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide [&_svg]:h-3.5 [&_svg]:w-3.5"
          style={{ background: t.bg, color: t.ink }}
        >
          <span className="flex items-center gap-1.5">
            {icon}
            {title}
          </span>
          {chip ? <span className="normal-case tabular-nums opacity-80">{chip}</span> : null}
        </div>
        <div className="flex h-full flex-col p-4">
          {bars.length > 1 ? (
            <MiniBars data={bars} height={26} className="w-full opacity-80" />
          ) : null}

          <div className="mt-3 max-h-56 overflow-y-auto divide-y divide-border pr-1 [scrollbar-width:thin]">
            {rows.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">
                {EMPTY[bucketKey] ?? "Nothing to show yet."}
              </p>
            ) : (
              rows.map((r, i) => (
                <MoverRowView
                  key={`${r.display}-${i}`}
                  row={r}
                  amountClass={t.amount}
                  onDismiss={onDismiss}
                />
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MoverRowView({
  row,
  amountClass,
  onDismiss,
}: {
  row: BankingInsightsMoverRow;
  amountClass: string;
  onDismiss?: (merchant: string) => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-2"
      data-testid={`bucket-row-${row.display}`}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{row.display}</div>
        {row.detail ? (
          <div className="text-xs text-muted-foreground tabular-nums truncate">
            {row.detail}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className={cn("text-sm font-semibold tabular-nums", amountClass)}>
          {formatCurrency(Math.abs(row.amount))}
          <span className="ml-1 text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
            {row.amountLabel}
          </span>
        </div>
        {onDismiss ? (
          <button
            type="button"
            aria-label={`Dismiss ${row.display} — already cancelled`}
            title="Already cancelled — remove from this list"
            onClick={() => onDismiss(row.display)}
            className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            data-testid={`bucket-row-dismiss-${row.display}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A tiny, honest header chip summarizing the bucket (aggregates server figures). */
function summaryChip(key: string, count: number, total: number): string | null {
  if (count === 0) return null;
  switch (key) {
    case "spendingLess":
      return `${formatCurrency(total)} less`;
    case "creepingUp":
      return `${formatCurrency(total)} up`;
    case "recurringToCut":
      return `${formatCurrency(total)}/yr`;
    case "newOrUnusual":
      return `${count} new`;
    default:
      return null;
  }
}
