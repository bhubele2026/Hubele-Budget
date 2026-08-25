import { useMemo, useState } from "react";
import {
  useListTransactions,
  useListCategories,
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
  useUpdateTransaction,
  getListTransactionsQueryKey,
  type Transaction,
  type SpendingFacts,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CategoryPicker } from "@/components/category-picker";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { PageSkeleton } from "@/components/page-skeleton";
import { formatCurrency, cn } from "@/lib/utils";
import { fmtISO } from "@/lib/reportsAnalytics";
import {
  ANIM_AREA,
  ANIM_BAR,
  CHART,
  NAVY_RAMP,
  animBegin,
  catColor,
} from "@/lib/chartTokens";
import { CssBars, type CssBarRow } from "@/lib/cssBars";
import {
  card,
  btnSecondarySm,
  emptyNote,
  fieldLabel,
  td,
  tdNum,
  Foot,
  Stat,
} from "@/ui";
import { type RangeMode } from "@/lib/timeRange";
import {
  ResponsiveContainer,
  AreaChart,
  BarChart,
  CartesianGrid,
  PieChart,
  Cell,
  Area,
  Bar,
  Pie,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  AXIS_TICK,
  GRID_STROKE,
  LEGEND_STYLE,
  ChartCard,
  PanelCard,
  axisMoney,
  tooltipMoney,
  tooltipStyle,
  ReportShell,
  ReportsRangeControls,
  daysForMode,
} from "./reportsShared";

/** Reimbursable vs personal — two marks, two clearly opposed hexes. */
export const REIMBURSABLE_SERIES = {
  outstanding: CHART.orange, // #f68d2e — money still owed back
  personal: CHART.navy, //      #19315b — the true personal cost
} as const;

export default function SpendingPage() {
  // Weekly-first: opens on the current week; Mo/Yr are opt-in.
  const [mode, setMode] = useState<RangeMode>("wk");
  const rangeDays = daysForMode(mode);
  // Date-window derivation lifted verbatim from the old shared reports data hook.
  const today = useMemo(() => new Date(), []);
  const fromDate = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - rangeDays);
    return d;
  }, [today, rangeDays]);
  // (#a8 per-page fetch) The charts read server-computed spending facts; this
  // scoped pull only feeds the Recategorize popover with real txn rows + IDs
  // for exactly the page's window (the old shared hook fetched a 95-day floor).
  //
  // (D3) And ONLY the rows that popover can act on. It used to pull the whole
  // window — up to 2,000 rows — and throw away every categorized one in the
  // browser; `uncategorized: true` is the same filter, applied in SQL. The
  // client predicate below still runs: the server knows the rows have no
  // category, not whether they are outflows or bank noise.
  const { data: txns, isLoading: txnsLoading } = useListTransactions({
    from: fmtISO(fromDate),
    to: fmtISO(today),
    uncategorized: true,
    limit: 500,
  });
  const { data: categories } = useListCategories();
  const rangeTxns = useMemo(() => {
    if (!txns) return [];
    const fromIso = fmtISO(fromDate);
    return txns.filter((t) => t.occurredOn >= fromIso);
  }, [txns, fromDate]);
  if (txnsLoading) return <PageSkeleton />;
  return (
    <ReportShell
      crumb="Spending"
      title="Spending"
      controls={
        <ReportsRangeControls mode={mode} setMode={setMode} showCompare={false} />
      }
    >
      <SpendingSection
        from={fmtISO(fromDate)}
        to={fmtISO(today)}
        txns={rangeTxns}
        categories={(categories ?? []).map((c) => ({ id: c.id, name: c.name }))}
      />
    </ReportShell>
  );
}

// Tracking began May 1, 2026 (mirrors server TRACKING_START).
const TRACKING_START_YM = "2026-05";

interface HeatCell {
  date: string;
  amount: number;
  week: number;
  dow: number;
}

