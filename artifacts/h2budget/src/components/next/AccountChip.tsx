import { cn } from "@/lib/utils";
import type { AccountIdentity } from "@/lib/accountIdentity";

const DOT: Record<AccountIdentity["accent"], string> = {
  checking: "bg-acct-checking",
  amex: "bg-acct-amex",
  card2: "bg-acct-card2",
  other: "bg-acct-other",
};
const TINT: Record<AccountIdentity["accent"], string> = {
  checking: "bg-acct-checking-bg",
  amex: "bg-acct-amex-bg",
  card2: "bg-acct-card2-bg",
  other: "bg-acct-other-bg",
};

/** Accent dot + label + masked digits. The label is ALWAYS present: colour
 *  alone never carries the identity. `sm` uses the short label. `wrap` lets a
 *  long name break onto a second line instead of truncating, so the name and
 *  its ••last4 are always readable in full (the dashboard's account list). */
export function AccountChip({ identity, size = "md", wrap = false }: { identity: AccountIdentity; size?: "sm" | "md"; wrap?: boolean }) {
  const text = size === "sm" ? identity.shortLabel : identity.label;
  const mask = identity.mask4 ? (
    <span className="shrink-0 whitespace-nowrap font-mono tabular-nums text-neutral-500">••{identity.mask4}</span>
  ) : null;
  if (wrap) {
    // The dot stays beside the FIRST line; name and mask flow as one run of
    // text, so a long name breaks onto the next line and the mask follows it.
    return (
      <span
        title={identity.label}
        data-accent={identity.accent}
        className={cn(
          "inline-flex max-w-full items-start gap-1.5 rounded-control px-2 text-left text-brand-ink",
          TINT[identity.accent],
          size === "sm" ? "py-0.5 text-micro" : "py-1 text-label",
        )}
      >
        <span aria-hidden className={cn("mt-[0.35em] size-2 shrink-0 rounded-full", DOT[identity.accent])} />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="font-medium">{text}</span>
          {mask ? <> {mask}</> : null}
        </span>
      </span>
    );
  }
  return (
    <span
      title={identity.label}
      data-accent={identity.accent}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-control px-2 text-brand-ink",
        TINT[identity.accent],
        size === "sm" ? "py-0.5 text-micro" : "py-1 text-label",
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[identity.accent])} />
      <span className="truncate font-medium">{text}</span>
      {mask}
    </span>
  );
}
