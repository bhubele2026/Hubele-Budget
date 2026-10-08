import { useEffect, useState } from "react";
import { centsValue, fmtMoney } from "@/lib/money";
import { cx } from "@/lib/cx";
import { StatusWord } from "./StatusWord";

export type MeterStatus = "on" | "tight" | "over";

/**
 * The share of the limit at which a meter reads "Tight". A presentation
 * threshold only — it moves no figure. (S1's server-side position replaces it
 * with a pace from the week's own calendar.)
 */
export const TIGHT_AT = 0.85;

/** On plan / tight / over, from the two figures the meter already shows. */
export function meterStatus(spent: number, limit: number): MeterStatus {
  if (limit <= 0) return spent > 0 ? "over" : "on";
  if (spent > limit) return "over";
  if (spent >= limit * TIGHT_AT) return "tight";
  return "on";
}

const FILL: Record<MeterStatus, string> = {
  on: "bg-moss",
  tight: "hatch",
  over: "bg-clay",
};

/**
 * The status in words. "Over by $x" is the one subtraction on the screen; a
 * gap that rounds to $0 says "Just over" rather than the contradiction
 * "Over by $0".
 */
export function meterWords(status: MeterStatus, spent: number, limit: number): string {
  if (status === "over") {
    const gap = spent - limit;
    return gap < 0.5 ? "Just over" : `Over by ${fmtMoney(gap)}`;
  }
  return status === "tight" ? "Tight" : "On plan";
}

/**
 * ⭐ A METER: spent against a limit, the status in words, and a bar that fills
 * once on first paint. "Tight" hatches as well as colouring, so the state is
 * never carried by ochre alone. With no limit there is nothing to measure
 * against, so the bar and the status word are left out and the line says so.
 */
export function Meter({
  spent,
  limit,
  status,
  label,
  words: wordsOverride,
  "data-testid": testId,
}: {
  spent: number;
  limit: number | null;
  status: MeterStatus;
  label: string;
  /** The status in words when the server has already said it ("Over by $55"). */
  words?: string;
  "data-testid"?: string;
}) {
  const hasLimit = limit != null && limit > 0;
  const fraction = hasLimit ? Math.min(Math.max(spent / limit, 0), 1) : 0;

  // Fill on first paint: start empty, grow to the share on the next frame.
  // The duration is the `--dur-base` dial, which reduced motion zeroes.
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setPainted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const words = hasLimit ? (wordsOverride ?? meterWords(status, spent, limit)) : null;

  return (
    <div data-testid={testId} data-status={hasLimit ? status : "no-limit"}>
      <span className="type-label text-ink-2">{label}</span>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="flex items-baseline gap-2">
          <data value={centsValue(spent)} className="type-figure text-ink">
            {fmtMoney(spent)}
          </data>
          {hasLimit && " "}
          {hasLimit && (
            <span className="type-body text-ink-2">
              of{" "}
              <data value={centsValue(limit)} className="tnum">
                {fmtMoney(limit)}
              </data>
            </span>
          )}
        </p>
        {words && status && (
          <StatusWord tone={status} data-testid="meter-status">
            {words}
          </StatusWord>
        )}
      </div>
      {hasLimit ? (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(Math.max(spent, 0), limit)}
          aria-valuetext={`${fmtMoney(spent)} of ${fmtMoney(limit)}, ${words}`}
          className="mt-3 h-2 w-full overflow-hidden rounded-1 bg-paper-2"
        >
          <div
            className={cx("meter-fill h-full w-full", FILL[status])}
            data-fill={fraction.toFixed(4)}
            style={{ transform: `scaleX(${painted ? fraction : 0})` }}
          />
        </div>
      ) : (
        <p className="mt-2 type-caption text-ink-3">No weekly limit set yet.</p>
      )}
    </div>
  );
}
