import { useCallback, useMemo, useState } from "react";
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

// Each bucket owns one accent (status semantics, shipped with its icon +
// label per the house dataviz rules). The accent colors the header icon and
// the thin proportion strip; text stays in ink tokens; only the row AMOUNT
// keeps its semantic money color.
const TONE: Record<Tone, { accent: string; amount: string }> = {
  good: { accent: "--positive", amount: "text-positive" },
  warning: { accent: "--warning", amount: "text-[hsl(var(--warning))]" },
  danger: { accent: "--negative", amount: "text-[hsl(var(--negative))]" },
  info: { accent: "--splash-violet", amount: "text-foreground" },
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
  const [expanded, setExpanded] = useState(false);

  // A subtle header chip totalling the figures already computed server-side.
  const total = useMemo(
    () => rows.reduce((s, r) => s + Math.abs(r.amount), 0),
    [rows],
  );
  const chip = summaryChip(bucketKey, rows.length, total);

  // Thin proportion strip: each merchant's share of the bucket total, in the
  // bucket's accent at graded emphasis. 4px tall with 2px spacers — quiet
  // magnitude context, not a chart demanding attention.
  const shares = useMemo(() => {
    if (rows.length < 2 || total <= 0) return [];
    return rows.slice(0, 8).map((r, i) => ({
      pct: (Math.abs(r.amount) / total) * 100,
      alpha: Math.max(0.25, 0.9 - i * 0.12),
    }));
  }, [rows, total]);

  const VISIBLE = 6;
  const shown = expanded ? rows : rows.slice(0, VISIBLE);
  const hiddenCount = rows.length - shown.length;

  return (
    <Card className="h-full overflow-hidden">
      <CardContent className="flex h-full flex-col p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
          <span className="flex items-center gap-1.5">
            <span style={{ color: `hsl(var(${t.accent}))` }}>{icon}</span>
            {title}
          </span>
          {chip ? (
            <span className="normal-case tabular-nums text-foreground/70">{chip}</span>
          ) : null}
        </div>
        <div className="flex h-full flex-col p-4 pt-3">
          {shares.length > 0 ? (
            <div
              className="mb-3 flex h-1 w-full gap-[2px] overflow-hidden rounded-full"
              aria-hidden
            >
              {shares.map((sh, i) => (
                <div
                  key={i}
                  className="rounded-full"
                  style={{
                    width: `${sh.pct}%`,
                    background: `hsl(var(${t.accent}) / ${sh.alpha})`,
                  }}
                />
              ))}
            </div>
          ) : null}

          <div className="divide-y divide-border/70">
            {rows.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">
                {EMPTY[bucketKey] ?? "Nothing to show yet."}
              </p>
            ) : (
              shown.map((r, i) => (
                <MoverRowView
                  key={`${r.display}-${i}`}
                  row={r}
                  amountClass={t.amount}
                  onDismiss={onDismiss}
                />
              ))
            )}
          </div>
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 self-start text-xs font-medium text-primary hover:underline"
            >
              Show {hiddenCount} more
            </button>
          ) : null}
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
