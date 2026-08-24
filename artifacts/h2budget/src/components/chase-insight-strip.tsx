import { useMemo, type ReactNode } from "react";
import {
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
} from "@workspace/api-client-react";
import { StackBar } from "@/components/viz";
import { card, cardHead, fieldLabel, Help } from "@/ui";
import { rangeDays, type DateRange } from "@/lib/timeRange";
import { formatCurrency } from "@/lib/utils";

/**
 * Category-mix colours, DARKEST FIRST.
 *
 * ⚠️ These are the navy ramp (`--chart-1..5` were rebound to it in B1), and a
 * mix is rank-ordered — the server returns `byCategory` largest first. So the
 * array must walk the ramp monotonically dark → light, or the biggest category
 * draws lighter than the third biggest and the ramp stops meaning anything
 * (chart law 2: sequential data is indexed by RANK).
 */
const MIX_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
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
 * Period spend and where it went: the window's real-spend total against the
 * equal-length window before it, plus the category mix.
 *
 * Both halves pull the server's real-spend classification
 * (`GET /reports/spending-facts` → `isRealSpend`), so transfers, debt/loan
 * payments, and uncategorized rows are excluded — the totals match the
 * Spending tab exactly, and the same basis the spine's `spentMonth` uses. This
 * component computes no money the server owns (CLAUDE.md §1).
 *
 * `actions` docks page controls (sync, freshness) in the card head.
 */
export function ChaseInsightStrip({
  range,
  actions,
}: {
  range: DateRange;
  actions?: ReactNode;
}) {
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

  // Hide the strip only once we have data and there's genuinely nothing to
  // show — unless the head is carrying page controls, which must not vanish.
  if (cur && curTotal === 0 && !mix.length && !actions) return null;

  // ⚠️ Rounded to whole percent for the chip, so the WORD and the number agree:
  // a +0.4% move reads "0%", and calling that "up" would be a lie.
  const pctRounded = pct == null ? null : Math.round(pct);

  return (
    <section className={card} data-testid="chase-insight-strip">
      <div className={cardHead}>
        <h2 className="text-title font-semibold text-brand-navy">
          Spend this {period}
        </h2>
        <Help>
          Real spend only, classified by the server: transfers, debt and loan
          payments, and uncategorized rows are excluded. Compared against the
          equal-length window immediately before this one.
        </Help>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>

      <div className="grid gap-5 p-4 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-8">
        <div>
          <div
            className="font-mono text-display font-semibold tabular-nums text-brand-navy"
            data-testid="strip-spend-total"
          >
            {formatCurrency(curTotal)}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {pctRounded != null && (
              <span className={`chip ${pctRounded > 0 ? "bad" : "gray"}`}>
                {pctRounded > 0 ? "up" : pctRounded < 0 ? "down" : "flat"}{" "}
                {Math.abs(pctRounded)}%
              </span>
            )}
            <span className="text-micro text-neutral-400">
              vs {formatCurrency(prevTotal)} last {period}
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <div className={fieldLabel}>Category mix</div>
          <div className="mt-2.5">
            {mix.length ? (
              <StackBar segments={mix} legendMax={4} />
            ) : (
              <span className="text-micro text-neutral-400">
                No categorized spend yet.
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
