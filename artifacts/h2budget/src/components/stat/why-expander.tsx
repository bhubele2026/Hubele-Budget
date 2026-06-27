import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The "Why + 8-wk chart ›" disclosure. A slim blue link that expands an
 * explanation + (optionally) a historical chart beneath a stat card. Keeps
 * cards calm by default, deep on demand.
 */
export function WhyExpander({
  label = "Why + 8-wk chart",
  children,
  className,
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("text-xs", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
      >
        {label}
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-card-border bg-muted/30 p-3 text-muted-foreground animate-in fade-in slide-in-from-top-1 duration-200">
          {children}
        </div>
      )}
    </div>
  );
}
