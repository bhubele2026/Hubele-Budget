import { AlertTriangle } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

export function StatChip({
  label,
  value,
  accent,
  valueClassName,
  signed,
  testId,
}: {
  label: string;
  value: number;
  accent?: string;
  valueClassName?: string;
  signed?: boolean;
  testId?: string;
}) {
  const display =
    signed && value > 0 ? `+${formatCurrency(value)}` : formatCurrency(value);
  return (
    <div
      className={cn("rounded-md border px-3 py-2", accent ?? "bg-card")}
      data-testid={testId}
    >
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "font-mono tabular-nums font-semibold text-base",
          valueClassName,
        )}
      >
        {display}
      </div>
    </div>
  );
}

export function StatChipUnavailable({
  label,
  hint,
  testId,
}: {
  label: string;
  hint: string;
  testId?: string;
}) {
  return (
    <div
      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900"
      data-testid={testId}
    >
      <div className="text-[10px] uppercase tracking-widest text-amber-700 flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> {label}
      </div>
      <div className="font-mono tabular-nums font-semibold text-base">
        Unavailable
      </div>
      <div className="text-[10px] leading-tight mt-0.5">{hint}</div>
    </div>
  );
}
