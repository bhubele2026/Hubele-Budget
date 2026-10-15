import * as React from "react";
import type { Transaction } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { CategoryPicker } from "@/components/category-picker";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { MerchantRenamePopover } from "@/components/merchant-rename-popover";
import { RowMenu } from "@/components/row-menu";
import { cn } from "@/lib/utils";
import type { AccountAccentName } from "@/lib/accountIdentity";
import { LEDGER_GRID } from "./ledger-grid";
import { ExpiredHoldLabel } from "@/components/expired-hold-label";
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
  /** `undefined` while the category list loads. */
  categories: { id: string; name: string }[] | undefined;
  onCategoryChange: (id: string | null, rememberPattern?: string | null) => void;
  onBucketToggle: (bucket: BucketKey, next: boolean) => void;
  onQuickDate: (raw: string) => void | Promise<boolean>;
  disabled?: boolean;
  /**
   * A small readable state chip beside the merchant ("Reviewed" / "Ignored").
   * A financial row is never faded: fading made its amount hard to read, and a
   * state belongs in words, not in lowered contrast.
   */
  stateLabel?: string | null;
  /** Edit / delete live in the row menu with the date moves. */
  onEdit?: () => void;
  onDelete?: () => void;
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
  /** (F4) Offers "Split by category…" in the merchant popover. */
  onSplit?: () => void;
  // ── (P1) Opt-in slots for the Amex ledger. Every one defaults to the row
  // above, so a page that passes none (Chase) renders exactly as before.
  /** Replaces the category picker cell's control (a quieter trigger). */
  categoryNode?: React.ReactNode;
  /** Replaces the bucket marks cell (spending in words, or the marks themselves). */
  bucketsNode?: React.ReactNode;
  /** false: no Card cell at all (one card's page names its card once, in the header). */
  showCard?: boolean;
  /** The card label wraps instead of truncating (a household name, never cut). */
  cardWrap?: boolean;
  /** No rename pencil beside the merchant (the page offers it in the row's details). */
  hideRename?: boolean;
  /** Replaces the state chip and the expired-hold label with the page's own status line. */
  statusNode?: React.ReactNode;
  /** A full-width region under the row (inline details), inside the row's box. */
  belowNode?: React.ReactNode;
  /** Narrow ledger: the wrapped line starts under the merchant and the amount sits at its end. */
  wrapIndent?: boolean;
};

/** (F6 round 3) The expired-hold label, re-exported from its own module (F6 round 4). */
export { ExpiredHoldLabel };

const ACCENT_DOT: Record<AccountAccentName, string> = {
  checking: "bg-acct-checking",
  amex: "bg-acct-amex",
  card2: "bg-acct-card2",
  other: "bg-acct-other",
};

/**
 * (Q6b) A row scrolled to (a `?tx=` link) lands below the whole sticky stack:
 * the pinned pane (`--page-sticky-top`), the day head (36 px) and a gap.
 */
export const ROW_SCROLL_MARGIN_TOP = "calc(var(--page-sticky-top, 0px) + 56px)";

export function AccountTransactionRow({
  tx,
  selected,
  onToggleSelect,
  categories,
  onCategoryChange,
  onBucketToggle,
  onQuickDate,
  disabled,
  stateLabel,
  onEdit,
  onDelete,
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
  onSplit,
  categoryNode,
  bucketsNode,
  showCard = true,
  cardWrap = false,
  hideRename = false,
  statusNode,
  belowNode,
  wrapIndent = false,
}: AccountTransactionRowProps) {
  const merchant = tx.displayName || tx.description;
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
      )}
      data-testid={testId}
      style={{ scrollMarginTop: ROW_SCROLL_MARGIN_TOP }}
      {...rowData}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggleSelect()}
        aria-label={`Select ${merchant}`}
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
            {merchant}
          </span>
          {hideRename ? null : <MerchantRenamePopover tx={tx} onSplit={onSplit} />}
        </span>
        {statusNode !== undefined ? (
          statusNode
        ) : (
          <>
            {stateLabel ? (
              <span className="chip gray shrink-0" data-testid={`chip-state-${tx.id}`}>
                {stateLabel}
              </span>
            ) : null}
            {metaNode}
            {tx.expiredHold ? <ExpiredHoldLabel id={tx.id} /> : null}
          </>
        )}
        {statusNode !== undefined ? metaNode : null}
      </div>
      {/* Card / source */}
      {showCard ? (
        <div
          className={cn("flex min-w-0 shrink-0 items-center gap-1.5", wrapIndent && "ml-7 @6xl:ml-0")}
          title={cardLabel || undefined}
        >
          {cardAccent && cardLabel ? (
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", ACCENT_DOT[cardAccent])} />
          ) : null}
          <span
            className={cn(cardWrap ? "min-w-0 [overflow-wrap:anywhere]" : "truncate", "text-micro text-neutral-500")}
            data-testid={`text-card-${tx.id}`}
          >
            {cardLabel || "—"}
          </span>
        </div>
      ) : null}
      {/* Wraps: a row label ("After today", "Not counted") goes under the
          picker rather than over the bucket column. */}
      <div
        className={cn(
          "flex min-w-0 shrink-0 flex-wrap items-center gap-1.5",
          wrapIndent && !showCard && "ml-7 @6xl:ml-0",
        )}
      >
        {categoryNode !== undefined ? (
          categoryNode
        ) : (
          <CategoryPicker
            value={tx.categoryId ?? null}
            categories={categories}
            description={tx.description}
            onChange={onCategoryChange}
            // Fills the 12rem category column on a wide ledger.
            triggerClassName="@6xl:w-full"
          />
        )}
        {chipsNode}
      </div>
      {/* (#607) Bucket bubbles are hidden on transfer rows. */}
      <div className="min-w-0 shrink-0">
        {bucketsNode !== undefined
          ? bucketsNode
          : !tx.isTransfer && (
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
      <div
        className={cn(
          "shrink-0 whitespace-nowrap text-right font-mono text-label tabular-nums @6xl:justify-self-end",
          wrapIndent && "ml-auto @6xl:ml-0",
        )}
      >
        {amountNode}
      </div>
      <div className="shrink-0 flex gap-0.5 items-center @6xl:justify-self-end">
        {actionsNode}
        {/* Pending rows are restamped by Plaid on the next sync, so the date
            moves are left out there to avoid a fix that silently reverts. */}
        <RowMenu
          tx={tx}
          merchant={merchant}
          onMove={hideDate ? undefined : onQuickDate}
          onEdit={onEdit}
          onDelete={onDelete}
          disabled={disabled}
        />
      </div>
      {belowNode ? <div className="min-w-0 basis-full @6xl:col-span-full">{belowNode}</div> : null}
    </div>
  );
}
