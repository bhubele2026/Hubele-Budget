import { cn } from "@/lib/utils";
import { LEDGER_GRID } from "./transaction-row";

/**
 * ⭐ THE LEDGER FINALLY SAYS WHAT ITS COLUMNS ARE.
 *
 * Both registers rendered seven aligned columns with nothing naming them —
 * the reader had to infer that the 13.5rem column was the category and that
 * the small figure under each amount was a running balance. These are the
 * `th` token: micro-caps, tracked, on the same track list the rows use.
 *
 * ⚠️ ONCE PER LEDGER, NOT ONCE PER DAY. The pages pass this to the FIRST
 * day-group only; repeating it above all thirty groups would turn a header
 * into wallpaper.
 *
 * ⚠️ `xl` ONLY. Below that the row is a wrapping flex, so there are no
 * columns to head — labelling them there would print seven words over a
 * layout that does not have them.
 */
export function LedgerColumns({
  amountLabel = "Amount · Bal",
  actionsLabel = "",
}: {
  /** Chase and Amex both stack a running balance under the amount. */
  amountLabel?: string;
  actionsLabel?: string;
}) {
  const th =
    "text-micro font-semibold uppercase tracking-wide text-neutral-400";
  return (
    <div
      className={cn(
        "hidden border-b border-brand-line bg-platinum-2 px-4 py-2 xl:grid xl:items-center xl:gap-x-3",
        LEDGER_GRID,
      )}
      aria-hidden
      data-testid="ledger-columns"
    >
      {/* Selection checkbox column — a heading over a checkbox is noise. */}
      <span />
      <span className={th}>Merchant</span>
      <span className={th}>Card</span>
      <span className={th}>Category</span>
      <span className={th}>Buckets</span>
      <span className={cn(th, "text-right")}>{amountLabel}</span>
      <span className={cn(th, "text-right")}>{actionsLabel}</span>
    </div>
  );
}
