import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type BucketKey = "weekly" | "monthly" | "unplanned" | "reimbursable";

export type BucketFlags = {
  weekly: boolean;
  monthly: boolean;
  unplanned: boolean;
  reimbursable: boolean;
};

const LABELS: Record<BucketKey, string> = {
  weekly: "WK",
  monthly: "MO",
  unplanned: "UN",
  reimbursable: "RE",
};

const ORDER: BucketKey[] = ["weekly", "monthly", "unplanned", "reimbursable"];

function Bubble({
  label,
  on,
  onClick,
  title,
  disabled,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={title}
      aria-pressed={on}
      aria-label={title ?? label}
      disabled={disabled}
      className="flex flex-col items-center gap-0.5 group disabled:opacity-50"
    >
      <span
        className={cn(
          "h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors",
          on
            ? "bg-foreground border-foreground text-background"
            : "border-muted-foreground/40 text-transparent group-hover:border-foreground",
        )}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <span className="text-[9px] uppercase tracking-widest text-muted-foreground font-medium">
        {label}
      </span>
    </button>
  );
}

export function BucketBubbles({
  flags,
  onToggle,
  disabled,
  buckets = ORDER,
  className,
}: {
  flags: BucketFlags;
  onToggle: (bucket: BucketKey, next: boolean) => void;
  disabled?: boolean;
  buckets?: BucketKey[];
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2", className)}>
      {buckets.map((b) => (
        <Bubble
          key={b}
          label={LABELS[b]}
          on={flags[b]}
          onClick={() => onToggle(b, !flags[b])}
          title={
            b === "reimbursable"
              ? "Reimbursable"
              : b === "weekly"
              ? "Weekly bucket"
              : b === "monthly"
              ? "Monthly bucket"
              : "Unplanned bucket"
          }
          disabled={disabled}
        />
      ))}
    </div>
  );
}
