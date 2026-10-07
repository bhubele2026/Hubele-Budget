import { useEffect, type ReactNode } from "react";
import { centsValue, fmtMoney, MISSING } from "@/lib/money";
import type { DataState } from "@/lib/queryState";
import { cx } from "@/lib/cx";
import { SkeletonFigure } from "./Skeleton";

export type FigureSize = "xl" | "md" | "sm";
export type FigureTone = "ink" | "moss" | "clay";

const SIZE: Record<FigureSize, string> = {
  xl: "type-figure-xl",
  md: "type-figure",
  sm: "type-figure-sm",
};

const TONE: Record<FigureTone, string> = {
  ink: "text-ink",
  moss: "text-moss",
  clay: "text-clay",
};

/**
 * ⚠️ `figure-xl` IS FOR THE ONE NUMBER A SCREEN EXISTS TO ANSWER. A second
 * one means neither is. Counted while mounted; development builds warn.
 */
let xlMounted = 0;

/**
 * ⭐ A FIGURE: a label, one number in mono with aligned digits, an optional
 * sub-line.
 *
 * - No amount → "—", never "$0". A zero that never arrived is the most
 *   dangerous thing a money screen can paint.
 * - Cold (nothing received yet) → a skeleton shape, once.
 * - Refreshing, or a failed refresh → the last figure stays; the screen says
 *   it is old elsewhere (the freshness badge, a Note).
 * - The exact value rides along in `<data value>` to the cent, while the face
 *   shows whole dollars.
 */
export function Figure({
  amount,
  size,
  label,
  state,
  tone = "ink",
  sub,
  format = fmtMoney,
  suffix,
  "data-testid": testId,
}: {
  amount: number | null;
  size: FigureSize;
  label: string;
  state: DataState;
  tone?: FigureTone;
  sub?: ReactNode;
  /** How the number reads. Money (whole dollars) unless told otherwise. */
  format?: (n: number) => string;
  /** A word after the number, set in the text face ("paid"). */
  suffix?: string;
  "data-testid"?: string;
}) {
  useEffect(() => {
    if (size !== "xl") return;
    xlMounted += 1;
    if (import.meta.env.DEV && xlMounted > 1) {
      console.warn("[Figure] more than one figure-xl on screen; a screen gets one.");
    }
    return () => {
      xlMounted -= 1;
    };
  }, [size]);

  let face: ReactNode;
  if (amount == null) {
    face =
      state === "cold" ? (
        <SkeletonFigure size={size} />
      ) : (
        <span className={cx(SIZE[size], "text-ink-3")} data-empty="">
          <span aria-hidden>{MISSING}</span>
          <span className="sr-only">not available</span>
        </span>
      );
  } else {
    face = (
      <span className="inline-flex items-baseline gap-2">
        <data value={centsValue(amount)} className={cx(SIZE[size], TONE[tone])}>
          {format(amount)}
        </data>
        {suffix && " "}
        {suffix && <span className="type-body text-ink-2">{suffix}</span>}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-testid={testId} data-size={size}>
      <span className="type-label text-ink-2">{label}</span>
      {face}
      {sub && <span className="type-caption text-ink-3">{sub}</span>}
    </div>
  );
}
