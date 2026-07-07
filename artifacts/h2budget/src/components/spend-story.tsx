import { useMemo, useState } from "react";
import { Sparkles, ChevronDown } from "lucide-react";
import {
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
  useGetReportsSpendingStory,
  getGetReportsSpendingStoryQueryKey,
  type SpendingStoryLens,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkline, StackBar, MiniBars } from "@/components/viz";
import { cn } from "@/lib/utils";

const MIX_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-5))",
];

const DOW_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * One glanceable spending graphic that expands in place to reveal Fable 5's read
 * of that story. Collapsed = eyebrow + graphic only (no words); click opens the
 * Fable analysis. The graphic is inert (static SVG) so the whole card is one
 * click target. Money is computed server-side; Fable only writes the language.
 */
function SpendStoryCard({
  eyebrow,
  visual,
  lens,
  loading,
  testid,
}: {
  eyebrow: string;
  visual: React.ReactNode;
  lens: SpendingStoryLens | undefined;
  loading: boolean;
  testid: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={testid}
        className="block w-full text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              {eyebrow}
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
              />
            </span>
          </div>
          <div className="min-h-[44px]">{visual}</div>
        </CardContent>
      </button>
      {open && (
        <div className="border-t border-card-border bg-muted/30 px-4 py-3 animate-in fade-in slide-in-from-top-1 duration-200">
          {loading && !lens ? (
            <p className="text-xs text-muted-foreground">Reading your spending…</p>
          ) : lens ? (
            <div className="space-y-1.5">
              <div className="flex items-start gap-1.5">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="text-[13px] font-bold leading-snug">{lens.headline}</span>
              </div>
              {lens.bullets.length > 0 && (
                <ul className="space-y-1 pl-5 text-xs text-muted-foreground">
                  {lens.bullets.map((b, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
                      <span className="leading-snug">{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No read available yet.</p>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * The Overview "spending story" — a row of four minimal, hoverable/clickable
 * graphics (household-wide Amex + Chase) that each open Fable 5's analysis. Data
 * = server-computed spending-facts for the current month; the narrative = the
 * cached Fable read from GET /reports/spending-story. Reuses the viz kit only.
 */
export function SpendStorySection() {
  const { from, to } = useMemo(() => {
    const now = new Date();
    return {
      from: isoOf(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: isoOf(now),
    };
  }, []);

  const { data: facts } = useGetReportsSpendingFacts(
    { from, to },
    {
      query: {
        queryKey: getGetReportsSpendingFactsQueryKey({ from, to }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );
  const { data: story, isLoading: storyLoading } = useGetReportsSpendingStory(
    { from, to },
    {
      query: {
        queryKey: getGetReportsSpendingStoryQueryKey({ from, to }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );
  const lenses = story?.lenses;

  const trendData = useMemo(
    () => (facts?.dailyBuckets ?? []).map((d) => d.total),
    [facts],
  );
  const categorySegments = useMemo(
    () =>
      (facts?.byCategory ?? [])
        .filter((c) => !/uncategorized/i.test(c.name))
        .slice(0, 5)
        .map((c, i) => ({
          label: c.name,
          value: c.total,
          color: MIX_COLORS[i % MIX_COLORS.length],
        })),
    [facts],
  );
  const merchantBars = useMemo(
    () =>
      (facts?.byMerchant ?? []).slice(0, 6).map((m) => ({
        value: m.total,
        label: `${m.name}: ${Math.round(m.total).toLocaleString("en-US")}`,
      })),
    [facts],
  );
  const dowBars = useMemo(() => {
    const byDow = new Map((facts?.dayOfWeek ?? []).map((d) => [d.dow, d]));
    return Array.from({ length: 7 }, (_, dow) => {
      const d = byDow.get(dow);
      return {
        value: d?.avgPerDay ?? 0,
        label: `${DOW_LETTERS[dow]} · ${Math.round(d?.total ?? 0).toLocaleString("en-US")}`,
      };
    });
  }, [facts]);

  return (
    <div
      className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      data-testid="cc-spend-story"
    >
      <SpendStoryCard
        eyebrow="Spend trend"
        testid="spend-story-trend"
        loading={storyLoading}
        lens={lenses?.trend}
        visual={
          trendData.length > 1 ? (
            <Sparkline data={trendData} variant="area" height={44} />
          ) : (
            <div className="flex h-11 items-center text-xs text-muted-foreground">
              Not enough data yet
            </div>
          )
        }
      />
      <SpendStoryCard
        eyebrow="Where it goes"
        testid="spend-story-category"
        loading={storyLoading}
        lens={lenses?.category}
        visual={
          categorySegments.length ? (
            <StackBar segments={categorySegments} height={12} money legendMax={3} />
          ) : (
            <div className="flex h-11 items-center text-xs text-muted-foreground">
              Nothing categorized yet
            </div>
          )
        }
      />
      <SpendStoryCard
        eyebrow="Who's getting paid"
        testid="spend-story-merchants"
        loading={storyLoading}
        lens={lenses?.merchants}
        visual={
          merchantBars.some((b) => b.value > 0) ? (
            <MiniBars data={merchantBars} height={44} />
          ) : (
            <div className="flex h-11 items-center text-xs text-muted-foreground">
              No merchants yet
            </div>
          )
        }
      />
      <SpendStoryCard
        eyebrow="When you spend"
        testid="spend-story-dayofweek"
        loading={storyLoading}
        lens={lenses?.dayOfWeek}
        visual={
          dowBars.some((b) => b.value > 0) ? (
            <MiniBars data={dowBars} height={44} accent="hsl(var(--chart-3))" />
          ) : (
            <div className="flex h-11 items-center text-xs text-muted-foreground">
              No weekly pattern yet
            </div>
          )
        }
      />
    </div>
  );
}
