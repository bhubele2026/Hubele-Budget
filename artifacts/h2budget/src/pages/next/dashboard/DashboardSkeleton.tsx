/**
 * ⭐ THE SHELL THAT PAINTS BEFORE CLERK ANSWERS. The dashboard's layout with
 * zero numbers, so a browser whose session turns out to be stale cannot have
 * seen a single figure. Nothing here reads a query. App.tsx renders it while
 * Clerk is still resolving on a returning visitor. Same shapes, same order as
 * the page: header, the one-surface summary row, the forecast row, accounts.
 */
const BELOW: Array<{ span: string; rows: number }> = [
  { span: "span-8", rows: 9 },
  { span: "span-4", rows: 6 },
  { span: "span-12", rows: 3 },
];

export function DashboardSkeleton() {
  return (
    <div data-testid="dashboard-skeleton" aria-busy="true" className="lg:pb-14">
      <div className="grid-12">
        <div className="span-12">
          <div className="skeleton h-8 w-48 rounded-control" />
          <div className="skeleton mt-2 h-4 w-80 max-w-full rounded" />
          <div className="skeleton mt-2 h-3 w-56 max-w-full rounded" />
        </div>
        <div className="panel tile-in span-12">
          <div className="kpi-grid">
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <div className="skeleton h-3 w-24 rounded" />
                <div className="skeleton mt-2 h-7 w-32 max-w-full rounded" />
                <div className="skeleton mt-2 h-3 w-40 max-w-full rounded" />
              </div>
            ))}
          </div>
        </div>
        {BELOW.map((p, i) => (
          <div key={i} className={`panel tile-in ${p.span} p-4`} style={{ animationDelay: `calc(${i + 1} * var(--stagger))` }}>
            <div className="skeleton h-4 w-24 rounded" />
            <div className="mt-4 space-y-2">
              {Array.from({ length: p.rows }, (_, r) => (
                <div key={r} className="skeleton h-5 w-full rounded-control" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
