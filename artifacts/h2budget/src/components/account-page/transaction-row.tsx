import * as React from "react";
import type { Transaction } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { CategoryPicker } from "@/components/category-picker";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { MerchantRenamePopover } from "@/components/merchant-rename-popover";
import { RowDateControls } from "@/components/row-date-controls";
import { cn } from "@/lib/utils";
import type { AccountAccentName } from "@/lib/accountIdentity";
import { LEDGER_GRID } from "./ledger-grid";
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
// The column geometry lives in `ledger-grid.ts` (container-query tracks);
// re-exported here so existing imports keep working.
export { LEDGER_GRID } from "./ledger-grid";

export type AccountTransactionRowProps = {
  tx: Transaction;
  selected: boolean;
  onToggleSelect: () => void;
  categories: { id: string; name: string }[];
  onCategoryChange: (id: string | null, rememberPattern?: string | null) => void;
  onBucketToggle: (bucket: BucketKey, next: boolean) => void;
  onQuickDate: (raw: string) => void | Promise<boolean>;
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
  /**
   * The account's identity accent: a dot before the card label, the same dot
   * the account's chip and panels carry. Colour only reinforces it — the label
   * still names the account (and the dot adds no text).
   */
  cardAccent?: AccountAccentName | null;
  /** Column tracks (`ledger-grid.ts`); the page's `LedgerColumns` must match. */
  gridClass?: string;
};

const ACCENT_DOT: Record<AccountAccentName, string> = {
  checking: "bg-acct-checking",
  amex: "bg-acct-amex",
  card2: "bg-acct-card2",
  other: "bg-acct-other",
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
  cardAccent,
  gridClass = LEDGER_GRID,
}: AccountTransactionRowProps) {
  return (
    <div
      className={cn(
        // Compact ledger rhythm: 40 px for a one-line row (the 36 px category
        // control and bucket marks plus 2 px each side), the "36–40 px rows"
        // the design asks of a transaction table.
        "min-h-10 px-4 py-0.5 text-body transition-colors hover:bg-brand-tint",
        // Narrow ledger: wrap (never a horizontal scrollbar). Wide ledger
        // (`@6xl`, the ledger's own width — `ledger-grid.ts`): a fixed-column
        // grid so every row's source / category / bubbles / amount / actions
        // line up in true columns. Only the merchant column flexes (1fr).
        "flex flex-wrap items-center gap-x-3 gap-y-1",
        "@6xl:grid @6xl:items-center @6xl:gap-y-0",
        gridClass,
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
      {/* Merchant + its status chip (metaNode). The name is the row's
          most-read text and is never cut to make room for the chip: the name
          and its rename pencil are one unit, and the chip follows on the same
          line when it fits (a 40 px row) and on its own trailing line only
          when it would not.
          Narrow ledger: the merchant owns the line beside the checkbox (its
          basis is the rest of the row), so a long name never leaves the
          checkbox alone on a line. The grid ignores the basis. */}
      <div className="flex min-w-0 grow basis-[calc(100%-2rem)] flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="inline-flex min-w-0 max-w-full items-center gap-1" data-testid={`merchant-${tx.id}`}>
          <span
            className="min-w-0 truncate font-medium text-neutral-700"
            title={tx.description}
          >
            {tx.displayName || tx.description}
          </span>
          <MerchantRenamePopover tx={tx} />
        </span>
        {metaNode}
      </div>
      {/* Card / source */}
      <div className="flex min-w-0 shrink-0 items-center gap-1.5" title={cardLabel || undefined}>
        {cardAccent && cardLabel ? (
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", ACCENT_DOT[cardAccent])} />
        ) : null}
        <span
          className="truncate text-micro text-neutral-500"
          data-testid={`text-card-${tx.id}`}
        >
          {cardLabel || "—"}
        </span>
      </div>
      {/* Wraps: a row label ("After today", "Not counted") goes under the
          picker rather than over the bucket column. */}
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5">
        <CategoryPicker
          value={tx.categoryId ?? null}
          categories={categories}
          description={tx.description}
          onChange={onCategoryChange}
          // Fills the 12rem category column on a wide ledger.
          triggerClassName="@6xl:w-full"
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
      {/* `tdNum`: money is mono, tabular and right-aligned so a column of it
          lines up and never reflows as it updates. */}
      <div className="shrink-0 whitespace-nowrap text-right font-mono text-label tabular-nums @6xl:justify-self-end">
        {amountNode}
      </div>
      <div className="shrink-0 flex gap-0.5 items-center @6xl:justify-self-end">
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
