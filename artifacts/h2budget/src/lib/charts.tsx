import { useMemo, useEffect, useRef, useState, type ReactElement } from "react";
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea,
  ResponsiveContainer,
  LabelList,
  Cell,
  PieChart,
  Pie,
} from "recharts";
import { cn, formatCurrency } from "@/lib/utils";
import {
  ANIM_BAR,
  ANIM_LINE,
  AXIS_TICK,
  CHART,
  LEGEND_STYLE,
  REVEAL_MS,
  animBegin,
  compactUSD,
  niceAxis,
} from "@/lib/chartTokens";

/**
 * The H2 chart kit — one system, so charts stop being ad-hoc.
 *
 * Every chart on every page draws from the same tokens, the same axis and
 * grid styling, the same tooltip surface and the same motion timings. Pages
 * import from here; they do not reach for recharts directly and they do not
 * invent a local palette.
 *
 * ── THE LAWS ──────────────────────────────────────────────────────────────
 * 1. navy = good, `#e16d3e` = bad, grey = neutral — and the LABEL always says
 *    which. Colour is never the only carrier of meaning.
 * 2. Sequential data uses `NAVY_RAMP` indexed by RANK (`rampByRank`), never
 *    handed out per series.
 * 3. Many-series charts use `CAT8`, capped at 8, with the tail rolled into
 *    "Other" (`OTHER_GREY`). A colour marks identity, so it survives filters.
 * 4. Hover-scrubbed and rapidly-updating lists are **CSS bars** (`CssBars`),
 *    NEVER recharts — recharts restarts its draw on every data-reference
 *    change, so a hover-driven recharts chart strobes.
 * 5. No colour aliases. Two names for one hex is how two series silently draw
 *    the same pixel.
 *
 * The tokens and pure helpers live in `./chartTokens` (dependency-free) and
 * are re-exported here so `@/lib/charts` is the single import path for
 * charting pages. `CssBars` lives in `./cssBars`.
 *
 * ⚠️ **Import discipline.** This module statically imports recharts (~450 KB).
 * It must only ever be reached from a LAZY route chunk —
 * `scripts/check-entry-graph.mjs` fails the build if a recharts fingerprint
 * lands in the landing graph. If you only need CSS bars or the tokens, import
 * `@/lib/cssBars` or `@/lib/chartTokens` directly and stay recharts-free.
 */

// Tokens, motion presets and pure helpers — re-exported so pages have one path.
export * from "@/lib/chartTokens";
export { CssBars, type CssBarRow } from "@/lib/cssBars";

// ── Shared formatting ──────────────────────────────────────────────────────
/** "2026-03" / "2026-03-14" → "Mar 26". Anything else passes through. */
const shortMonth = (ym: string): string =>
  /^\d{4}-\d{2}/.test(ym)
    ? new Date(ym.slice(0, 7) + "-01T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        year: "2-digit",
      })
    : ym;

const intAxis = (v: unknown) => Math.round(Number(v)).toLocaleString();
const pctAxis = (v: unknown) => `${(Number(v) * 100).toFixed(0)}%`;
const pctTip = (v: unknown) => `${(Number(v) * 100).toFixed(1)}%`;
const usdAxis = (v: unknown) => compactUSD(Number(v));
const usdTip = (v: unknown) => formatCurrency(Number(v));

export type AxisFmt = "usd" | "int" | "pct";
const axisFmtFn = (f: AxisFmt) =>
  f === "usd" ? usdAxis : f === "int" ? intAxis : pctAxis;
const tipFmtFn = (f: AxisFmt) =>
  f === "usd" ? usdTip : f === "int" ? intAxis : pctTip;

export interface SeriesDef {
  key: string;
  name: string;
  color: string;
  dashed?: boolean;
  /** Suppress point labels for this series (e.g. a flat reference line). */
  noLabels?: boolean;
}

/** How a chart labels its points. */
export type LabelMode = "all" | "none";

/** A shaded span of the x-axis — e.g. the weeks that are actuals, not forecast. */
export interface ChartBand {
  x1: string | number;
  x2: string | number;
}

/**
 * Platinum step 4 — the same wash `--color-platinum-4` paints raised neutral
 * surfaces with. It was #eef2f7 until the D1 colour audit read it out of the
 * built bundle: three hex digits off the ramp, invisible on screen, and exactly
 * the drift that ends with a palette nobody can grep for.
 */
const BAND_FILL = "#eef3fa";

const bandAreas = (bands?: ChartBand[]) =>
  bands?.map((b) => (
    <ReferenceArea
      key={`${b.x1}|${b.x2}`}
      x1={b.x1}
      x2={b.x2}
      fill={BAND_FILL}
      fillOpacity={1}
      stroke="none"
    />
  )) ?? null;

