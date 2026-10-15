import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { figLabel } from "@/ui";

/** A label over a mono figure. A number `value` is formatted as money; pass a
 *  string/node for counts or anything pre-formatted. `delta` is a signed
 *  change in money, printed with its sign ("+$120" / "-$45"); the tone only
 *  colours the figure, the words in `hint` say what it means. */
export function StatBlock(props: {
  label: string;
  value: number | string | ReactNode;
  delta?: number | null;
  hint?: ReactNode;
  tone?: "neutral" | "ok" | "bad";
  "data-testid"?: string;
}) {
  const shown = typeof props.value === "number" ? formatCurrency(props.value) : props.value;
  const d = props.delta;
  return (
    <div data-testid={props["data-testid"]} className="min-w-0">
      <div className={figLabel}>{props.label}</div>
      <div
        className={cn(
          "mt-0.5 font-mono text-title font-semibold tabular-nums",
          props.tone === "bad" ? "text-bad" : "text-brand-navy",
        )}
      >
        {shown}
      </div>
      {d != null && Number.isFinite(d) && d !== 0 ? (
        <div className="font-mono text-micro tabular-nums text-neutral-600" data-testid="stat-delta">
          {d > 0 ? "+" : "-"}
          {formatCurrency(Math.abs(d))}
        </div>
      ) : null}
      {props.hint ? <div className="mt-0.5 text-micro text-neutral-500">{props.hint}</div> : null}
    </div>
  );
}

/** A KPI on the grid: the panel surface around a `StatBlock` (same props, plus
 *  `span`, default 3, and an entrance `index`). A numeric `value` is money. */
export function StatTile({
  span = 3,
  index,
  ...props
}: Parameters<typeof StatBlock>[0] & { span?: 3 | 4 | 6 | 8 | 12; index?: number }) {
  return (
    <div
      className={cn("panel tile-in p-4", `span-${span}`)}
      style={index != null ? { animationDelay: `calc(${Math.min(index, 12)} * var(--stagger))` } : undefined}
    >
      <StatBlock {...props} />
    </div>
  );
}
