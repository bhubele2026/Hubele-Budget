import { cn } from "@/lib/utils";
import { LEDGER_GRID } from "./ledger-grid";

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
 * ⚠️ WIDE LEDGER ONLY (`@6xl`, the ledger's own width — `ledger-grid.ts`).
 * Below that the row is a wrapping flex, so there are no columns to head —
 * labelling them there would print seven words over a layout that does not
 * have them. Pass the same `gridClass` the rows use.
 */
export function LedgerColumns({
  amountLabel = "Amount · Bal",
  actionsLabel = "",
  gridClass = LEDGER_GRID,
  cardLabel = "Card",
  bucketsLabel = "Buckets",
}: {
  /** Chase and Amex both stack a running balance under the amount. */
  amountLabel?: string;
  actionsLabel?: string;
  gridClass?: string;
  /** (P1) null: the rows have no Card column (one card's page). */
  cardLabel?: string | null;
  /** (P1) The Amex Review mode heads the column "Spending" (words, not marks). */
  bucketsLabel?: string;
}) {
  const th =
    "text-micro font-semibold uppercase tracking-wide text-neutral-600";
  return (
    <div
      className={cn(
        "hidden border-b border-brand-line bg-platinum-2 px-4 py-2 @6xl:grid @6xl:items-center @6xl:gap-x-3",
        gridClass,
      )}
      aria-hidden
      data-testid="ledger-columns"
    >
      {/* Selection checkbox column — a heading over a checkbox is noise. */}
      <span />
      <span className={th}>Merchant</span>
      {cardLabel === null ? null : <span className={th}>{cardLabel}</span>}
      <span className={th}>Category</span>
      <span className={th}>{bucketsLabel}</span>
      <span className={cn(th, "text-right")}>{amountLabel}</span>
      <span className={cn(th, "text-right")}>{actionsLabel}</span>
    </div>
  );
}