// ── Ticks ──────────────────────────────────────────────────────────────────
/**
 * Evenly-spaced x-axis ticks (~12) that ALWAYS include the newest point.
 * Recharts' `interval="preserveStartEnd"` collapses a long series to just its
 * start and end; this keeps a readable spread that never overlaps.
 */
function xTicks(data: Array<Record<string, unknown>>, xKey: string): unknown[] {
  const xs = data.map((d) => d[xKey]);
  if (xs.length <= 13) return xs; // months / quarters: label every point
  const step = Math.ceil(xs.length / 12);
  return xs.filter((_, i) => i % step === 0 || i === xs.length - 1);
}

/**
 * Memoized ticks with a STABLE reference across re-renders.
 *
 * Handing recharts' `ticks` prop a fresh array on every render bumps its
 * internal animation id and RESTARTS the draw, forever — the chart never
 * finishes growing, it just snaps to final and pops. Keying the memo on
 * primitives (length + first/last x) holds the reference steady until the
 * data genuinely changes.
 */
export function useXTicks(
  data: Array<Record<string, unknown>>,
  xKey: string,
): (string | number)[] {
  const len = data.length;
  const firstX = data[0]?.[xKey];
  const lastX = data[len - 1]?.[xKey];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => xTicks(data, xKey) as (string | number)[], [len, firstX, lastX, xKey]);
}

/**
 * Charts sweep in fully on FIRST paint, then tween quickly on every later
 * data change. Re-running the full reveal on every filter click reads as lag
 * rather than polish.
 */
export function useUpdateDuration(): number {
  const painted = useRef(false);
  const [dur, setDur] = useState(REVEAL_MS);
  useEffect(() => {
    if (painted.current) return;
    painted.current = true;
    const t = setTimeout(() => setDur(Math.round(REVEAL_MS * 0.35)), REVEAL_MS);
    return () => clearTimeout(t);
  }, []);
  return dur;
}

// ── Labels ─────────────────────────────────────────────────────────────────
/** Direct value labels stay readable up to this many non-null points. */
const LABEL_MAX = 36;

/**
 * Per-point value labels for a series, shown only when the series isn't too
 * dense to read. Denser series stay tooltip-only.
 */
export function PointLabels({
  data,
  dataKey,
  fmt,
  color,
  position = "top",
}: {
  data: Array<Record<string, unknown>>;
  dataKey: string;
  fmt: (v: unknown) => string;
  color: string;
  position?: "top" | "bottom" | "insideTop";
}) {
  let nonNull = 0;
  for (const d of data) {
    const v = d[dataKey];
    if (v != null && v !== "") nonNull++;
  }
  if (nonNull === 0 || nonNull > LABEL_MAX) return null;
  return (
    <LabelList
      dataKey={dataKey}
      position={position}
      formatter={fmt}
      style={{ fontSize: 10, fontWeight: 600, fill: color }}
    />
  );
}

/**
 * Category-axis tick that truncates long labels with an ellipsis so they never
 * wrap into two or three colliding lines; the full text shows on hover.
 * Truncation is display-only — the chart's data key is untouched, so
 * click-to-drill still resolves the full name.
 */
export function CatTick(props: {
  x?: number;
  y?: number;
  payload?: { value?: unknown };
  maxChars?: number;
}): ReactElement {
  const { x = 0, y = 0, payload } = props;
  const maxChars = props.maxChars ?? 20;
  const full = String(payload?.value ?? "");
  const text =
    full.length > maxChars ? full.slice(0, maxChars - 1).trimEnd() + "…" : full;
  return (
    <text x={x} y={y} dy="0.32em" textAnchor="end" fontSize={11} fill="#334155">
      {text}
      <title>{full}</title>
    </text>
  );
}

// ── Tooltip ────────────────────────────────────────────────────────────────
/**
 * The kit's tooltip surface. Replaces recharts' grey-outline default — the
 * last library-default surface in the kit — and formats per series.
 */
