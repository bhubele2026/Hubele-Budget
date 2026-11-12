import type { ReactNode } from "react";
import { AlertTriangle, Check, CircleDashed, Clock, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ⭐ ONE STATE BADGE (owner, 2026-11-12: "clearly distinguish pending,
 * confirmed, suggested and unresolved"). The same four states look the same on
 * the register, on Banking and in the row drawer:
 *
 *   pending     — the bank has not posted it yet      clock   · grey
 *   confirmed   — posted / matched / reviewed          check   · navy
 *   suggested   — H2 has an answer for you to OK       bulb    · navy outline
 *   unresolved  — waits for an answer                  dashed  · hairline
 *   warning     — something is wrong                   triangle· alarm ink
 *
 * A squared 4 px badge (`.chip`), words first: the icon and the colour only
 * reinforce what the label already says. `children` overrides the words
 * ("Posted", "Matched", "In Review").
 */
export type BadgeState = "pending" | "confirmed" | "suggested" | "unresolved" | "warning";

const LOOK: Record<BadgeState, { cls: string; Icon: typeof Clock; words: string }> = {
  pending: { cls: "chip gray", Icon: Clock, words: "Pending" },
  confirmed: { cls: "chip info", Icon: Check, words: "Confirmed" },
  suggested: { cls: "chip line text-brand-navy", Icon: Lightbulb, words: "Suggested" },
  unresolved: { cls: "chip line", Icon: CircleDashed, words: "Needs review" },
  warning: { cls: "chip bad", Icon: AlertTriangle, words: "Check" },
};

export function StatusBadge({
  state,
  children,
  className,
  title,
  "data-testid": testId,
}: {
  state: BadgeState;
  children?: ReactNode;
  className?: string;
  title?: string;
  "data-testid"?: string;
}) {
  const { cls, Icon, words } = LOOK[state];
  return (
    <span className={cn(cls, className)} data-state={state} title={title} data-testid={testId}>
      <Icon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
      {children ?? words}
    </span>
  );
}

/** The class and icon alone, for a badge that must be another element (a link). */
export function badgeLook(state: BadgeState): { cls: string; Icon: typeof Clock } {
  return LOOK[state];
}
