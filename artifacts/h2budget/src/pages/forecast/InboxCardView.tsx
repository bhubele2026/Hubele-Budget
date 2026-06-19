import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      className={`rounded-md border bg-card p-3 flex items-center gap-3 shadow-sm transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        isDragging ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-2 ring-primary/40 cursor-grabbing" : ""}`}
    >
      <button
        {...listeners}
        {...attributes}
        className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-md p-1.5 -m-1 inline-flex items-center justify-center min-w-[32px] min-h-[32px] focus-visible:ring-2 focus-visible:ring-primary/40 outline-none"
        aria-label="Drag to match onto a planned item"
        title="Drag onto a planned item to match"
        data-testid={`inbox-drag-handle-${card.bank.txn.id}`}
        type="button"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm truncate">
          {card.bank.txn.description}
        </div>
        {showDragHint && (
          <div
            className="text-[11px] text-muted-foreground italic mt-0.5"
            data-testid={`inbox-drag-hint-${card.bank.txn.id}`}
          >
            Drag onto a planned item to match
          </div>
        )}
        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          <span>{formatDate(card.bank.date)}</span>
          {categoryName && (
            <Badge
              variant="outline"
              className="text-[10px] border-violet-200 text-violet-700 bg-violet-50"
            >
              {categoryName}
            </Badge>
          )}
          {!categoryName && (
            <Badge variant="outline" className="text-[10px] border-muted text-muted-foreground">
              Uncategorized
            </Badge>
          )}
        </div>
      </div>
      <span
        className={`text-sm font-medium tabular-nums ${
          card.bank.amount < 0 ? "text-destructive" : "text-primary"
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
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue placeholder="Choose a planned item" />
            </SelectTrigger>
            <SelectContent>
              {planRows.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">
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
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={onAddAsBill}
              data-testid={`inbox-add-as-bill-${card.bank.txn.id}`}
              title="Promote this transaction into a recurring bill"
            >
              Add as bill
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onUnplanned}>
            Unplanned
          </Button>
        </div>
      )}
    </div>
  );
}
