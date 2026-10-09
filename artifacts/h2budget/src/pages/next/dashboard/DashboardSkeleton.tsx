/**
 * ⭐ THE SHELL THAT PAINTS BEFORE CLERK ANSWERS. The dashboard's panel grid with
 * zero numbers, so a browser whose session turns out to be stale cannot have
 * seen a single figure. Nothing here reads a query. App.tsx renders it while
 * Clerk is still resolving on a returning visitor.
 */
const PANELS: Array<{ span: string; rows: number }> = [
  { span: "span-12", rows: 2 },
  { span: "span-12", rows: 3 },
  { span: "span-4", rows: 5 },
  { span: "span-4", rows: 6 },
  { span: "span-4", rows: 4 },
  { span: "span-8", rows: 6 },
  { span: "span-4", rows: 5 },
];

export function DashboardSkeleton() {
  return (
    <div data-testid="dashboard-skeleton" aria-busy="true" className="lg:pb-14">
      <div className="skeleton mb-4 h-8 w-40 rounded-control" />
      <div className="grid-12">
        {PANELS.map((p, i) => (
          <div key={i} className={`panel tile-in ${p.span} p-4`} style={{ animationDelay: `calc(${i} * var(--stagger))` }}>
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
