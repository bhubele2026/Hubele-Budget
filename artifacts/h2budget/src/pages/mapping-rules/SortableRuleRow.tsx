import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MappingRule, Category } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { shortDateOfInstant } from "@/lib/dates";
import { btnLink, btnLinkDanger, fieldLabel } from "@/ui";
import { RuleHistoryPopover } from "./RuleHistoryPopover";
import {
  Trash2,
  Pencil,
  ArrowUp,
  ArrowDown,
  GripVertical,
} from "lucide-react";

/**
 * The nudge-one-slot control. The kit has no button this small — a `btnLink`'s
 * ring and padding would be taller than the row it sits in — so this is a
 * bespoke shape, and like every bespoke control in the app it still starts
 * with `press` so it answers a click on the same frame as everything else.
 */
const stepBtn =
  "press flex h-5 w-6 items-center justify-center rounded text-neutral-400 hover:bg-platinum-3 hover:text-brand-navy disabled:pointer-events-none disabled:opacity-40";

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
  /** (WP5b) Names a category for the History popover (null = no category). */
  categoryName: (id: string | null) => string;
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
  categoryName,
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

  // ⚠️ Tint only, never a hue. Under the palette rule a row cannot say
  // anything with colour alone, so "winner" and "matched" each also carry a
  // chip that says the word — the platinum step just makes them findable.
  const stateBg = isHighlighted
    ? "ring-2 ring-brand-navy/50 bg-brand-navy/5"
    : isWinner
      ? "bg-platinum-3"
      : isMatched
        ? "bg-platinum-2"
        : "";

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        if (setFocusRef) setFocusRef(el);
      }}
      style={style}
      // ⚠️ No `press` here: dnd-kit drives this element's transform from
      // inline style, and a class-level transform transition would smear
      // every drag frame behind the pointer.
      className={`flex items-center gap-2 px-3 py-2 transition-colors hover:bg-platinum-2 ${stateBg} ${
        isDragging ? "surface surface-raised ring-2 ring-brand-navy/40" : ""
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
        className={`flex h-8 w-6 touch-none items-center justify-center text-neutral-400 hover:text-brand-navy ${
          dragDisabled
            ? "cursor-not-allowed opacity-40"
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
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex flex-col">
        <button
          type="button"
          className={stepBtn}
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
          <ArrowUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          className={stepBtn}
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
          <ArrowDown className="h-3 w-3" />
        </button>
      </div>
      <span
        className="w-12 shrink-0 text-center font-mono text-micro tabular-nums text-neutral-500"
        title="Priority — the highest match wins"
        data-testid={`rule-priority-${rule.id}`}
      >
        {rule.priority}
      </span>
      {/* (C7) On a phone the pattern takes its own line and the match type
          and category sit under it; from `sm` up they share one line. Fixed
          bases (8rem pattern, 10rem match type + category, growing 1:2) keep
          the columns aligned down a card and leave the category room in a
          ~500 px three-column card — the old content-sized 2:1 split left
          "D…" there, and one line on a 340 px card left the pattern a single
          letter. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
        {/* ⚠️ The tint hugs the TEXT, not the column. Painting the flex child
            itself stretched the pill into a ~700px empty bar on a wide row,
            which read as a broken input rather than a pattern. */}
        <span className="min-w-0 sm:flex-[1_1_8rem]">
          <span className="inline-block max-w-full truncate rounded bg-platinum-3 px-2 py-0.5 align-middle font-mono text-micro text-brand-navy">
            {rule.pattern}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2 sm:flex-[2_1_10rem]">
          <span className={`${fieldLabel} whitespace-nowrap`}>
            {rule.matchType.replace("_", " ")}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-body ${
              category ? "text-neutral-700" : "italic text-neutral-400"
            }`}
            data-testid={`rule-category-${rule.id}`}
          >
            {category?.name ?? "Uncategorized"}
          </span>
        </span>
      </span>
      {/* (WP5b) The last direct edit (pattern, match, category or priority);
          a reorder is in the history but is not an edit. Absent = not edited
          since rule history began. */}
      {rule.updatedAt ? (
        <span
          className="shrink-0 whitespace-nowrap text-micro text-neutral-500"
          title="The last time this rule's pattern, match, category or priority was changed"
          data-testid={`rule-edited-${rule.id}`}
        >
          edited {shortDateOfInstant(rule.updatedAt)}
        </span>
      ) : null}
      {isWinner ? (
        <span className="chip ok">Winner</span>
      ) : isMatched ? (
        <span className="chip gray">Match</span>
      ) : null}
      <RuleHistoryPopover ruleId={rule.id} pattern={rule.pattern} categoryName={categoryName} />
      <button
        type="button"
        className={btnLink}
        onClick={() => onStartEdit(rule)}
        data-testid={`rule-edit-btn-${rule.id}`}
        title="Edit"
        aria-label={`Edit rule ${rule.pattern}`}
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={btnLinkDanger}
        onClick={() => onDelete(rule.id)}
        data-testid={`rule-delete-${rule.id}`}
        title="Delete — undo appears for a few seconds"
        aria-label={`Delete rule ${rule.pattern}`}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
