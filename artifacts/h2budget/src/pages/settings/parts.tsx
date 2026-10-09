import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { btnLink } from "@/ui";
import { cn } from "@/lib/utils";

/**
 * (C8) Small shared pieces for the fold-in tabs (Automation, Morning text,
 * AI cost), built on h2budget's own kit: the Radix `Switch`, `.chip`, the
 * `skeleton` sweep. Rebuilt from h2's `SwitchRow` / `StatusWord` / `Note`
 * behaviour, never imported from it.
 */

/** A switch that also says its state in a word ("On" / "Off"). */
export function SettingSwitch({
  label,
  on,
  onChange,
  disabled,
  hint,
  "data-testid": testId,
}: {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-3">
        <Switch
          checked={on}
          onCheckedChange={(v) => onChange(v === true)}
          disabled={disabled}
          aria-label={label}
          data-testid={testId}
        />
        <span className="text-body text-brand-ink">
          {label}: <span className="font-semibold">{on ? "On" : "Off"}</span>
        </span>
      </label>
      {hint ? <p className="pl-12 text-micro text-neutral-500">{hint}</p> : null}
    </div>
  );
}

export type Tone = "on" | "fresh" | "over" | "stale" | "tight" | "neutral";
const CHIP: Record<Tone, string> = {
  on: "ok",
  fresh: "ok",
  over: "bad",
  stale: "warn",
  tight: "warn",
  neutral: "gray",
};

/** A state in a word, on a chip; the word carries it, the tint only helps. */
export function StatusChip({
  tone,
  children,
  className,
  "data-testid": testId,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span className={cn("chip shrink-0", CHIP[tone], className)} data-testid={testId}>
      {children}
    </span>
  );
}

export function TabSkeleton({ testId, rows = 3 }: { testId: string; rows?: number }) {
  return (
    <div className="space-y-2 p-4" data-testid={testId} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn("skeleton h-5 rounded-control", i % 2 ? "w-1/2" : "w-2/3")} />
      ))}
    </div>
  );
}

/** A failed read in words, with Try again. Never an empty state. */
export function RetryNote({
  children,
  onRetry,
  retrying,
  "data-testid": testId,
}: {
  children: ReactNode;
  onRetry: () => void;
  retrying?: boolean;
  "data-testid"?: string;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 p-4 text-body text-neutral-600" data-testid={testId}>
      <span>{children}</span>
      <button type="button" className={btnLink} onClick={onRetry} disabled={retrying}>
        {retrying ? "Trying…" : "Try again"}
      </button>
    </div>
  );
}