// Mirrors the server's transfer/payment description patterns so the
// Recategorize popover lists exactly the txns that the facts pipeline counts
// as uncategorized (spendingFilter.ts isUncategorizedSpend).
const SPENDING_TRANSFER_PATTERNS = [
  "online transfer",
  "ach pmt",
  "ach payment",
  "web id:",
  "credit card pmt",
  "autopay",
  "payment thank you",
  "card pmt",
  "epay",
  "chase credit",
  "bk of amer",
  "wells fargo card",
];

function spendMagnitude(t: Transaction): number {
  const a = parseFloat(t.amount);
  if (!Number.isFinite(a)) return 0;
  if (t.source === "amex") return a > 0 ? a : 0;
  return a < 0 ? -a : 0;
}

// Client-side mirror of isUncategorizedSpend — used only to populate the
// Recategorize popover with the actual transaction rows + IDs.
function isUncategorizedSpendTxn(t: Transaction): boolean {
  if (spendMagnitude(t) <= 0) return false;
  if (t.isTransfer === true) return false;
  if (t.categoryId) return false;
  const d = (t.description ?? "").toLowerCase();
  if (SPENDING_TRANSFER_PATTERNS.some((p) => d.includes(p))) return false;
  return true;
}

function sentenceCase(s: string): string {
  const t = (s ?? "").trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function monthLongLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}
function monthShortLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" });
}

// Pretty "May 1–29" style label from two ISO dates.
function rangeLabel(startIso: string, endIso: string): string {
  const s = new Date(`${startIso}T00:00:00Z`);
  const e = new Date(`${endIso}T00:00:00Z`);
  const sM = s.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const eM = e.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const sD = s.getUTCDate();
  const eD = e.getUTCDate();
  return sM === eM ? `${sM} ${sD}–${eD}` : `${sM} ${sD} – ${eM} ${eD}`;
}

