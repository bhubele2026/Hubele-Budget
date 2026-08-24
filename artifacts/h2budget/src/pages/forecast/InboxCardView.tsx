import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { btnLink } from "@/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { BankLine, PlanLine } from "@/lib/forecastMatch";
import { GripVertical } from "lucide-react";

export type InboxCard = {
  id: string;
  bank: BankLine;
};

export function InboxCardView({
  card,
  categoryName,
  onUnplanned,
  onMatchPick,
  onAddAsBill,
  onHoverChange,
  planRows,
  oneClickSuggestion,
  isOverlay,
}: {
  card: InboxCard;
  categoryName?: string | null;
  onUnplanned: () => void;
  onMatchPick: (planRow: PlanLine) => void;
  /** When provided, renders an "Add as bill" button that lets the user
   *  promote the bank txn into a recurring item without leaving Review. */
  onAddAsBill?: () => void;
  onHoverChange?: (hovered: boolean) => void;
  planRows: PlanLine[];
  /** When set, the card has a single high-confidence top suggestion that
   *  isn't contested by any other inbox card. We render a primary "Match"
   *  button that confirms it in one click via `onMatchPick`. */
  oneClickSuggestion?: PlanLine | null;
  isOverlay?: boolean;
}) {
  const draggable = useDraggable({
    id: card.id,
    data: { txnId: card.bank.txn.id },
    disabled: isOverlay,
  });
  const { attributes, listeners, setNodeRef, transform, isDragging } = draggable;
  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const canOneClick = !isOverlay && !!oneClickSuggestion;
  // (#456) Show the explicit drag hint only on rows where the user has no
  // one-click match to fall back on — those are the rows where users
  // historically miss that drag-to-match exists at all.
  const showDragHint = !isOverlay && !oneClickSuggestion;
  return (
    <div
      ref={setNodeRef}
      style={style}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
      onFocus={onHoverChange ? () => onHoverChange(true) : undefined}
      onBlur={onHoverChange ? () => onHoverChange(false) : undefined}
      tabIndex={canOneClick ? 0 : undefined}
      data-testid={
        canOneClick
          ? `inbox-card-${card.bank.txn.id}`
          : `inbox-card-draggable-${card.bank.txn.id}`
      }
      aria-keyshortcuts={canOneClick ? "Enter" : undefined}
      aria-label={
        canOneClick && oneClickSuggestion
          ? `Inbox card for ${card.bank.txn.description}. Press Enter to match to ${oneClickSuggestion.label} on ${oneClickSuggestion.date}.`
          : undefined
      }
      onKeyDown={(e) => {
        if (
          canOneClick &&
          oneClickSuggestion &&
          e.key === "Enter" &&
          !e.shiftKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          e.target === e.currentTarget
        ) {
          e.preventDefault();
          onMatchPick(oneClickSuggestion);
        }
      }}
      className={`surface flex items-center gap-3 rounded-card p-3 outline-none ring-1 transition-all hover:ring-brand-navy/30 focus-visible:ring-2 focus-visible:ring-brand-navy/40 ${
        canOneClick ? "ring-brand-navy/25" : "ring-brand-line"
      } ${isDragging ? "opacity-30" : ""} ${
        isOverlay ? "cursor-grabbing shadow-lift ring-2 ring-brand-navy/40" : ""
      }`}
    >
      <button
        {...listeners}
        {...attributes}
        className="-m-1 inline-flex min-h-[32px] min-w-[32px] cursor-grab touch-none items-center justify-center rounded-control p-1.5 text-neutral-400 outline-none hover:bg-neutral-50 hover:text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-navy/40 active:cursor-grabbing"
        aria-label="Drag to match onto a planned item"
        title="Drag onto a planned item to match"
        data-testid={`inbox-drag-handle-${card.bank.txn.id}`}
        type="button"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-semibold text-neutral-700">
          {card.bank.txn.description}
        </div>
        {showDragHint && (
          <div
            className="mt-0.5 text-micro text-neutral-400"
            data-testid={`inbox-drag-hint-${card.bank.txn.id}`}
          >
            Drag onto a planned item to match
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-micro text-neutral-400">
          <span className="font-mono tabular-nums">
            {formatDate(card.bank.date)}
          </span>
          {categoryName ? (
            <span className="chip info">{categoryName}</span>
          ) : (
            <span className="chip gray">Uncategorized</span>
          )}
        </div>
      </div>
      <span
        className={`font-mono text-label font-semibold tabular-nums ${
          card.bank.amount < 0 ? "text-bad" : "text-brand-navy"
        }`}
      >
        {formatCurrency(card.bank.amount)}
      </span>
      {!isOverlay && (
        <div className="flex items-center gap-1">
          {oneClickSuggestion && (
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => onMatchPick(oneClickSuggestion)}
              data-testid={`one-click-match-${card.bank.txn.id}`}
              title={`Match to ${oneClickSuggestion.label} on ${oneClickSuggestion.date} (press Enter)`}
              aria-label={`Match to ${oneClickSuggestion.label} on ${oneClickSuggestion.date}. Shortcut: Enter.`}
              aria-keyshortcuts="Enter"
            >
              Match
            </Button>
          )}
          <Select
            onValueChange={(v) => {
              const p = planRows.find(
                (r) => `${r.itemId}|${r.date}` === v,
              );
              if (p) onMatchPick(p);
            }}
          >
            <SelectTrigger className="h-8 w-[140px] text-micro">
              <SelectValue placeholder="Choose a planned item" />
            </SelectTrigger>
            <SelectContent>
              {planRows.length === 0 && (
                <div className="px-2 py-1 text-micro text-neutral-400">
                  No planned items this month
                </div>
              )}
              {planRows.map((p) => (
                <SelectItem
                  key={`${p.itemId}|${p.date}`}
                  value={`${p.itemId}|${p.date}`}
                >
                  {p.label} · {formatDate(p.date)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {onAddAsBill && (
            <button
              type="button"
              className={btnLink}
              onClick={onAddAsBill}
              data-testid={`inbox-add-as-bill-${card.bank.txn.id}`}
              title="Promote this transaction into a recurring bill"
            >
              Add as bill
            </button>
          )}
          <button type="button" className={btnLink} onClick={onUnplanned}>
            Unplanned
          </button>
        </div>
      )}
    </div>
  );
}
