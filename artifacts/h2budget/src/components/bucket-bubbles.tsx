import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUCKET_LABELS, BUCKET_LABEL_ORDER } from "@/lib/bucketLabels";

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

const LABELS = BUCKET_LABELS;

/** The accessible name stays what it was ("Weekly bucket"…); the tooltip says what the mark does. */
const NAMES: Record<BucketKey, string> = {
  weekly: "Weekly bucket",
  monthly: "Monthly bucket",
  unplanned: "Unplanned bucket",
  reimbursable: "Reimbursable",
};

const MEANINGS: Record<BucketKey, string> = {
  weekly: "Weekly: counts toward the weekly allowance",
  monthly: "Monthly: counts toward the monthly allowance",
  unplanned: "Unplanned: counts toward the unplanned allowance",
  reimbursable: "Reimbursable: someone will pay this back",
};

const ORDER: BucketKey[] = BUCKET_LABEL_ORDER;

function Bubble({
  label,
  on,
  onClick,
  name,
  title,
  disabled,
}: {
  label: { short: string; full: string };
  on: boolean;
  onClick: () => void;
  name: string;
  title: string;
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
      aria-label={name}
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
      {/* (W3) Readable text, 11px, never the old 9px glyph: two letters on a
          phone, the word from `sm` up. The tooltip carries the one-line meaning. */}
      <span className="text-[11px] font-semibold leading-none text-neutral-500" aria-hidden="true">
        <span className="sm:hidden @6xl:inline">{label.short}</span>
        <span className="hidden sm:inline @6xl:hidden">{label.full}</span>
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
    <div className={cn("flex items-start gap-2 sm:gap-3", className)}>
      {buckets.map((b) => (
        <Bubble
          key={b}
          label={LABELS[b]}
          on={flags[b]}
          onClick={() => onToggle(b, !flags[b])}
          name={NAMES[b]}
          title={MEANINGS[b]}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
