import { CHART, MARKER, type MarkerKind } from "@/lib/chartTokens";
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

function Line({ dashed, color }: { dashed?: boolean; color: string }) {
  return (
    <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true">
      <line x1="1" y1="4" x2="21" y2="4" stroke={color} strokeWidth="2.25" strokeDasharray={dashed ? "5 3" : undefined} />
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
 *  shape AND word) and the two risk tints. */
export function ChartLegend() {
  const item = "inline-flex items-center gap-1.5 text-micro text-neutral-600";
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" data-testid="chart-legend" aria-label="Chart legend">
      <li className={item}><Line color={CHART.navy} />Actual</li>
      <li className={item}><Line color={CHART.mid} dashed />Projected</li>
      <li className={item}><Line color={CHART.orangeDeep} dashed />Cash buffer</li>
      {(Object.keys(MARKER) as MarkerKind[]).map((k) => (
        <li key={k} className={item} data-testid={`legend-${k}`}>
          <Swatch kind={k} />
          {MARKER_LABEL[k]}
        </li>
      ))}
      <li className={item} data-testid="legend-under-buffer"><Tint opacity={0.18} />Under buffer</li>
      <li className={item} data-testid="legend-below-zero"><Tint opacity={0.42} />Below zero</li>
    </ul>
  );
}
