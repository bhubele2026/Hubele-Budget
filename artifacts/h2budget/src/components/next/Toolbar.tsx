import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSlidingPill } from "@/lib/motion";

/**
 * ⭐ ONE COORDINATED TOOLBAR (owner, 2026-11-12): period toggles, filters and
 * search sit in ONE row of controls of one height, not scattered pills.
 *
 * `Toolbar` is the row (wraps on a phone, nothing hidden). `Segmented` is a
 * group of mutually exclusive choices drawn as ONE control: a hairline box
 * whose selected segment is white with navy ink on the faint navy wash —
 * the same voice as `toggle()` in `ui.tsx`. The buttons themselves stay with
 * the page (their own `aria-pressed`, test ids and handlers); `segment(on)`
 * is their class. 32 px tall on a desktop, 36 px on a phone, so a finger
 * still has a target.
 */
export function Toolbar({
  children,
  className,
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)} data-testid={testId}>
      {children}
    </div>
  );
}

/** A thin vertical rule between toolbar groups (desktop only). */
export function ToolbarDivider() {
  return <span aria-hidden className="hidden h-5 w-px bg-brand-line sm:block" />;
}

/** The segmented group's frame. `label` is its accessible name. */
export function Segmented({
  label,
  children,
  className,
  "data-testid": testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  // (Every click glides) The white selection pill travels to the segment picked.
  const ref = useRef<HTMLDivElement>(null);
  useSlidingPill(ref);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      data-testid={testId}
      className={cn("inline-flex items-stretch rounded-control bg-platinum-3 p-0.5 ring-1 ring-brand-line", className)}
    >
      {children}
    </div>
  );
}

/** One segment of a `Segmented` group. Pair with `aria-pressed`. */
export const segment = (on: boolean) =>
  cn(
    "press inline-flex h-9 items-center justify-center whitespace-nowrap rounded-[4px] px-3 text-label font-medium sm:h-7",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40",
    on ? "bg-white text-brand-navy shadow-[0_0_0_1px_var(--color-brand-line)]" : "text-neutral-600 hover:text-foreground",
  );
