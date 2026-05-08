import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function StatChip({
  label,
  value,
  accent,
  valueClassName,
  signed,
  testId,
  footer,
  tooltip,
  action,
  loading,
  unavailableHint,
}: {
  label: string;
  value: number | null | undefined;
  accent?: string;
  valueClassName?: string;
  signed?: boolean;
  testId?: string;
  footer?: string;
  tooltip?: string;
  action?: ReactNode;
  loading?: boolean;
  unavailableHint?: string;
}) {
  // (#464) Defensive rendering: never silently show $0.00 when the
  // upstream value is loading or unavailable. Mirrors the hardened
  // Amex Ending balance tile from #455.
  const isLoading = !!loading;
  const isMissing = !isLoading && (value == null || !Number.isFinite(value));
  const display = isLoading
    ? "Loading…"
    : isMissing
      ? "Unavailable"
      : signed && (value as number) > 0
        ? `+${formatCurrency(value as number)}`
        : formatCurrency(value as number);
  const body = (
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
          (isLoading || isMissing) && "text-muted-foreground",
          !(isLoading || isMissing) && valueClassName,
        )}
        data-testid={
          testId
            ? isLoading
              ? `${testId}-loading`
              : isMissing
                ? `${testId}-unavailable`
                : undefined
            : undefined
        }
      >
        {display}
      </div>
      {isLoading ? (
        <Skeleton className="h-3 w-16 mt-1" />
      ) : isMissing && unavailableHint ? (
        <div className="text-[10px] leading-tight mt-0.5 text-muted-foreground">
          {unavailableHint}
        </div>
      ) : null}
      {footer ? (
        <div
          className="text-[10px] leading-tight mt-0.5 opacity-80"
          data-testid={testId ? `${testId}-footer` : undefined}
        >
          {footer}
        </div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
  if (!tooltip) return body;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">{body}</div>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="max-w-[260px] whitespace-pre-line"
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
