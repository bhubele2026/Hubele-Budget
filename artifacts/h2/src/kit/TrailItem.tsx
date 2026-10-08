import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/**
 * One line of what H2 did on its own: the words, when, and the controls that
 * go with it (Why? / Undo). An undone item says "Undone" and loses its Undo.
 */
export function TrailItem({
  title,
  when,
  undone = false,
  controls,
  "data-testid": testId = "trail-item",
}: {
  title: string;
  when?: string;
  undone?: boolean;
  controls?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <li
      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-rule py-2 first:border-t-0"
      data-testid={testId}
    >
      <span className="min-w-0">
        <span className={cx("type-body", undone ? "text-ink-3 line-through" : "text-ink")}>{title}</span>
        {when && <span className="ml-2 type-caption text-ink-3">{when}</span>}
        {undone && <span className="ml-2 type-caption text-ink-2">Undone</span>}
      </span>
      {controls && <span className="flex items-center gap-3">{controls}</span>}
    </li>
  );
}
