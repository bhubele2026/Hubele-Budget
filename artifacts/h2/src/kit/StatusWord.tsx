import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export type StatusTone = "on" | "tight" | "over" | "fresh" | "stale" | "neutral";

/**
 * A status is a WORD with a small mark beside it — never a colour alone. The
 * mark's shape differs too: a dot for good, a hatched square for tight, a
 * square for over/failed, a ring for stale.
 *
 * Text colours were measured on paper-0: moss-ink 10.5:1, clay 5.7:1,
 * ink-2 6.9:1. Ochre text is never used for a word (4.3:1 on its own wash).
 */
const TEXT: Record<StatusTone, string> = {
  on: "text-moss-ink",
  fresh: "text-moss-ink",
  tight: "text-ink",
  over: "text-clay",
  stale: "text-ink-2",
  neutral: "text-ink-2",
};

const MARK: Record<StatusTone, string> = {
  on: "rounded-full bg-moss",
  fresh: "rounded-full bg-moss",
  tight: "hatch",
  over: "bg-clay",
  stale: "rounded-full border-2 border-ochre",
  neutral: "rounded-full border-2 border-rule-strong",
};

export function StatusWord({
  tone,
  children,
  className,
  "data-testid": testId,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span
      className={cx("inline-flex items-center gap-2 type-label", TEXT[tone], className)}
      data-tone={tone}
      data-testid={testId}
    >
      <span aria-hidden className={cx("inline-block size-2 shrink-0", MARK[tone])} />
      {children}
    </span>
  );
}
