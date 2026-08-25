import { Link } from "wouter";
import { CssFillMeter } from "@/lib/cssBars";
import { useWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import { btnLink, card, cardHead, Foot, Help } from "@/ui";
import { formatCurrency } from "@/lib/utils";
import type { BudgetMonthDetail } from "@workspace/api-client-react";

const n = (v: string | number | null | undefined): number => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
};

const HEAD = "text-micro font-semibold uppercase tracking-wide text-neutral-400";

const BUCKET_LABEL: Record<string, string> = {
  weekly: "Weekly allowance",
  monthly: "Monthly allowance",
  unplanned: "Unplanned",
};

/**
 * ⭐ THE CARD THAT FIXES THE DOUBLE COUNT.
 *
 * Brad: *"there is a 1800 weekly, but also weekly in dining and groceries."*
 * He was reading three representations of one pot of money — the `Weekly Spend`
 * bill, the allowance cap, and separate Groceries / Dining envelopes — laid out
 * as if they were three different obligations.
 *
 * ⚠️ NESTED, NOT SIBLINGS. Groceries and Dining are SLICES of the weekly
 * allowance, so they render indented underneath it behind a rail, in a lighter
 * ink, with no plan of their own. The five slices always sum to the weekly
 * figure above them (the server folds unfiled weekly spend into `misc` to
 * guarantee it) — a breakdown that does not add up to the number it sits under
 * is worse than no breakdown at all.
 *
 * ⚠️ AND THE WHOLE CARD IS TRACKED, NOT PLANNED. Its money is already in the
 * plan as the recurring items that fund it, which is why nothing here reaches
 * `planBySource.plannedTotal` and why the foot says so in words.
 *
 * ⚠️ IT USES THE SAME COLUMN GRID AS A PLAN SECTION. The first draft gave it
 * its own four-column layout, and the meters landed 400px left of every other
 * meter on the page — which made the two halves read as two different tables
 * that happened to be stacked.
 */
