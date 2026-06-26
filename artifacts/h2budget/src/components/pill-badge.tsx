import { cn } from "@/lib/utils";

export type PillTone = "good" | "danger" | "warning" | "neutral" | "info";

const TONE: Record<PillTone, string> = {
  good: "bg-[hsl(var(--positive)/0.12)] text-[hsl(var(--positive))]",
  danger: "bg-[hsl(var(--negative)/0.12)] text-[hsl(var(--negative))]",
  warning: "bg-[hsl(var(--warning)/0.14)] text-[hsl(var(--warning))]",
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/12 text-primary",
};
const DOT: Record<PillTone, string> = {
  good: "bg-[hsl(var(--positive))]",
  danger: "bg-[hsl(var(--negative))]",
  warning: "bg-[hsl(var(--warning))]",
  neutral: "bg-muted-foreground",
  info: "bg-primary",
};

/**
 * Small state pill with a leading status dot — UNDER/OVER, ON TRACK, AT RISK,
 * PAID OFF, MATCHED/MISSED. Uppercase, tabular, fully round. The Juggernaut
 * status primitive.
 */
export function PillBadge({
  children,
  tone = "neutral",
  dot = true,
  className,
}: {
  children: React.ReactNode;
  tone?: PillTone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
        TONE[tone],
        className,
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", DOT[tone])} />}
      {children}
    </span>
  );
}
