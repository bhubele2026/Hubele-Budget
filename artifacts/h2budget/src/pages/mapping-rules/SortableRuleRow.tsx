import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MappingRule, Category } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Trash2,
  Pencil,
  ArrowUp,
  ArrowDown,
  GripVertical,
} from "lucide-react";

export type RuleRowProps = {
  rule: MappingRule;
  category: Category | null;
  isFirst: boolean;
  isLast: boolean;
  isMatched: boolean;
  isWinner: boolean;
  reorderDisabled: boolean;
  dragDisabled: boolean;
  // Task #192 deep-link support: when set, the row is the target of a
  // ?focus=<ruleId> navigation from a transaction's "rule: <pattern>" chip.
  // `isFocused` is deterministic (purely from the URL param) — this is what
  // tests assert on via data-focused. `isHighlighted` is the transient
  // visual ring that fades after a few seconds. `setFocusRef` is the
  // callback ref the parent uses to scroll the row into view; it's
  // composed with the dnd-kit setNodeRef so both can coexist.
  isFocused: boolean;
  isHighlighted: boolean;
  setFocusRef: ((el: HTMLDivElement | null) => void) | null;
  isSelected: boolean;
  onToggleSelected: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onStartEdit: (rule: MappingRule) => void;
  onDelete: (id: string) => void;
};

export function SortableRuleRow({
  rule,
  category,
  isFirst,
  isLast,
  isMatched,
  isWinner,
  reorderDisabled,
  dragDisabled,
  isFocused,
  isHighlighted,
  setFocusRef,
  isSelected,
  onToggleSelected,
  onMove,
  onStartEdit,
  onDelete,
}: RuleRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rule.id, disabled: dragDisabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    position: "relative",
    opacity: isDragging ? 0.6 : 1,
  };

  const stateBg = isHighlighted
    ? "ring-2 ring-blue-400 bg-blue-50 dark:bg-blue-950/30"
    : isWinner
      ? "bg-emerald-50 dark:bg-emerald-950/30"
      : isMatched
        ? "bg-amber-50 dark:bg-amber-950/20"
        : "";

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        if (setFocusRef) setFocusRef(el);
      }}
      style={style}
      className={`flex items-center gap-2 px-4 py-2 hover:bg-muted/30 transition-colors ${stateBg} ${
        isDragging ? "shadow-lg ring-2 ring-primary/40 bg-card" : ""
      }`}
      data-testid={`rule-row-${rule.id}`}
      data-focused={isFocused ? "true" : undefined}
      data-selected={isSelected ? "true" : undefined}
    >
      <Checkbox
        checked={isSelected}
        onCheckedChange={() => onToggleSelected(rule.id)}
        aria-label={`Select rule ${rule.pattern}`}
        data-testid={`rule-select-${rule.id}`}
      />
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...listeners}
        {...attributes}
        disabled={dragDisabled}
        className={`touch-none flex items-center justify-center h-8 w-6 text-muted-foreground hover:text-foreground ${
          dragDisabled
            ? "opacity-40 cursor-not-allowed"
            : "cursor-grab active:cursor-grabbing"
        }`}
        title={
          dragDisabled
            ? "Clear the search to drag"
            : "Drag to reorder (use arrow keys when focused)"
        }
        aria-label={`Drag to reorder ${rule.pattern}`}
        data-testid={`rule-drag-${rule.id}`}
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="flex flex-col">
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-6"
          disabled={isFirst || reorderDisabled}
          onClick={() => onMove(rule.id, -1)}
          data-testid={`rule-up-${rule.id}`}
          title={
            dragDisabled
              ? "Clear the search to reorder"
              : "Move up"
          }
          aria-label={`Move rule ${rule.pattern} up`}
        >
          <ArrowUp className="w-3 h-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-6"
          disabled={isLast || reorderDisabled}
          onClick={() => onMove(rule.id, 1)}
          data-testid={`rule-down-${rule.id}`}
          title={
            dragDisabled
              ? "Clear the search to reorder"
              : "Move down"
          }
          aria-label={`Move rule ${rule.pattern} down`}
        >
          <ArrowDown className="w-3 h-3" />
        </Button>
      </div>
      <Badge
        variant="outline"
        className="font-mono text-[10px] tabular-nums w-12 justify-center"
        data-testid={`rule-priority-${rule.id}`}
      >
        {rule.priority}
      </Badge>
      <span className="font-mono text-xs bg-muted/60 px-2 py-0.5 rounded truncate flex-[2] min-w-0">
        {rule.pattern}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground whitespace-nowrap">
        {rule.matchType.replace("_", " ")}
      </span>
      <span
        className={`text-xs flex-1 min-w-0 truncate ${
          category ? "" : "italic text-muted-foreground"
        }`}
        data-testid={`rule-category-${rule.id}`}
      >
        {category?.name ?? "Uncategorized"}
      </span>
      {isWinner && (
        <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[10px]">
          Winner
        </Badge>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => onStartEdit(rule)}
        data-testid={`rule-edit-btn-${rule.id}`}
        aria-label={`Edit rule ${rule.pattern}`}
      >
        <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => onDelete(rule.id)}
        data-testid={`rule-delete-${rule.id}`}
        aria-label={`Delete rule ${rule.pattern}`}
      >
        <Trash2 className="w-3.5 h-3.5 text-destructive" />
      </Button>
    </div>
  );
}