export function AllowanceCard({
  allowance,
  rowGrid,
  index,
}: {
  allowance: BudgetMonthDetail["allowance"];
  /** The plan sections' row grid, so every column on the page shares an edge. */
  rowGrid: string;
  index: number;
}) {
  const labels = useWeeklyBucketLabels();
  const lines = allowance?.lines ?? [];
  const hasData = lines.some((l) => n(l.planned) > 0 || n(l.actual) > 0);
  if (!hasData) return null;

  return (
    <section
      className={`${card} tile-in`}
      style={{ animationDelay: `calc(${Math.min(index, 12)} * var(--stagger))` }}
      data-testid="section-allowance"
    >
      <div className={cardHead}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-title font-semibold text-brand-navy">
              Allowance
            </span>
            <span className="chip gray" data-testid="section-allowance-not-in-plan">
              already in the plan
            </span>
          </div>
          <div className="text-micro text-neutral-400">Filed spend, by bucket</div>
        </div>
        <Help>
          {`Spend you filed into a bucket yourself — unfiled spend counts in none of the three. The caps come from Settings; the weekly one is scaled to this month by ${allowance.weeksInMonth} weeks.`}
        </Help>
        <div className="text-right">
          <div
            className="font-mono text-label font-semibold tabular-nums text-brand-navy"
            data-testid="allowance-total"
          >
            {formatCurrency(allowance.planned)}
          </div>
          <div className="font-mono text-micro tabular-nums text-neutral-400">
            {formatCurrency(allowance.actual)} spent
          </div>
        </div>
        <Link href="/allowances" className={btnLink} data-testid="budget-allowances-manage">
          Manage
        </Link>
      </div>

      {/* Its own words for its own columns: this card tracks spend against a
          CAP, it does not plan. Same geometry as the sections above so the
          five columns line up down the whole page. */}
      <div
        role="row"
        className={`hidden border-b border-brand-line bg-platinum-2 sm:grid ${rowGrid
          .replace("grid ", "")
          .replace("py-2", "py-1.5")}`}
      >
        <span className={HEAD}>Bucket</span>
        <span className={`${HEAD} text-right`}>Cap</span>
        <span className={`${HEAD} text-right`}>Spent</span>
        <span className={`${HEAD} text-right`}>Used</span>
        <span className={`${HEAD} text-right`}>Left / over</span>
      </div>

      <div className="divide-y divide-brand-line/70">
        {lines.map((l) => {
          const planned = n(l.planned);
          const actual = n(l.actual);
          const over = planned > 0 && actual > planned;
          const pct = planned > 0 ? Math.round((actual / planned) * 100) : null;
          const slices = (l.subBuckets ?? []).filter((s) => n(s.actual) > 0);
          return (
            <div key={l.bucket} data-testid={`allowance-row-${l.bucket}`}>
              <div className={rowGrid}>
                <span className="min-w-0 truncate text-body font-medium text-brand-navy">
                  {BUCKET_LABEL[l.bucket] ?? l.bucket}
                </span>
                <Col label="Cap">
                  <span className="font-mono text-label tabular-nums text-neutral-700">
                    {planned > 0 ? formatCurrency(planned) : "—"}
                  </span>
                </Col>
                <Col label="Spent">
                  <span className="font-mono text-label tabular-nums text-neutral-700">
                    {formatCurrency(actual)}
                  </span>
                </Col>
                <Col label="Used" className="sm:text-left">
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <CssFillMeter
                      className="min-w-[2.5rem] flex-1"
                      value={actual}
                      ceiling={planned}
                      title={`${formatCurrency(actual)} of ${
                        planned > 0 ? formatCurrency(planned) : "no cap"
                      }`}
                    />
                    <span className="w-[2.75rem] shrink-0 text-right font-mono text-label tabular-nums text-neutral-500">
                      {pct === null ? "—" : `${pct}%`}
                    </span>
                  </div>
                </Col>
                <Col label="Left / over">
                  <span className="sm:justify-self-end">
                    {planned > 0 ? (
                      <span className={`chip ${over ? "bad" : "gray"}`}>
                        {over
                          ? `${formatCurrency(actual - planned)} over`
                          : `${formatCurrency(planned - actual)} left`}
                      </span>
                    ) : (
                      <span className="text-micro text-neutral-400">no cap set</span>
                    )}
                  </span>
                </Col>
              </div>

              {/* The slices. Indented behind a rail so they read as parts of the
                  figure above and never as further spending on top of it. They
                  hold the same right edge as the Spent column, because that is
                  the column they are a breakdown OF. */}
              {slices.length > 0 && (
                <ul
                  className="mb-2 ml-4 border-l-2 border-brand-line pl-4"
                  data-testid={`allowance-slices-${l.bucket}`}
                >
                  {slices.map((s) => (
                    <li
                      key={s.bucket}
                      className={`${rowGrid} !py-1`}
                      data-testid={`allowance-slice-${l.bucket}-${s.bucket}`}
                    >
                      <span className="min-w-0 truncate text-micro text-neutral-500">
                        {labels[s.bucket as keyof typeof labels] ?? s.bucket}
                      </span>
                      <span />
                      <span className="text-right font-mono text-micro tabular-nums text-neutral-400">
                        {formatCurrency(s.actual)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <Foot>
        Tracked, not planned again — this money is already in the plan above as
        the bills that fund it. The slices under Weekly are parts of it, not
        spending on top of it.
      </Foot>
    </section>
  );
}

/** A figure and, on the phone only, the word for its column. Mirrors `Cell`
 *  on the plan rows so both tables collapse the same way. */
function Col({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 sm:block sm:text-right ${className ?? ""}`}
    >
      <span className="text-micro font-semibold uppercase tracking-wide text-neutral-500 sm:hidden">
        {label}
      </span>
      {children}
    </div>
  );
}
