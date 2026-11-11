import { CALM_STROKE, CHART, MARKER, type MarkerKind } from "@/lib/chartTokens";
import { MARKER_LABEL } from "@/lib/forecastEventKinds";

function Swatch({ kind }: { kind: MarkerKind }) {
  const f = MARKER[kind];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {kind === "payday" && <path d="M7 1 L1.5 11 L12.5 11 Z" fill={f} />}
      {kind === "bill" && <circle cx="7" cy="7" r="5" fill={f} />}
      {kind === "card" && <rect x="2" y="2" width="10" height="10" fill={f} />}
      {kind === "debt" && <path d="M7 0.5 L13.5 7 L7 13.5 L0.5 7 Z" fill={f} />}
    </svg>
  );
}

function Line({ dashed, color, thin }: { dashed?: boolean; color: string; thin?: boolean }) {
  return (
    <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true">
      <line x1="1" y1="4" x2="21" y2="4" stroke={color} strokeWidth={thin ? CALM_STROKE.cushion : 2.25} strokeDasharray={dashed ? (thin ? "3 4" : "5 3") : undefined} />
    </svg>
  );
}

/** (Clean forecast line) The clean chart's payday mark: a small tick standing on the bottom edge. */
function PaydayTickSwatch() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <line x1="1" y1="12.5" x2="13" y2="12.5" stroke={CHART.grid} strokeWidth="1" />
      <line x1="7" y1="4" x2="7" y2="11" stroke={MARKER.payday} strokeWidth={CALM_STROKE.paydayTick} strokeLinecap="round" strokeOpacity="0.6" />
    </svg>
  );
}

function Tint({ opacity }: { opacity: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-4 rounded-sm"
      style={{ background: CHART.orangeDeep, opacity }}
    />
  );
}

/** The legend row under the expanded chart: lines, markers (each told apart by
 *  shape AND word) and the two risk tints.
 *
 *  ⭐ (Readable forecast) With `onToggleBills` the legend carries the calm
 *  chart's "Show bills" switch: Payday is the only marker listed until it is
 *  on; then Bill, Card payment and Debt payment join it, as on the chart.
 *
 *  ⭐ (Clean forecast line) Calm with the bills hidden is the short legend of
 *  the clean chart: Balance · Cushion · Payday, and "Under cushion" / "Below
 *  zero" only when the chart really has such days (`hasUnder`, `hasNegative`).
 *  "Show bills" brings the full legend back exactly as it was. */
export function ChartLegend({
  showBills,
  onToggleBills,
  hasUnder = false,
  hasNegative = false,
  short = false,
}: {
  showBills?: boolean;
  onToggleBills?: () => void;
  hasUnder?: boolean;
  hasNegative?: boolean;
  /** (Home says less) The clean chart's short legend with no "Show bills" switch: the home page's chart. */
  short?: boolean;
} = {}) {
  const item = "inline-flex items-center gap-1.5 text-micro text-neutral-600";
  const calm = !!onToggleBills;
  const clean = short || (calm && !showBills);
  const kinds = (Object.keys(MARKER) as MarkerKind[]).filter((k) => !calm || showBills || k === "payday");
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" data-testid="chart-legend" aria-label="Chart legend">
      {clean ? (
        <>
          <li className={item} data-testid="legend-balance"><Line color={CHART.navy} />Balance</li>
          <li className={item} data-testid="legend-cushion"><Line color={CHART.orangeDeep} dashed thin />Cushion</li>
          <li className={item} data-testid="legend-payday"><PaydayTickSwatch />{MARKER_LABEL.payday}</li>
          {hasUnder ? <li className={item} data-testid="legend-under-buffer"><Tint opacity={0.18} />Under cushion</li> : null}
          {hasNegative ? <li className={item} data-testid="legend-below-zero"><Tint opacity={0.42} />Below zero</li> : null}
        </>
      ) : (
        <>
          <li className={item}><Line color={CHART.navy} />Actual</li>
          <li className={item}><Line color={CHART.mid} dashed />Projected</li>
          <li className={item}><Line color={CHART.orangeDeep} dashed />Cash buffer</li>
          {kinds.map((k) => (
            <li key={k} className={item} data-testid={`legend-${k}`}>
              <Swatch kind={k} />
              {MARKER_LABEL[k]}
            </li>
          ))}
          <li className={item} data-testid="legend-under-buffer"><Tint opacity={0.18} />Under buffer</li>
          <li className={item} data-testid="legend-below-zero"><Tint opacity={0.42} />Below zero</li>
        </>
      )}
      {calm ? (
        <li className="ml-auto">
          <button
            type="button"
            onClick={onToggleBills}
            aria-pressed={!!showBills}
            className={`press inline-flex items-center rounded-control px-2.5 py-1 text-micro font-semibold ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 ${
              showBills ? "bg-brand-navy text-white ring-brand-navy" : "bg-white text-brand-navy ring-brand-line hover:bg-neutral-50"
            }`}
            data-testid="chart-show-bills"
          >
            Show bills
          </button>
        </li>
      ) : null}
    </ul>
  );
}
