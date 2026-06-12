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
      className={cn(
        "rounded-lg border px-4 py-3.5 flex flex-col gap-1.5 transition-colors hover:border-foreground/15",
        accent ?? "bg-card",
      )}
      data-testid={testId}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "tabular-nums font-semibold tracking-[-0.02em] leading-none text-[1.9rem]",
          (isLoading || isMissing) &&
            "text-base font-normal text-muted-foreground",
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
        <Skeleton className="h-3 w-16" />
      ) : isMissing && unavailableHint ? (
        <div className="text-[11px] leading-tight text-muted-foreground">
          {unavailableHint}
        </div>
      ) : null}
      {footer ? (
        <div
          className="text-[11px] leading-tight text-muted-foreground"
          data-testid={testId ? `${testId}-footer` : undefined}
        >
          {footer}
        </div>
      ) : null}
      {action ? <div className="mt-0.5">{action}</div> : null}
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
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3.5 text-amber-900 flex flex-col gap-1.5"
      data-testid={testId}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-amber-700 flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> {label}
      </div>
      <div className="tabular-nums font-semibold text-lg leading-none">
        Unavailable
      </div>
      <div className="text-[11px] leading-tight">{hint}</div>
    </div>
  );
}
