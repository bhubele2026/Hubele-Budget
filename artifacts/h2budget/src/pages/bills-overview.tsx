import { useMemo } from "react";
import {
  useGetBillsSummary,
  getGetBillsSummaryQueryKey,
} from "@workspace/api-client-react";
import { useSpine } from "@/hooks/useSpine";
import { useIsMobile } from "@/hooks/use-mobile";
import { CssBars, type CssBarRow } from "@/lib/cssBars";
import { card, cardHead, emptyNote, Foot, Help, Stat, td, tdNum } from "@/ui";
import { formatCurrency, formatDate } from "@/lib/utils";

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Bills → Overview tab. The month's money in one read: what is due next, what
 * recurs, and what is left.
 *
 * ⚠️ THE HEADLINE IS THE SPINE'S, NOT OURS. `nextBill` and `billsDueCount` are
 * read straight from `useSpine()` and never re-derived from the summary rows —
 * the landing, this page and the forecast quote one snapshot, so they cannot
 * describe the same household at two different moments. The month table below
 * is server-computed by `/bills/summary`; it carries figures the spine does not.
 */
export default function BillsOverviewPage() {
  const { data: summary } = useGetBillsSummary(undefined, {
    query: { queryKey: getGetBillsSummaryQueryKey(), staleTime: 5 * 60_000 },
  });
  const { data: spine } = useSpine();
  // ⚠️ `CssBars` sizes its label and value columns in pixels. At the desktop
  // widths those columns leave the bar ~900px; on a 390px phone they leave it
  // about 40px, and a bar that short stops carrying the magnitude it exists to
  // show. Narrow them on small screens instead.
  const isMobile = useIsMobile();

  const nextBill = spine?.nextBill ?? null;
  const billsDueCount = spine?.billsDueCount;

  const m = summary?.monthly;
  const income = num(m?.income);
  const bills = num(m?.bills);
  const debtMin = num(m?.debtMin);
  const outflow = num(m?.totalOutflow);
  const net = num(m?.net);

  // Stable identity order (by id) — `CssBars` derives rank itself and slides
  // rows to it; re-sorting the array between renders would defeat the glide.
  const billRows = useMemo<CssBarRow[]>(
    () =>
      (summary?.bills ?? [])
        .map((r) => ({
          id: r.item.id,
          label: r.item.name,
          value: num(r.monthlyAmount),
        }))
        .filter((b) => b.value > 0)
        .sort((a, b) => a.id.localeCompare(b.id)),
    [summary],
  );

  const outflowRatio = income > 0 ? outflow / income : 0;
  const committedPct = income > 0 ? Math.round(outflowRatio * 100) : 0;
  const short = net < 0;

  return (
    <div className="space-y-5" data-testid="bills-overview">
      {/* The ribbon above already says "Bills · Overview" — a second copy of it
          as an <h1> is a word the page does not need. Screen readers still get
          one. */}
      <h1 className="sr-only">Bills overview</h1>

      {/* ── Headline: the spine's two numbers ──────────────────────────────── */}
      <div className="flex flex-wrap gap-3">
        <Stat
          index={0}
          data-testid="stat-next-bill"
          label="Next bill"
          value={nextBill ? formatCurrency(nextBill.amount) : "—"}
          hint={
            nextBill
              ? `${nextBill.name} · ${formatDate(nextBill.dueDate)}`
              : "nothing scheduled"
          }
        />
        <Stat
          index={1}
          data-testid="stat-bills-due"
          label="Bills due"
          value={billsDueCount ?? "—"}
          hint="rest of this month"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── This month ──────────────────────────────────────────────────── */}
        <div className={card} data-testid="bills-month-card">
          <div className={cardHead}>
            <h2 className="text-label font-semibold text-brand-navy">This month</h2>
            <Help>
              Recurring income and bills at their monthly rate plus debt
              minimums, computed server-side by /bills/summary. Net is income
              less everything that goes out.
            </Help>
            <span
              className={`chip ml-auto ${short ? "bad" : "ok"}`}
              data-testid="chip-net-state"
            >
              {short ? "Short" : "Surplus"}
            </span>
          </div>

          <table className="w-full">
            <tbody>
              <tr>
                <td className={td}>Income</td>
                <td className={tdNum} data-testid="text-overview-income">
                  {formatCurrency(income)}
                </td>
              </tr>
              <tr>
                <td className={td}>Recurring bills</td>
                <td className={tdNum} data-testid="text-overview-bills">
                  {formatCurrency(bills)}
                </td>
              </tr>
              <tr>
                <td className={td}>Debt minimums</td>
                <td className={tdNum} data-testid="text-overview-debt-min">
                  {formatCurrency(debtMin)}
                </td>
              </tr>
              <tr>
                <td className={`${td} text-neutral-500`}>Total out</td>
                <td
                  className={`${tdNum} text-neutral-500`}
                  data-testid="text-overview-outflow"
                >
                  {formatCurrency(outflow)}
                </td>
              </tr>
              <tr>
                <td className={`${td} border-b-0 font-semibold text-brand-navy`}>
                  Net
                </td>
                <td
                  className={`${tdNum} border-b-0 text-title font-semibold ${
                    short ? "text-bad" : "text-brand-navy"
                  }`}
                  data-testid="text-overview-net"
                >
                  {formatCurrency(net)}
                </td>
              </tr>
            </tbody>
          </table>

          {/* Where the outflow sits against income. A meter, not a ring — the
              magnitude is the only thing being said. */}
          <div className="px-4 pb-3">
            <div className="flex items-baseline justify-between">
              <span className="text-micro font-semibold uppercase tracking-wide text-neutral-500">
                Committed
              </span>
              <span
                className="font-mono text-label font-semibold tabular-nums text-brand-navy"
                data-testid="text-overview-committed"
              >
                {committedPct}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-brand-line">
              <div
                className={`bar-sweep h-full rounded-full ${short ? "bg-bad" : "bg-brand-navy"}`}
                style={{ width: `${Math.min(100, Math.max(0, committedPct))}%` }}
              />
            </div>
          </div>

          <Foot>Of every income dollar, {committedPct}¢ is already spoken for.</Foot>
        </div>

        {/* ── Biggest recurring bills ─────────────────────────────────────── */}
        <div className={`${card} lg:col-span-2`} data-testid="bills-biggest-card">
          <div className={cardHead}>
            <h2 className="text-label font-semibold text-brand-navy">
              Biggest recurring bills
            </h2>
            <Help>
              Each bill at its monthly rate, ranked. Paused items and debt
              minimums are not in this list.
            </Help>
            <span className="ml-auto text-micro text-neutral-400">per month</span>
          </div>
          {billRows.length ? (
            <div className="px-4 py-3">
              <CssBars
                rows={billRows}
                topN={6}
                ramp
                format={(v) => formatCurrency(v)}
                labelWidth={isMobile ? 92 : 150}
                valueWidth={isMobile ? 78 : 96}
                rowHeight={30}
                ariaLabel="Biggest recurring bills, per month"
              />
            </div>
          ) : (
            <p className={emptyNote}>No recurring bills</p>
          )}
        </div>
      </div>
    </div>
  );
}
