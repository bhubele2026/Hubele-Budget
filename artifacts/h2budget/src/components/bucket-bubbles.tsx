import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The four allowance-bucket toggles that ride on a transaction row.
 *
 * ⚠️ THIS IS INFORMATION, NOT DECORATION — which is why it survives the
 * overhaul as a component rather than being folded into a page. Each mark is
 * an independent, writable flag with its own `aria-pressed` state; deleting
 * one would delete a control, and merging them into a row's chip cluster would
 * make four booleans read as one.
 *
 * ⚠️ IT DOES NOT APPEAR ON /budget. The Budget page never imported it — its
 * call sites are the Amex page and the two transaction-row surfaces. It is
 * restyled here, once, on the shared primitive rather than three times on the
 * pages, and the geometry is deliberately left alone so the rows that host it
 * do not reflow.
 *
 * The old form was a 2px-ringed filled circle: a candy pill, which the house
 * style bans. This is the same footprint drawn flat — a tight-radius box with
 * a hairline at rest and solid navy when set.
 */
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
      className="press group flex flex-col items-center gap-0.5 rounded-control focus-visible:ring-2 focus-visible:ring-brand-navy/40 disabled:pointer-events-none disabled:opacity-50"
    >
      <span
        className={cn(
          "grid h-5 w-5 place-items-center rounded-control ring-1 transition-colors",
          on
            ? "bg-brand-navy text-white ring-brand-navy"
            : "bg-white text-transparent ring-brand-line group-hover:ring-brand-navy/40",
        )}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      {/* 9px matches `Help` in the kit — the one size below the scale, kept
          for a two-letter glyph. Promoting it to `text-micro` would widen
          every bucket column on the Amex and transaction rows, which this PR
          does not own. */}
      <span className="text-[9px] font-semibold uppercase tracking-widest text-neutral-400">
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
