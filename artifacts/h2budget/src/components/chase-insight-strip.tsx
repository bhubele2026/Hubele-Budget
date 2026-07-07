import { useMemo } from "react";
import {
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { StackBar, DeltaPill, MoneyText } from "@/components/viz";
import { rangeDays, type DateRange } from "@/lib/timeRange";

const MIX_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-5))",
];

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The equal-length window immediately before `range` (for "vs last …"). */
function priorWindow(range: DateRange): { from: string; to: string } {
  const days = rangeDays(range);
  const start = new Date(`${range.from}T00:00:00`);
  const priorTo = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  const priorFrom = new Date(
    priorTo.getFullYear(),
    priorTo.getMonth(),
    priorTo.getDate() - (days - 1),
  );
  return { from: isoOf(priorFrom), to: isoOf(priorTo) };
}

const PERIOD_WORD: Record<DateRange["mode"], string> = {
  wk: "week",
  mo: "month",
  yr: "year",
};

/**
 * Compact visual strip for the Chase page: a period-over-period spend DeltaPill
 * + a StackBar of the window's category mix. Both are scoped to the page's date
 * selector (`range`) and pull the server's real-spend classification
 * (`GET /reports/spending-facts` → `isRealSpend`), so transfers, debt/loan
 * payments, and uncategorized rows are excluded — the totals match the Spending
 * tab exactly. This component computes no money the server owns (CLAUDE.md §1).
 */
export function ChaseInsightStrip({ range }: { range: DateRange }) {
  const prior = useMemo(() => priorWindow(range), [range]);

  const { data: cur } = useGetReportsSpendingFacts(
    { from: range.from, to: range.to },
    {
      query: {
        queryKey: getGetReportsSpendingFactsQueryKey({ from: range.from, to: range.to }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );
  const { data: prev } = useGetReportsSpendingFacts(
    { from: prior.from, to: prior.to },
    {
      query: {
        queryKey: getGetReportsSpendingFactsQueryKey({ from: prior.from, to: prior.to }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );

  const period = PERIOD_WORD[range.mode];
  const curTotal = cur?.realSpend.total ?? 0;
  const prevTotal = prev?.realSpend.total ?? 0;
  const pct = prevTotal > 0 ? ((curTotal - prevTotal) / prevTotal) * 100 : null;

  // Top 5 real categories for the window (spending-facts already excludes the
  // uncategorized bucket from real spend; filter defensively like the Spending
  // tab in case the server ever surfaces it as a named category).
  const mix = useMemo(
    () =>
      (cur?.byCategory ?? [])
        .filter((c) => !/uncategorized/i.test(c.name))
        .slice(0, 5)
        .map((c, i) => ({
          label: c.name,
          value: c.total,
          color: MIX_COLORS[i % MIX_COLORS.length],
        })),
    [cur],
  );

  // Hide the strip only once we have data and there's genuinely nothing to show.
  if (cur && curTotal === 0 && !mix.length) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              Spend this {period}
            </span>
            {pct != null && <DeltaPill value={pct} invert />}
          </div>
          <div className="text-2xl font-bold">
            <MoneyText amount={curTotal} />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            vs <MoneyText amount={prevTotal} className="text-foreground" /> last {period}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-5">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium mb-3">
            {range.label} · category mix
          </div>
          {mix.length ? (
            <StackBar segments={mix} legendMax={4} />
          ) : (
            <div className="text-xs text-muted-foreground">No categorized spend yet.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
