import { useMemo, useState } from "react";
import {
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
  getGetReportsAdvisorSummaryQueryKey,
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
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { Wand2 } from "lucide-react";
import { H2_PALETTE, CHART_SERIES } from "@/lib/reportsAnalytics";
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
  HeroTile,
  SectionHeader,
  ChartCard,
  tooltipMoney,
  tooltipStyle,
} from "./shared";

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

// (Phase 2) Warning banner above the tile row. Only renders when there is an
// uncategorized backlog. The Recategorize button opens the same per-row
// CategoryPicker popover treatment shipped on /debrief.
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
          qc.invalidateQueries({
            queryKey: getGetReportsAdvisorSummaryQueryKey({ tab: "spending" }),
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
    <Card
      className="rounded-lg border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/[0.08]"
      data-testid="banner-uncategorized"
    >
      <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <Wand2 className="w-5 h-5 text-[hsl(var(--warning))] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-lg font-bold">
              <span className="tabular-nums">
                {formatCurrency(facts.uncategorized.total)}
              </span>{" "}
              of your spending is uncategorized
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 truncate">
              {facts.uncategorized.transactionCount} transactions
              {samples ? ` · top merchants: ${samples}` : ""}
            </div>
          </div>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 border-[hsl(var(--warning))]/50"
              data-testid="button-recategorize-uncategorized"
            >
              <Wand2 className="w-3.5 h-3.5 mr-1.5" />
              Recategorize
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-96 p-0 max-h-[28rem] overflow-y-auto"
          >
            <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground sticky top-0 bg-popover">
              {uncategorizedTxns.length} uncategorized{" "}
              {uncategorizedTxns.length === 1 ? "transaction" : "transactions"}
            </div>
            {uncategorizedTxns.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                All caught up — nothing uncategorized.
              </div>
            ) : (
              <div className="divide-y">
                {uncategorizedTxns.map((t) => (
                  <div key={t.id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {t.description}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {t.occurredOn}
                        </div>
                      </div>
                      <div className="tabular-nums text-sm whitespace-nowrap">
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
      </CardContent>
    </Card>
  );
}

export function SpendingSection({
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
  const { heatCols, maxHeat, heatStartIso } = useMemo(() => {
    if (!facts)
      return { heatCols: [] as { week: number; cells: HeatCell[] }[], maxHeat: 0, heatStartIso: "" };
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
    return { heatCols: cols, maxHeat: max, heatStartIso: days[0] };
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
  const maxMerch = topMerch[0]?.total ?? 0;

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
      <div className="space-y-6">
        <SectionHeader
          eyebrow="Section · Spending"
          title="Where the money went"
          blurb="The rhythms, the leaks, and the merchants that quietly add up."
        />
        <Skeleton className="h-28 w-full rounded-lg" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const topCat = realCats[0];
  const topMerchant = facts.byMerchant[0];
  const showUncatBanner = facts.uncategorized.total > 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Section · Spending"
        title="Where the money went"
        blurb="The rhythms, the leaks, and the merchants that quietly add up."
      />

      {showUncatBanner && (
        <UncategorizedBanner
          facts={facts}
          uncategorizedTxns={uncategorizedTxns}
          categories={categories}
        />
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HeroTile
          label="Total real spend"
          value={formatCurrency(facts.realSpend.total)}
          sub={`${facts.realSpend.transactionCount} transactions · ${rangeLabel(facts.range.start, facts.range.end)}`}
        />
        <HeroTile
          label="Top category"
          value={topCat?.name ?? "—"}
          sub={
            topCat
              ? `${formatCurrency(topCat.total)} · ${Math.round(topCat.pctOfRealSpend)}% of real spend`
              : "—"
          }
          tone="amber"
        />
        <HeroTile
          label="Top merchant"
          value={topMerchant?.name ?? "—"}
          sub={
            topMerchant
              ? `${topMerchant.count} ${topMerchant.count === 1 ? "hit" : "hits"}${topMerchant.sampleCategoryName ? ` · ${topMerchant.sampleCategoryName}` : ""}`
              : "—"
          }
        />
        <HeroTile
          label="Reimbursable outstanding"
          value={formatCurrency(facts.reimbursable.outstandingReimbursableTotal)}
          sub={
            facts.reimbursable.outstandingReimbursableTotal > 0
              ? "still owed back to the household"
              : "nothing outstanding"
          }
          tone={
            facts.reimbursable.outstandingReimbursableTotal > 0
              ? "amber"
              : "good"
          }
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard
          title="Top categories"
          caption="Real spend by category — uncategorized lives in its own banner."
          empty={pieData.length === 0 ? "All clear — no categorized spend yet." : null}
          hideWhenEmpty
        >
          <div className="flex flex-col sm:flex-row items-center gap-4 h-full">
            <div className="w-full sm:w-1/2 h-full min-h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="total"
                    nameKey="name"
                    outerRadius={100}
                    innerRadius={52}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={CHART_SERIES[i % CHART_SERIES.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: number) => tooltipMoney(v)}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* Custom HTML legend — sentence-case label, dollars, percentage. */}
            <ul className="w-full sm:w-1/2 space-y-1.5 text-xs">
              {pieData.map((d, i) => (
                <li key={d.name} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-[2px] shrink-0"
                    style={{ background: CHART_SERIES[i % CHART_SERIES.length] }}
                  />
                  <span className="truncate flex-1">{sentenceCase(d.name)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(d.total)}
                  </span>
                  <span className="tabular-nums text-muted-foreground/70 w-9 text-right">
                    {Math.round(d.pct)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>

        <ChartCard
          title="Reimbursable vs personal"
          caption="On Amex: how much will come back vs. the true personal cost."
          empty={reimDonut.length === 0 ? "All clear — no Amex spend tagged yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={reimDonut}
                dataKey="value"
                nameKey="name"
                innerRadius={60}
                outerRadius={110}
              >
                <Cell fill={H2_PALETTE.amber} />
                <Cell fill={H2_PALETTE.primary} />
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard
        title="Spending heatmap"
        caption={`Since tracking started — ${monthLongLabel(TRACKING_START_YM)}. Each square is one day; darker = more spent.`}
        empty={
          heatCols.length === 0 || maxHeat === 0
            ? "All clear — no spending recorded yet."
            : null
        }
        hideWhenEmpty
        height={180}
      >
        <div className="flex items-start gap-1 h-full overflow-x-auto pb-2">
          <div className="grid grid-rows-7 gap-1 mr-2 text-[9px] text-muted-foreground items-center">
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
                const intensity = maxHeat > 0 ? cell.amount / maxHeat : 0;
                const bg =
                  cell.amount === 0
                    ? "hsl(var(--muted))"
                    : `hsl(var(--chart-1) / ${0.25 + intensity * 0.75})`;
                return (
                  <div
                    key={dow}
                    className="h-3 w-3 rounded-[2px]"
                    style={{ background: bg }}
                    title={`${cell.date}: ${formatCurrency(cell.amount)}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="rounded-lg">
          <CardContent className="p-5">
            <div className="font-semibold">Day of week</div>
            <p className="text-sm text-muted-foreground mb-3">
              Average spend per day — click a bar to see what you spent.
            </p>
            {(facts.dayOfWeek ?? []).every((d) => d.avgPerDay === 0) ? (
              <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">
                All clear — no spending data yet.
              </div>
            ) : (
              <>
                <div className="h-[180px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={facts.dayOfWeek}
                      margin={{ top: 10, right: 16, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid
                        stroke="hsl(var(--border))"
                        strokeOpacity={0.6}
                        vertical={false}
                      />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={(v: number) => `$${Math.round(v)}`}
                        tickLine={false}
                        axisLine={false}
                        width={44}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: number) => tooltipMoney(v)}
                        cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                      />
                      <Bar
                        dataKey="avgPerDay"
                        radius={[6, 6, 0, 0]}
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
                                ? H2_PALETTE.amber
                                : H2_PALETTE.primary
                            }
                            fillOpacity={
                              selectedDow === null || selectedDow === d.dow
                                ? 1
                                : 0.4
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {(() => {
                  const sel =
                    selectedDow === null
                      ? null
                      : facts.dayOfWeek.find((d) => d.dow === selectedDow);
                  if (!sel) {
                    return (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Click a bar to break down that day&rsquo;s spending.
                      </p>
                    );
                  }
                  return (
                    <div className="mt-3 border-t pt-3">
                      <div className="flex items-baseline justify-between mb-1.5">
                        <div className="text-sm font-medium">
                          {sel.label} · top merchants
                        </div>
                        <div className="text-sm tabular-nums font-semibold">
                          {formatCurrency(sel.total)}
                        </div>
                      </div>
                      {sel.topMerchants.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No spending on {sel.label}s in this window.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {sel.topMerchants.map((m) => (
                            <div
                              key={m.name}
                              className="flex items-center justify-between text-sm"
                            >
                              <span className="truncate text-muted-foreground">
                                {m.name}
                              </span>
                              <span className="tabular-nums shrink-0 ml-2">
                                {formatCurrency(m.total)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
          </CardContent>
        </Card>

        <ChartCard
          title="Top merchants"
          caption="Where your dollars actually land. Top 10 by total, with category context."
          empty={topMerch.length === 0 ? "All clear — no merchants tracked yet." : null}
          hideWhenEmpty
        >
          {/* Custom HTML bar list so each merchant can carry its category
              context as muted text to the right of the bar. */}
          <div className="h-full overflow-y-auto pr-1 space-y-2.5">
            {topMerch.map((m) => (
              <div key={m.name}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium">{m.name}</span>
                  <span className="tabular-nums whitespace-nowrap">
                    {formatCurrency(m.total)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${maxMerch > 0 ? (m.total / maxMerch) * 100 : 0}%`,
                        background: H2_PALETTE.primary,
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {m.count} {m.count === 1 ? "hit" : "hits"}
                    {m.sampleCategoryName ? ` · ${m.sampleCategoryName}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      {months.length === 1 ? (
        <ChartCard
          title="Category trends — since tracking started"
          caption="One month of data so far. A trend line appears as more months land."
          height={220}
        >
          <div className="flex flex-col h-full">
            <div className="text-sm font-medium mb-1">
              {monthLongLabel(months[0].month)}:{" "}
              <span className="tabular-nums">
                {formatCurrency(months[0].total)}
              </span>{" "}
              across {realCats.length}{" "}
              {realCats.length === 1 ? "category" : "categories"}
            </div>
            {/* Single horizontal stacked bar of the month's top categories. */}
            <div className="flex h-8 w-full rounded-md overflow-hidden mt-2">
              {months[0].byTopCategory.map((c, i) => {
                const w =
                  months[0].total > 0 ? (c.total / months[0].total) * 100 : 0;
                return (
                  <div
                    key={c.name}
                    className="h-full"
                    style={{
                      width: `${w}%`,
                      background: CHART_SERIES[i % CHART_SERIES.length],
                    }}
                    title={`${c.name}: ${formatCurrency(c.total)}`}
                  />
                );
              })}
            </div>
            <ul className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5 text-xs mt-3">
              {months[0].byTopCategory.map((c, i) => (
                <li key={c.name} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-[2px] shrink-0"
                    style={{ background: CHART_SERIES[i % CHART_SERIES.length] }}
                  />
                  <span className="truncate flex-1">{sentenceCase(c.name)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(c.total)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>
      ) : months.length >= 6 ? (
        <ChartCard
          title="Category trends — last 6 months"
          caption="One sparkline per top category. Watch for upward creep."
          empty={trendSparkData.length === 0 ? "All clear — no category spending yet." : null}
          hideWhenEmpty
          height={260}
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 h-full">
            {trendSparkData.map((t, i) => (
              <div key={t.name} className="flex flex-col">
                <div className="text-xs font-medium truncate">{t.name}</div>
                <div className="text-[10px] text-muted-foreground tabular-nums mb-1">
                  {formatCurrency(t.total)}
                </div>
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={t.series}
                      margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
                    >
                      <Area
                        type="monotone"
                        dataKey="spend"
                        stroke={CHART_SERIES[i % CHART_SERIES.length]}
                        fill={CHART_SERIES[i % CHART_SERIES.length]}
                        fillOpacity={0.25}
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
        </ChartCard>
      ) : (
        <ChartCard
          title="Category trends — since tracking started"
          caption="Spend per month for your top categories. A sparkline grid takes over at 6 months."
          empty={trendBarData.length === 0 ? "All clear — no category spending yet." : null}
          hideWhenEmpty
          height={280}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={trendBarData}
              margin={{ top: 10, right: 16, bottom: 8, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => `$${Math.round(v)}`}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {trendTopCatNames.map((name, i) => (
                <Bar
                  key={name}
                  dataKey={name}
                  stackId="trend"
                  fill={CHART_SERIES[i % CHART_SERIES.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}