// Inclusive list of ISO days between two dates (UTC).
function eachIsoDay(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * (Phase 2) The uncategorized backlog. This is a caveat about the DATA — every
 * other number on the page is computed net of these rows — so it takes the one
 * alarm colour the palette has, and says so in words.
 */
function UncategorizedBanner({
  facts,
  uncategorizedTxns,
  categories,
}: {
  facts: SpendingFacts;
  uncategorizedTxns: Transaction[];
  categories: { id: string; name: string }[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const updateTxn = useUpdateTransaction();

  const handleChange = (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => {
    updateTxn.mutate(
      {
        id: txnId,
        data: {
          categoryId: newCategoryId,
          ...(rememberPattern ? { rememberPattern } : {}),
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          qc.invalidateQueries({
            queryKey: getGetReportsSpendingFactsQueryKey(),
          });
          toast({ title: "Recategorized" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't recategorize",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const samples = facts.uncategorized.sampleMerchants
    .slice(0, 3)
    .map((m) => m.name)
    .join(", ");

  return (
    <div
      className="flex flex-col justify-between gap-3 rounded-card bg-bad-bg px-4 py-3 ring-1 ring-bad/25 sm:flex-row sm:items-center"
      data-testid="banner-uncategorized"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="chip bad">Uncategorized</span>
          <span className="font-mono text-title font-semibold tabular-nums text-bad">
            {formatCurrency(facts.uncategorized.total)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-micro text-neutral-500">
          {facts.uncategorized.transactionCount} transactions
          {samples ? ` · ${samples}` : ""}
        </div>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(btnSecondarySm, "shrink-0")}
            data-testid="button-recategorize-uncategorized"
          >
            Recategorize
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-h-[28rem] w-96 overflow-y-auto p-0">
          <div className="sticky top-0 border-b border-brand-line bg-white px-3 py-2">
            <span className={fieldLabel}>
              {uncategorizedTxns.length} uncategorized
            </span>
          </div>
          {uncategorizedTxns.length === 0 ? (
            <div className={emptyNote}>Nothing uncategorized</div>
          ) : (
            <div>
              {uncategorizedTxns.map((t) => (
                <div key={t.id} className="border-b border-brand-line/70 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-body font-medium">
                        {t.description}
                      </div>
                      <div className="font-mono text-micro tabular-nums text-neutral-400">
                        {t.occurredOn}
                      </div>
                    </div>
                    <div className="whitespace-nowrap font-mono text-label tabular-nums">
                      {formatCurrency(Math.abs(parseFloat(t.amount)))}
                    </div>
                  </div>
                  <div className="mt-1">
                    <CategoryPicker
                      value={t.categoryId ?? null}
                      categories={categories}
                      description={t.description}
                      onChange={(newId, rememberPattern) =>
                        handleChange(t.id, newId, rememberPattern)
                      }
                      testId={`recat-uncat-${t.id}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SpendingSection({
  from,
  to,
  txns,
  categories,
}: {
  from: string;
  to: string;
  txns: Transaction[];
  categories: { id: string; name: string }[];
}) {
  const { data: facts, isLoading } = useGetReportsSpendingFacts({ from, to });
  // (#dow-drill) Clicked weekday bar → reveal that day's top merchants.
  const [selectedDow, setSelectedDow] = useState<number | null>(null);

  // Real uncategorized rows (with IDs) for the Recategorize popover, scoped to
  // the facts' (possibly floor-clamped) range so the count matches the banner.
  const uncategorizedTxns = useMemo(() => {
    if (!facts) return [];
    const lo = facts.range.start;
    const hi = facts.range.end;
    return txns
      .filter((t) => t.occurredOn >= lo && t.occurredOn <= hi)
      .filter(isUncategorizedSpendTxn)
      .sort((a, b) => spendMagnitude(b) - spendMagnitude(a));
  }, [facts, txns]);

  // Top categories excluding the DB "Uncategorized" bucket (it has its own
  // banner; it must never show as a category or in the pie).
  const realCats = useMemo(
    () =>
      (facts?.byCategory ?? []).filter((c) => !/uncategorized/i.test(c.name)),
    [facts],
  );

  // Pie: top 8 real categories + an "Other" slice for the rest.
  const pieData = useMemo(() => {
    const top8 = realCats.slice(0, 8).map((c) => ({
      name: c.name,
      total: c.total,
      pct: c.pctOfRealSpend,
    }));
    const rest = realCats.slice(8);
    if (rest.length > 0) {
      top8.push({
        name: "Other",
        total: rest.reduce((s, c) => s + c.total, 0),
        pct: rest.reduce((s, c) => s + c.pctOfRealSpend, 0),
      });
    }
    return top8;
  }, [realCats]);

  // Reimbursable donut from facts.reimbursable.
  const reimDonut = useMemo(() => {
    if (!facts) return [];
    return [
      {
        name: "Outstanding reimbursable",
        value: Math.round(facts.reimbursable.outstandingReimbursableTotal),
      },
      { name: "Personal", value: Math.round(facts.reimbursable.personalTotal) },
    ].filter((r) => r.value > 0);
  }, [facts]);

  // Heatmap: build a continuous calendar from the range. While we have under
  // 12 weeks (84 days) of data, show every day since tracking started;
  // afterward automatically roll to the last 84 days.
  const { heatCols, maxHeat } = useMemo(() => {
    if (!facts)
      return { heatCols: [] as { week: number; cells: HeatCell[] }[], maxHeat: 0 };
    const totals = new Map(facts.dailyBuckets.map((b) => [b.date, b.total]));
    const allDays = eachIsoDay(facts.range.start, facts.range.end);
    const days = allDays.length > 84 ? allDays.slice(-84) : allDays;
    const first = new Date(`${days[0]}T00:00:00Z`);
    const firstSunday = new Date(first);
    firstSunday.setUTCDate(firstSunday.getUTCDate() - first.getUTCDay());
    const cells: HeatCell[] = days.map((date) => {
      const d = new Date(`${date}T00:00:00Z`);
      const diffDays = Math.floor(
        (d.getTime() - firstSunday.getTime()) / 86_400_000,
      );
      return {
        date,
        amount: totals.get(date) ?? 0,
        week: Math.floor(diffDays / 7),
        dow: d.getUTCDay(),
      };
    });
    let max = 0;
    for (const c of cells) if (c.amount > max) max = c.amount;
    const cols: { week: number; cells: HeatCell[] }[] = [];
    let curr: HeatCell[] = [];
    let lastWeek = -1;
    for (const c of cells) {
      if (c.week !== lastWeek) {
        if (curr.length) cols.push({ week: lastWeek, cells: curr });
        curr = [];
        lastWeek = c.week;
      }
      curr.push(c);
    }
    if (curr.length) cols.push({ week: lastWeek, cells: curr });
    return { heatCols: cols, maxHeat: max };
  }, [facts]);

  // Day-of-week: avg per day, highlight the highest-average day.
  const maxDowAvg = useMemo(() => {
    let m = 0;
    for (const d of facts?.dayOfWeek ?? []) if (d.avgPerDay > m) m = d.avgPerDay;
    return m;
  }, [facts]);

  const topMerch = useMemo(
    () => (facts?.byMerchant ?? []).slice(0, 10),
    [facts],
  );
  // Ranked CSS bars, not recharts — a ranked list that re-reads itself is
  // exactly what chart law 4 keeps off the charting library.
  const merchRows = useMemo<CssBarRow[]>(
    () =>
      topMerch.map((m) => ({
        id: m.name,
        label: m.name,
        value: m.total,
        hint: `${m.count}×${m.sampleCategoryName ? ` · ${m.sampleCategoryName}` : ""}`,
      })),
    [topMerch],
  );

  // Category trends treatment depends on how many months of data exist.
  const months = facts?.monthlyTrends ?? [];
  const trendTopCatNames = useMemo(() => {
    const agg = new Map<string, number>();
    for (const mo of months)
      for (const c of mo.byTopCategory)
        agg.set(c.name, (agg.get(c.name) ?? 0) + c.total);
    return [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name]) => name);
  }, [months]);
  const trendBarData = useMemo(
    () =>
      months.map((mo) => {
        const row: Record<string, number | string> = {
          month: monthShortLabel(mo.month),
        };
        for (const name of trendTopCatNames) {
          row[name] =
            mo.byTopCategory.find((c) => c.name === name)?.total ?? 0;
        }
        return row;
      }),
    [months, trendTopCatNames],
  );
  const trendSparkData = useMemo(
    () =>
      trendTopCatNames.map((name) => ({
        name,
        total: months.reduce(
          (s, mo) =>
            s + (mo.byTopCategory.find((c) => c.name === name)?.total ?? 0),
          0,
        ),
        series: months.map((mo) => ({
          month: monthShortLabel(mo.month),
          spend: mo.byTopCategory.find((c) => c.name === name)?.total ?? 0,
        })),
      })),
    [months, trendTopCatNames],
  );

  if (isLoading || !facts) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full rounded-card" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
      </div>
    );
  }

  const topCat = realCats[0];
  const topMerchant = facts.byMerchant[0];
  const showUncatBanner = facts.uncategorized.total > 0;
  const selected =
    selectedDow === null
      ? null
      : facts.dayOfWeek.find((d) => d.dow === selectedDow) ?? null;

  return (
    <div className="space-y-4">
      {showUncatBanner && (
        <UncategorizedBanner
          facts={facts}
          uncategorizedTxns={uncategorizedTxns}
          categories={categories}
        />
      )}

      <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          index={0}
          label="Total real spend"
          value={formatCurrency(facts.realSpend.total)}
          hint={`${facts.realSpend.transactionCount} transactions · ${rangeLabel(facts.range.start, facts.range.end)}`}
          data-testid="spending-total"
        />
        <Stat
          index={1}
          label="Top category"
          value={topCat?.name ?? "—"}
          hint={
            topCat
              ? `${formatCurrency(topCat.total)} · ${Math.round(topCat.pctOfRealSpend)}% of real spend`
              : "—"
          }
          data-testid="spending-top-category"
        />
        <Stat
          index={2}
          label="Top merchant"
          value={topMerchant?.name ?? "—"}
          hint={
            topMerchant
              ? `${topMerchant.count} ${topMerchant.count === 1 ? "hit" : "hits"}${topMerchant.sampleCategoryName ? ` · ${topMerchant.sampleCategoryName}` : ""}`
              : "—"
          }
          data-testid="spending-top-merchant"
        />
        <Stat
          index={3}
          label="Reimbursable outstanding"
          value={formatCurrency(facts.reimbursable.outstandingReimbursableTotal)}
          hint={
            facts.reimbursable.outstandingReimbursableTotal > 0
              ? "still owed back to the household"
              : "nothing outstanding"
          }
          tone={
            facts.reimbursable.outstandingReimbursableTotal > 0 ? "bad" : "navy"
          }
          data-testid="spending-reimbursable"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Top categories"
          help="Real spend by category. Uncategorized is excluded — it has its own banner — so these percentages are of categorized spend only."
          empty={pieData.length === 0 ? "No categorized spend yet" : null}
          hideWhenEmpty
        >
          <div className="flex h-full flex-col items-center gap-4 sm:flex-row">
            <div className="h-full min-h-[200px] w-full sm:w-1/2">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie {...ANIM_BAR} data={pieData}
                    dataKey="total"
                    nameKey="name"
                    outerRadius="92%"
                    innerRadius="55%"
                    paddingAngle={2}
                    stroke="#fff"
                    strokeWidth={2}
                  >
                    {/* Slots 0–7 are the real categories; the optional 9th
                        entry is the rollup, and `catColor(8)` IS `OTHER_GREY`.
                        No local substitute needed — the kit's token is now
                        genuinely distinct from all eight identities. */}
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={catColor(i)} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: number) => tooltipMoney(v)}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* The legend carries every label and value, so the chart reads
                without relying on hue discrimination. */}
            <ul className="w-full space-y-1 text-micro sm:w-1/2">
              {pieData.map((d, i) => (
                <li key={d.name} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ background: catColor(i) }}
                  />
                  <span className="flex-1 truncate text-neutral-600">
                    {sentenceCase(d.name)}
                  </span>
                  <span className="font-mono tabular-nums text-neutral-700">
                    {formatCurrency(d.total)}
                  </span>
                  <span className="w-9 text-right font-mono tabular-nums text-neutral-400">
                    {Math.round(d.pct)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>

        <ChartCard
          title="Reimbursable vs personal"
          help="On Amex: how much is still expected back against the true personal cost."
          empty={reimDonut.length === 0 ? "No Amex spend tagged yet" : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie {...ANIM_BAR} data={reimDonut}
                dataKey="value"
                nameKey="name"
                innerRadius="55%"
                outerRadius="90%"
                paddingAngle={2}
                stroke="#fff"
                strokeWidth={2}
              >
                <Cell fill={REIMBURSABLE_SERIES.outstanding} />
                <Cell fill={REIMBURSABLE_SERIES.personal} />
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
              />
              <Legend wrapperStyle={LEGEND_STYLE} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard
        title="Spending heatmap"
        help={`One square per day since tracking started in ${monthLongLabel(TRACKING_START_YM)}. Darker is more spent; the scale is the heaviest day in view.`}
        empty={
          heatCols.length === 0 || maxHeat === 0 ? "No spending recorded yet" : null
        }
        hideWhenEmpty
        height={160}
      >
        {/* Twelve weeks is a narrow calendar, so it is CENTRED rather than
            pinned left in a full-width card with 80% dead space. */}
        <div className="flex h-full items-start justify-center gap-1 overflow-x-auto pb-2">
          <div className="mr-2 grid grid-rows-7 items-center gap-1 text-micro text-neutral-400">
            {["", "Mon", "", "Wed", "", "Fri", ""].map((l, i) => (
              <div key={i} className="h-3 leading-none">
                {l}
              </div>
            ))}
          </div>
          {heatCols.map((col) => (
            <div key={col.week} className="grid grid-rows-7 gap-1">
              {Array.from({ length: 7 }).map((_, dow) => {
                const cell = col.cells.find((c) => c.dow === dow);
                if (!cell) return <div key={dow} className="h-3 w-3" />;
                // Sequential encoding on NAVY_RAMP, indexed by intensity —
                // light = low, navy = high (chart law 2).
                const intensity = maxHeat > 0 ? cell.amount / maxHeat : 0;
                const step =
                  cell.amount === 0
                    ? 0
                    : Math.min(
                        NAVY_RAMP.length - 1,
                        1 + Math.floor(intensity * (NAVY_RAMP.length - 1)),
                      );
                return (
                  <div
                    key={dow}
                    className="h-3 w-3 rounded-[2px]"
                    style={{ background: NAVY_RAMP[step] }}
                    title={`${cell.date}: ${formatCurrency(cell.amount)}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Day of week"
          help="Average spend per day for each weekday. The heaviest day takes the orange; click any bar to break that day down."
          empty={
            (facts.dayOfWeek ?? []).every((d) => d.avgPerDay === 0)
              ? "No spending data yet"
              : null
          }
          hideWhenEmpty
          height={selected ? 300 : 190}
        >
          <div className="flex h-full flex-col">
            <div className="h-[180px] w-full shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={facts.dayOfWeek}
                  margin={{ top: 10, right: 16, bottom: 4, left: 0 }}
                >
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    tickFormatter={axisMoney}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: number) => tooltipMoney(v)}
                    cursor={{ fill: CHART.grid, opacity: 0.45 }}
                  />
                  <Bar {...ANIM_BAR} animationBegin={animBegin(0)} dataKey="avgPerDay"
                    radius={[4, 4, 0, 0]}
                    onClick={(d: { dow?: number; payload?: { dow?: number } }) => {
                      const dow = d?.payload?.dow ?? d?.dow ?? null;
                      setSelectedDow((cur) => (cur === dow ? null : dow));
                    }}
                  >
                    {facts.dayOfWeek.map((d, i) => (
                      <Cell
                        key={i}
                        cursor="pointer"
                        fill={
                          selectedDow === d.dow ||
                          (maxDowAvg > 0 && d.avgPerDay === maxDowAvg)
                            ? CHART.orange
                            : CHART.navy
                        }
                        fillOpacity={
                          selectedDow === null || selectedDow === d.dow ? 1 : 0.4
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {selected && (
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto border-t border-brand-line pt-2">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className={fieldLabel}>{selected.label} · top merchants</span>
                  <span className="font-mono text-label font-semibold tabular-nums">
                    {formatCurrency(selected.total)}
                  </span>
                </div>
                {selected.topMerchants.length === 0 ? (
                  <p className="text-micro text-neutral-400">
                    No spending on {selected.label}s in this window
                  </p>
                ) : (
                  <table className="w-full">
                    <tbody>
                      {selected.topMerchants.map((m) => (
                        <tr key={m.name}>
                          <td className={cn(td, "max-w-[220px] truncate border-0 px-0 py-0.5 text-neutral-600")}>
                            {m.name}
                          </td>
                          <td className={cn(tdNum, "border-0 px-0 py-0.5")}>
                            {formatCurrency(m.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </ChartCard>

        <PanelCard
          title="Top merchants"
          help="Top 10 by total spend in this window, with how many times each was hit. Bars darken with rank."
        >
          {merchRows.length === 0 ? (
            <div className={emptyNote}>No merchants tracked yet</div>
          ) : (
            <div className="px-4 py-3">
              {/* `valueWidth` has to hold the money AND the trailing hint on
                  ONE line — the hint sits inline after the value, so too
                  narrow a column wraps it into the row below and the rows
                  visually collide. */}
              <CssBars
                rows={merchRows}
                format={(v) => formatCurrency(v)}
                ramp
                rowHeight={30}
                labelWidth={132}
                valueWidth={224}
                ariaLabel="Top merchants by total spend"
              />
            </div>
          )}
        </PanelCard>
      </div>

      {months.length === 1 ? (
        <PanelCard
          title="Category trends"
          help="Only one month of data so far. A month-by-month chart takes over once a second month lands."
        >
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-body font-medium">
                {monthLongLabel(months[0].month)}
              </span>
              <span className="font-mono text-label tabular-nums">
                {formatCurrency(months[0].total)} across {realCats.length}{" "}
                {realCats.length === 1 ? "category" : "categories"}
              </span>
            </div>
            <div className="mt-2 flex h-6 w-full overflow-hidden rounded-control">
              {months[0].byTopCategory.map((c, i) => (
                <div
                  key={c.name}
                  className="h-full"
                  style={{
                    width: `${months[0].total > 0 ? (c.total / months[0].total) * 100 : 0}%`,
                    background: catColor(i),
                  }}
                  title={`${c.name}: ${formatCurrency(c.total)}`}
                />
              ))}
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-micro md:grid-cols-3">
              {months[0].byTopCategory.map((c, i) => (
                <li key={c.name} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ background: catColor(i) }}
                  />
                  <span className="flex-1 truncate text-neutral-600">
                    {sentenceCase(c.name)}
                  </span>
                  <span className="font-mono tabular-nums text-neutral-700">
                    {formatCurrency(c.total)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </PanelCard>
      ) : months.length >= 6 ? (
        <PanelCard
          title="Category trends · last 6 months"
          help="One sparkline per top category, on a shared six-month axis. Watch for a line that creeps up month over month."
        >
          <div className="grid grid-cols-2 gap-4 px-4 py-3 md:grid-cols-4">
            {trendSparkData.map((t, i) => (
              <div key={t.name} className="flex flex-col">
                <div className="truncate text-micro font-medium text-neutral-700">
                  {t.name}
                </div>
                <div className="mb-1 font-mono text-micro tabular-nums text-neutral-400">
                  {formatCurrency(t.total)}
                </div>
                <div className="h-16">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={t.series}
                      margin={{ top: 2, right: 0, left: 0, bottom: 0 }}
                    >
                      <Area {...ANIM_AREA} animationBegin={animBegin(i)} type="monotone"
                        dataKey="spend"
                        stroke={catColor(i)}
                        fill={catColor(i)}
                        fillOpacity={0.2}
                        strokeWidth={1.5}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: number) => tooltipMoney(v)}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ))}
          </div>
          <Foot>
            Each sparkline is scaled to its own category, so heights compare
            within a card and never across them.
          </Foot>
        </PanelCard>
      ) : (
        <ChartCard
          title="Category trends"
          help="Spend per month for the top categories since tracking started. A sparkline grid takes over at six months."
          empty={trendBarData.length === 0 ? "No category spending yet" : null}
          hideWhenEmpty
          height={280}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={trendBarData}
              margin={{ top: 10, right: 16, bottom: 8, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="month" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} tickFormatter={axisMoney} width={62} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
              />
              <Legend wrapperStyle={LEGEND_STYLE} />
              {trendTopCatNames.map((name, i) => (
                <Bar {...ANIM_BAR} key={name}
                  animationBegin={animBegin(i)}
                  dataKey={name}
                  stackId="trend"
                  fill={catColor(i)}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}
