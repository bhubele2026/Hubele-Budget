import { useLayoutEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** sessionStorage key for one register section's open state. */
export const sectionKey = (id: string) => `forecast.section.${id}`;

function readOpen(id: string): boolean {
  try {
    return window.sessionStorage.getItem(sectionKey(id)) === "1";
  } catch {
    return false;
  }
}
function writeOpen(id: string, open: boolean) {
  try {
    window.sessionStorage.setItem(sectionKey(id), open ? "1" : "0");
  } catch {
    /* storage can be blocked; the section still works */
  }
}

/**
 * (C6) A register section that starts folded: a native `<details>` whose summary is the title, a count chip and
 * the total — the section's own card sits inside, unchanged. Its open state is remembered per section for the
 * session (`forecast.section.<id>`). `forceOpen` opens it when something inside is targeted — a deep link, a
 * highlighted row, a pinned bank row — and the reader may fold it again afterwards.
 */
export function CollapsibleSection({
  id,
  title,
  count,
  total,
  totalTone,
  forceOpen = false,
  chipClass = "chip gray",
  children,
}: {
  id: string;
  title: ReactNode;
  count?: ReactNode;
  total?: ReactNode;
  totalTone?: "bad";
  forceOpen?: boolean;
  chipClass?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => forceOpen || (typeof window !== "undefined" && readOpen(id)));
  // Layout effect: the open state is set before the next paint, so a scroll queued by the same click finds the row.
  useLayoutEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <details
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next !== open) {
          setOpen(next);
          writeOpen(id, next);
        }
      }}
      className="group min-w-0"
      data-testid={`section-${id}`}
    >
      <summary
        aria-expanded={open}
        // (2026-11-12) A section row on a hairline, not a card inside the panel.
        className="press flex min-h-11 cursor-pointer list-none items-center gap-2 border-b border-brand-line px-1 py-2 hover:bg-brand-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-navy/40 [&::-webkit-details-marker]:hidden group-open:mb-2"
        data-testid={`section-${id}-summary`}
      >
        <ChevronDown className="h-4 w-4 flex-none text-neutral-400 transition-transform group-open:rotate-180" aria-hidden="true" />
        <span className="min-w-0 truncate text-body font-semibold text-foreground">{title}</span>
        {count != null ? <span className={chipClass}>{count}</span> : null}
        {total != null ? (
          <span className={`ml-auto fig text-label ${totalTone === "bad" ? "text-bad" : "text-foreground"}`}>{total}</span>
        ) : null}
      </summary>
      {children}
    </details>
  );
}