function SeriesTooltip({
  active,
  payload,
  label,
  series,
  fmt,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | string | null }>;
  label?: string | number;
  series: SeriesDef[];
  fmt: (v: unknown) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const defs = new Map(series.map((s) => [s.key, s]));
  const rows: Array<{ key: string; name: string; color: string; text: string }> = [];
  for (const p of payload) {
    const k = String(p.dataKey ?? "");
    const d = defs.get(k);
    if (!d || p.value == null) continue;
    rows.push({ key: k, name: d.name, color: d.color, text: fmt(p.value) });
  }
  if (rows.length === 0) return null;
  return (
    <div
      className="rounded-lg border bg-card px-3 py-2 text-xs shadow-lg"
      style={{ minWidth: 150 }}
    >
      {label != null && (
        <div className="mb-1 font-semibold text-foreground">
          {shortMonth(String(label))}
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-4">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: r.color }}
              />
              <span className="truncate text-muted-foreground" title={r.name}>
                {r.name}
              </span>
            </span>
            <span className="shrink-0 font-mono tabular-nums text-foreground">
              {r.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Recharts fires the chart onClick with the nearest x-category in
// `activeLabel`, which is reliable anywhere in the plot area — not just on a
// thin line. `gate` suppresses the click when there is no data behind that
// category, so a click never opens an empty drawer.
type ChartClick = { activeLabel?: string } | null;
const pointClick = (
  cb?: (x: string) => void,
  gate?: (x: string) => boolean,
) =>
  cb
    ? (e: ChartClick) => {
        const m = e?.activeLabel;
        if (m && (!gate || gate(m))) cb(m);
      }
    : undefined;

/** True when at least one point is clickable — drives the pointer cursor, so a
 *  chart with nothing behind any point shows no affordance at all. */
const anyClickable = (
  data: Array<Record<string, unknown>>,
  xKey: string,
  cb?: unknown,
  gate?: (x: string) => boolean,
) => !!cb && (!gate || data.some((d) => gate(String(d[xKey]))));

// ── LineTrend ──────────────────────────────────────────────────────────────
/** Multi-line trend over a category axis (balances, spend by month, payoff). */
export function LineTrend({
  data,
  xKey = "month",
  lines,
  height = 300,
  fmt = "usd",
  labelMode = "all",
  bands,
  showLegend = true,
  onPointClick,
  isClickable,
  ariaLabel,
  className,
}: {
  data: Array<Record<string, unknown>>;
  xKey?: string;
  lines: SeriesDef[];
  height?: number;
  fmt?: AxisFmt;
  labelMode?: LabelMode;
  /** Shaded x-spans, e.g. the actual (non-forecast) weeks. */
  bands?: ChartBand[];
  showLegend?: boolean;
  onPointClick?: (x: string) => void;
  isClickable?: (x: string) => boolean;
  /** Names the graphic for screen readers. Say what it shows, not "chart". */
  ariaLabel?: string;
  className?: string;
}) {
  const axisFmt = axisFmtFn(fmt);
  const tipFmt = tipFmtFn(fmt);
  const clickable = anyClickable(data, xKey, onPointClick, isClickable);
  const xtk = useXTicks(data, xKey);
  return (
    <div
      className={cn("chart-in", className)}
      style={{ width: "100%", height }}
      role="img"
      aria-label={ariaLabel}
    >
      <ResponsiveContainer>
        <ComposedChart
          data={data}
          margin={{ top: 20, right: 20, bottom: 4, left: 0 }}
          onClick={pointClick(onPointClick, isClickable)}
          style={clickable ? { cursor: "pointer" } : undefined}
        >
          {bandAreas(bands)}
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
          <XAxis
            dataKey={xKey}
            tickFormatter={shortMonth}
            tick={AXIS_TICK}
            ticks={xtk}
            interval={0}
          />
          <YAxis
            tickFormatter={axisFmt}
            tick={AXIS_TICK}
            width={48}
            domain={fmt === "pct" ? [0, "auto"] : undefined}
          />
          <Tooltip content={<SeriesTooltip series={lines} fmt={tipFmt} />} />
          {showLegend && <Legend wrapperStyle={LEGEND_STYLE} />}
          {lines.map((l, i) => (
            <Line
              key={l.key}
              {...ANIM_LINE}
              animationBegin={animBegin(i)}
              type="monotone"
              dataKey={l.key}
              name={l.name}
              stroke={l.color}
              strokeWidth={2}
              strokeDasharray={l.dashed ? "5 4" : undefined}
              connectNulls={false}
              dot={false}
            >
              {l.noLabels || labelMode === "none"
                ? null
                : PointLabels({ data, dataKey: l.key, fmt: axisFmt, color: l.color })}
            </Line>
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── HBar ───────────────────────────────────────────────────────────────────
/**
 * Horizontal bars — one value per named row (spend by category, balance by
 * card). Negatives take the deep orange; a `colorForRow` override drives
 * sequential encoding via `rampByRank`.
 *
 * For a list that re-reads itself under a moving cursor, use `CssBars`
 * instead — see law 4.
 */
export function HBar({
  data,
  labelKey,
  valueKey,
  height = 320,
  color = CHART.navy,
  negativeColor = CHART.orangeDeep,
  labelWidth = 150,
  maxBarSize = 26,
  colorForRow,
  onClickRow,
  valueFmt = "usd",
  ariaLabel,
  className,
}: {
  data: Array<Record<string, unknown>>;
  labelKey: string;
  valueKey: string;
  height?: number;
  color?: string;
  negativeColor?: string;
  labelWidth?: number;
  maxBarSize?: number;
  /** Per-bar fill, e.g. `(_, i) => rampByRank(i, data.length)`. */
  colorForRow?: (row: Record<string, unknown>, index: number) => string;
  onClickRow?: (row: Record<string, unknown>) => void;
  valueFmt?: AxisFmt;
  ariaLabel?: string;
  className?: string;
}) {
  const animMs = useUpdateDuration();
  const axisFmt = axisFmtFn(valueFmt);
  const tipFmt = tipFmtFn(valueFmt);
  // Value extent, so the widest bar's printed value has room and the ticks
  // land on round numbers.
  const fp = data.map((d) => String(d[valueKey])).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scale = useMemo(() => {
    let hi = 0;
    let lo = 0;
    for (const row of data) {
      const v = Number(row[valueKey]);
      if (!Number.isFinite(v)) continue;
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
    }
    return niceAxis(lo, hi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, valueKey]);
  return (
    <div
      className={cn("chart-in", className)}
      style={{ width: "100%", height }}
      role="img"
      aria-label={ariaLabel}
    >
      <ResponsiveContainer>
        <ComposedChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 52, bottom: 4, left: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={axisFmt}
            tick={AXIS_TICK}
            domain={scale.domain}
            ticks={scale.ticks}
            allowDecimals={valueFmt !== "int"}
          />
          <YAxis
            type="category"
            dataKey={labelKey}
            width={labelWidth}
            tickLine={false}
            interval={0}
            tick={<CatTick maxChars={Math.max(8, Math.floor(labelWidth / 6.3))} />}
          />
          <Tooltip formatter={tipFmt} />
          <Bar
            {...ANIM_BAR}
            animationDuration={animMs}
            animationBegin={animBegin(0)}
            dataKey={valueKey}
            fill={color}
            radius={[0, 4, 4, 0]}
            maxBarSize={maxBarSize}
            cursor={onClickRow ? "pointer" : undefined}
            onClick={(d: unknown) => onClickRow?.(d as Record<string, unknown>)}
          >
            {data.map((row, i) => (
              <Cell
                key={i}
                fill={
                  colorForRow
                    ? colorForRow(row, i)
                    : Number(row[valueKey]) < 0
                      ? negativeColor
                      : color
                }
              />
            ))}
            <LabelList
              dataKey={valueKey}
              position="right"
              formatter={axisFmt}
              style={{ fontSize: 11, fontWeight: 600, fill: "#334155" }}
            />
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Donut ──────────────────────────────────────────────────────────────────
/**
 * Donut with a centre total and a readable legend beside it.
 *
 * Cap the slices at 8 (`CAT8`) and roll the tail into an "Other" slice
 * (`OTHER_GREY`) — law 3. The legend carries every label and value, so the
 * chart is readable without relying on hue discrimination.
 */
export function Donut({
  data,
  height = 240,
  valueFmt = "usd",
  centerLabel,
  onSlice,
  ariaLabel,
  className,
}: {
  data: Array<{ label: string; value: number; color: string }>;
  height?: number;
  valueFmt?: AxisFmt;
  centerLabel?: string;
  onSlice?: (label: string) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const fmt = axisFmtFn(valueFmt);
  return (
    <div
      className={cn("chart-in flex items-center gap-4", className)}
      style={{ width: "100%", height }}
    >
      <div
        style={{ width: height, height, flexShrink: 0, position: "relative" }}
        role="img"
        aria-label={ariaLabel}
      >
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={2}
              stroke="#fff"
              strokeWidth={2}
              {...ANIM_BAR}
              onClick={
                onSlice
                  ? (d: unknown) => onSlice(String((d as { label?: string }).label ?? ""))
                  : undefined
              }
              cursor={onSlice ? "pointer" : undefined}
            >
              {data.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v: unknown, n: unknown) => [fmt(Number(v)), String(n)]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <span className="font-mono tabular-nums text-xl font-semibold text-foreground">
            {fmt(total)}
          </span>
          {centerLabel && (
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {centerLabel}
            </span>
          )}
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {data.map((d) => (
          <li key={d.label}>
            {onSlice ? (
              <button
                type="button"
                onClick={() => onSlice(d.label)}
                className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-sm hover:bg-muted/60"
              >
                <DonutLegendRow item={d} fmt={fmt} />
              </button>
            ) : (
              <span className="flex w-full items-center justify-between gap-2 px-1.5 py-0.5 text-sm">
                <DonutLegendRow item={d} fmt={fmt} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DonutLegendRow({
  item,
  fmt,
}: {
  item: { label: string; value: number; color: string };
  fmt: (v: unknown) => string;
}) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ background: item.color }}
        />
        <span className="truncate text-muted-foreground" title={item.label}>
          {item.label}
        </span>
      </span>
      <span className="shrink-0 font-mono tabular-nums text-foreground">
        {fmt(item.value)}
      </span>
    </>
  );
}
