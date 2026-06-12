import * as React from "react";
import type { Transaction } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { CategoryPicker } from "@/components/category-picker";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { MerchantRenamePopover } from "@/components/merchant-rename-popover";
import { RowDateControls } from "@/components/row-date-controls";
import { cn } from "@/lib/utils";
// Note: amount/balance formatting is supplied by the page via `amountNode`.

/**
 * Shared account-page transaction row.
 *
 * Both the Amex (credit card) and Chase (checking) pages render their
 * transaction lists through this ONE compact flex row so the two pages can never
 * visually drift apart again — same columns, same spacing, same controls.
 * Page-specific bits are passed in as ReactNode "slots" rather than baked
 * in, which keeps this component free of either page's handlers/types:
 *
 *   - `metaNode`    — secondary line under the merchant (raw description,
 *                     source/status chips, …).
 *   - `chipsNode`   — chips under the category picker (transfer pill,
 *                     external-card chip, matched-rule chip, …).
 *   - `amountNode`  — the amount cell body (static amount + running
 *                     balance on Amex; an inline editor on Chase).
 *   - `actionsNode` — trailing action buttons after the date controls
 *                     (Send-to-Forecast / Review / Edit on Chase).
 *
 * The shared, always-present controls — checkbox, merchant + rename,
 * card label, category picker, and allowance bucket bubbles — live here
 * so they look identical on both pages. Chase just lights up fewer
 * allowance bubbles; the skeleton is the same.
 */
export type AccountTransactionRowProps = {
  tx: Transaction;
  selected: boolean;
  onToggleSelect: () => void;
  categories: { id: string; name: string }[];
  onCategoryChange: (id: string | null, rememberPattern?: string | null) => void;
  onBucketToggle: (bucket: BucketKey, next: boolean) => void;
  onQuickDate: (raw: string) => void;
  disabled?: boolean;
  /** Dim the row (reviewed / ignored / forecast-sent). */
  dimmed?: boolean;
  /** Hide the inline date editor (pending rows get restamped by Plaid). */
  hideDate?: boolean;
  cardLabel?: string | null;
  metaNode?: React.ReactNode;
  chipsNode?: React.ReactNode;
  amountNode: React.ReactNode;
  actionsNode?: React.ReactNode;
  testId?: string;
  /** Extra data-* attributes (e.g. data-reviewed) spread onto the row. */
  rowData?: Record<string, string>;
};

export function AccountTransactionRow({
  tx,
  selected,
  onToggleSelect,
  categories,
  onCategoryChange,
  onBucketToggle,
  onQuickDate,
  disabled,
  dimmed,
  hideDate,
  cardLabel,
  metaNode,
  chipsNode,
  amountNode,
  actionsNode,
  testId,
  rowData,
}: AccountTransactionRowProps) {
  return (
    <div
      className={cn(
        "px-3 py-1.5 hover:bg-muted/30 transition-colors",
        // Narrow: wrap (never a horizontal scrollbar). Wide (xl+): a
        // fixed-column grid so every row's source / category / bubbles /
        // amount / actions line up in true columns. Only the merchant column
        // flexes (1fr), so the fixed columns sit at the same x on every row.
        // xl (not md) is the threshold so the fixed columns always have room.
        "flex flex-wrap items-center gap-x-3 gap-y-1",
        "xl:grid xl:gap-y-0 xl:items-center",
        "xl:grid-cols-[1.75rem_minmax(0,1fr)_7rem_13.5rem_8rem_7rem_12.5rem]",
        dimmed && "opacity-50",
      )}
      data-testid={testId}
      {...rowData}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggleSelect()}
        aria-label="Select"
        className="shrink-0"
      />
      {/* Merchant (flex column) + inline status chip (metaNode). */}
      <div className="flex min-w-0 items-center gap-x-2 gap-y-0.5 flex-wrap">
        <span
          className="font-medium truncate max-w-full"
          title={tx.description}
        >
          {tx.displayName || tx.description}
        </span>
        <MerchantRenamePopover tx={tx} />
        {metaNode}
      </div>
      {/* Card / source */}
      <div className="shrink-0 truncate text-xs text-muted-foreground">
        {cardLabel || ""}
      </div>
      <div className="shrink-0 flex items-center gap-1.5 min-w-0">
        <CategoryPicker
          value={tx.categoryId ?? null}
          categories={categories}
          description={tx.description}
          onChange={onCategoryChange}
        />
        {chipsNode}
      </div>
      {/* (#607) Bucket bubbles are hidden on transfer rows. */}
      <div className="shrink-0">
        {!tx.isTransfer && (
          <BucketBubbles
            flags={{
              weekly: tx.weeklyAllowance,
              monthly: tx.monthlyAllowance,
              unplanned: tx.unplannedAllowance,
              reimbursable: tx.reimbursable,
            }}
            onToggle={onBucketToggle}
          />
        )}
      </div>
      <div className="shrink-0 text-right font-mono tabular-nums whitespace-nowrap xl:justify-self-end">
        {amountNode}
      </div>
      <div className="shrink-0 flex gap-0.5 items-center xl:justify-self-end">
        {/* Pending rows are restamped by Plaid on the next sync, so the date
            editor is hidden there to avoid a fix that silently reverts. */}
        {!hideDate && (
          <RowDateControls tx={tx} onMove={onQuickDate} disabled={disabled} />
        )}
        {actionsNode}
      </div>
    </div>
  );
}
