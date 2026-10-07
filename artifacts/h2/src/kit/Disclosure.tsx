import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Detail on demand, on the platform's own <details>: keyboard, focus and
 * screen-reader state for free, and zero script. No animation (not on the
 * permitted list); the chevron simply turns.
 */
export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group border-t border-rule py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 type-label text-ink [&::-webkit-details-marker]:hidden">
        <span>{summary}</span>
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-2 group-open:rotate-180" />
      </summary>
      <div className="pt-3 type-body text-ink-2">{children}</div>
    </details>
  );
}
