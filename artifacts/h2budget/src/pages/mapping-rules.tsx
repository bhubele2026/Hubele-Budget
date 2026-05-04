import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import {
  useListMappingRules,
  useCreateMappingRule,
  useUpdateMappingRule,
  useDeleteMappingRule,
  useReorderMappingRules,
  useTestMappingRules,
  useListCategories,
  usePreviewMappingRuleRecategorize,
  usePreviewMappingRuleRecategorizeByPattern,
  useRecategorizeTransactionsByPattern,
  getListMappingRulesQueryKey,
  createMappingRule,
  deleteMappingRule,
  getListTransactionsQueryKey,
  getGetBudgetMonthQueryKey,
} from "@workspace/api-client-react";
import type {
  MappingRule,
  MappingRuleInput,
  Category,
  MappingRuleRecategorizePreview,
  MappingRulePatternRecategorizePreview,
} from "@workspace/api-client-react";
import {
  useBulkRecategorizePrompt,
  bulkRuleFromRuleAction,
} from "@/hooks/use-bulk-recategorize-prompt";
import { ToastAction } from "@/components/ui/toast";
import {
  RuleMatchesPreviewDialog,
  type RuleMatchesPreviewState,
} from "@/components/rule-matches-preview-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Trash2,
  Search,
  Pencil,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  Beaker,
  GripVertical,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useDroppable,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const CATEGORY_DROP_PREFIX = "category:";

// The DragOverlay shows a compact card while the user drags a rule, but
// dnd-kit's `closestCenter` compares the OVERLAY's center against each
// droppable's center. Since the cursor is anchored near the overlay's
// left edge (the grip handle), the overlay's center sits well to the
// right of the cursor and `closestCenter` ends up choosing a category
// chip that's NOT directly under the pointer. `pointerWithin` first
// matches whatever droppable is precisely under the cursor (which is
// what users expect when dropping on a small chip), and we fall back to
// `closestCenter` so the existing rule-on-rule reorder behavior keeps
// working when the cursor briefly slips outside any droppable.
const ruleCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  if (pointerHits.length > 0) return pointerHits;
  return closestCenter(args);
};

function CategoryDropTarget({
  category,
  isCurrent,
  isDragActive,
}: {
  category: Category;
  isCurrent: boolean;
  isDragActive: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${CATEGORY_DROP_PREFIX}${category.id}`,
    data: { kind: "category", categoryId: category.id },
  });
  const showHover = isOver && isDragActive;
  return (
    <button
      ref={setNodeRef}
      type="button"
      tabIndex={-1}
      aria-label={`Drop rule onto ${category.name}`}
      data-testid={`category-drop-${category.id}`}
      data-drop-over={showHover ? "true" : undefined}
      className={`px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors select-none ${
        showHover
          ? "bg-primary text-primary-foreground border-primary ring-2 ring-primary/40"
          : isCurrent
            ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200"
            : "bg-muted/40 border-border text-foreground hover:bg-muted"
      }`}
    >
      {category.name}
    </button>
  );
}

type RuleRowProps = {
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

function SortableRuleRow({
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
      >
        <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => onDelete(rule.id)}
        data-testid={`rule-delete-${rule.id}`}
      >
        <Trash2 className="w-3.5 h-3.5 text-destructive" />
      </Button>
    </div>
  );
}

export default function MappingRulesPage() {
  const { data: rules, isLoading: rulesLoading } = useListMappingRules();
  const { data: categories, isLoading: catsLoading } = useListCategories();

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const rulesQueryKey = getListMappingRulesQueryKey();

  const invalidateRules = () =>
    queryClient.invalidateQueries({ queryKey: rulesQueryKey });

  // Snapshot the current rule list, cancel any in-flight refetch so it
  // can't overwrite the optimistic state we're about to write, and return
  // the snapshot for rollback.
  const beginOptimistic = async () => {
    await queryClient.cancelQueries({ queryKey: rulesQueryKey });
    const previous =
      queryClient.getQueryData<MappingRule[]>(rulesQueryKey) ?? [];
    return { previous };
  };

  const rollback = (previous: MappingRule[] | undefined) => {
    if (previous) queryClient.setQueryData(rulesQueryKey, previous);
  };

  const createRule = useCreateMappingRule({
    mutation: {
      onMutate: async ({ data }: { data: MappingRuleInput }) => {
        const { previous } = await beginOptimistic();
        // Use a temp id so React keys + the SortableContext stay stable
        // until the server response replaces the row via invalidation.
        const tempId = `temp-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`;
        const optimistic: MappingRule = {
          id: tempId,
          pattern: data.pattern,
          matchType: data.matchType ?? "contains",
          categoryId: data.categoryId ?? null,
          priority: data.priority ?? 0,
        };
        queryClient.setQueryData<MappingRule[]>(rulesQueryKey, [
          ...previous,
          optimistic,
        ]);
        return { previous };
      },
      onError: (err, _vars, context) => {
        rollback(context?.previous);
        toast({
          title: "Couldn't add rule",
          description: (err as Error).message,
          variant: "destructive",
        });
      },
      onSettled: () => {
        invalidateRules();
      },
    },
  });

  const updateRule = useUpdateMappingRule({
    mutation: {
      onMutate: async ({
        id,
        data,
      }: {
        id: string;
        data: MappingRuleInput;
      }) => {
        const { previous } = await beginOptimistic();
        queryClient.setQueryData<MappingRule[]>(
          rulesQueryKey,
          previous.map((r) =>
            r.id === id
              ? {
                  ...r,
                  pattern: data.pattern ?? r.pattern,
                  matchType: data.matchType ?? r.matchType,
                  categoryId:
                    data.categoryId === undefined
                      ? r.categoryId
                      : data.categoryId,
                  priority: data.priority ?? r.priority,
                }
              : r,
          ),
        );
        return { previous };
      },
      onError: (err, _vars, context) => {
        rollback(context?.previous);
        toast({
          title: "Couldn't update rule",
          description: (err as Error).message,
          variant: "destructive",
        });
      },
      onSettled: () => {
        invalidateRules();
      },
    },
  });

  const deleteRule = useDeleteMappingRule({
    mutation: {
      onMutate: async ({ id }: { id: string }) => {
        const { previous } = await beginOptimistic();
        queryClient.setQueryData<MappingRule[]>(
          rulesQueryKey,
          previous.filter((r) => r.id !== id),
        );
        return { previous };
      },
      onError: (err, _vars, context) => {
        rollback(context?.previous);
        toast({
          title: "Couldn't delete rule",
          description: (err as Error).message,
          variant: "destructive",
        });
      },
      onSettled: () => {
        invalidateRules();
      },
    },
  });

  const reorderRules = useReorderMappingRules({
    mutation: {
      onMutate: async ({
        data: { orderedIds },
      }: {
        data: { orderedIds: string[] };
      }) => {
        const { previous } = await beginOptimistic();
        // Mirror what the server does: rewrite priorities to a contiguous
        // descending sequence (10, 20, 30, ...) so the sorted view picks
        // up the new order immediately. The follow-up invalidation will
        // overwrite this with the server's authoritative numbers.
        const byId = new Map(previous.map((r) => [r.id, r] as const));
        const N = orderedIds.length;
        const next: MappingRule[] = [];
        orderedIds.forEach((id, idx) => {
          const r = byId.get(id);
          if (r) {
            next.push({ ...r, priority: (N - idx) * 10 });
            byId.delete(id);
          }
        });
        // Anything not in orderedIds (shouldn't normally happen) keeps
        // its existing priority and is appended so we don't drop rows.
        for (const leftover of byId.values()) next.push(leftover);
        queryClient.setQueryData<MappingRule[]>(rulesQueryKey, next);
        return { previous };
      },
      onError: (err, _vars, context) => {
        rollback(context?.previous);
        toast({
          title: "Couldn't reorder",
          description: (err as Error).message,
          variant: "destructive",
        });
      },
      onSettled: () => {
        invalidateRules();
      },
    },
  });

  const testRules = useTestMappingRules();
  const previewRecategorize = usePreviewMappingRuleRecategorize();
  const previewRecategorizeByPattern =
    usePreviewMappingRuleRecategorizeByPattern();
  const recategorizeBulk = useRecategorizeTransactionsByPattern();

  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState("contains");
  const [categoryId, setCategoryId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [testInput, setTestInput] = useState("");
  // Latest preview returned by POST /mapping-rules/recategorize-preview-by-pattern
  // for the unsaved Add-form rule. Stored alongside the inputs that
  // produced it so we can drop a stale response when the user has
  // since edited the pattern / matchType / category.
  const [addPreview, setAddPreview] =
    useState<MappingRulePatternRecategorizePreview | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPattern, setEditPattern] = useState("");
  const [editMatchType, setEditMatchType] = useState("contains");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editPriority, setEditPriority] = useState<string>("");
  // Snapshot of the rule at edit-start. We need the original `categoryId`
  // to compute `fromCategoryId` for the bulk recategorize on save (the
  // server's preview endpoint also derives fromCategoryId from the rule's
  // current categoryId, so they stay in lock-step). We keep the
  // pattern/matchType in the snapshot only to scope the
  // post-save recategorize to the *previewed* shape.
  const [editingOriginal, setEditingOriginal] = useState<{
    id: string;
    categoryId: string | null;
    pattern: string;
    matchType: string;
  } | null>(null);
  // Latest preview returned by POST /mapping-rules/:id/recategorize-preview.
  // Stored alongside the `toCategoryId` it was computed for so we can guard
  // against showing a stale preview when the user flips the category select
  // again before the previous preview round-trips.
  const [editPreview, setEditPreview] =
    useState<MappingRuleRecategorizePreview | null>(null);
  const [matchesDialog, setMatchesDialog] =
    useState<RuleMatchesPreviewState | null>(null);

  // Task #212 — wire the auto-learn flow's "apply to past charges?"
  // prompt into the Mapping Rules page's hand-create path. The server's
  // POST /mapping-rules response now mirrors the same `ruleAction`
  // shape the auto-learn flow uses on PATCH /transactions/:id, so we
  // can reuse `useBulkRecategorizePrompt` verbatim. The hook returns
  // a `previewDialog` we still need to render (rendered at the bottom
  // of the page); created-rule prompts don't ship sample transactions
  // so the dialog is effectively a no-op for this path, but rendering
  // it keeps the hook usable if we later add per-pattern previews.
  const { offerBulkRecategorize, previewDialog } = useBulkRecategorizePrompt();

  // ---- Bulk selection (Task #223) ----
  // Selected rule ids persist across search filter changes so users can
  // search → tick a few → search again → tick more, then bulk-delete the
  // whole set. The header checkbox only toggles the *currently visible*
  // (filtered) rows. We do prune ids that no longer exist after the
  // server data refreshes (e.g. after our own bulk delete) so stale ids
  // can't linger in the set.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // Both the "Add" form and the Undo-after-delete toast funnel through
  // POST /mapping-rules, but they have different intents:
  //   - "create": the user is declaring fresh categorization intent.
  //     If we have a fresh Task #220 preview snapshot for the pattern
  //     they're adding, chain the bulk recategorize directly so past
  //     uncategorized rows snap onto the new category in one user
  //     action. Otherwise fall back to the "Apply to past too?" toast
  //     prompt driven by the server's `ruleAction`.
  //   - "restore": the user is undoing a deletion they just made, so we
  //     deliberately do NOT re-prompt or chain a recategorize — they're
  //     reverting state, not making a new decision, and asking again
  //     would be confusing.
  // Funneling both call sites through this helper makes that contract
  // explicit at the call site (instead of being implicit in which
  // onSuccess handler the caller happened to pass) so future changes
  // can't accidentally reintroduce the prompt on restore.
  const submitMappingRule = (
    data: MappingRuleInput,
    source: "create" | "restore",
    options?: {
      toCategoryName?: string;
      previewSnapshot?: MappingRulePatternRecategorizePreview | null;
    },
  ) => {
    const toCategoryName = options?.toCategoryName;
    const previewSnapshot = options?.previewSnapshot ?? null;
    createRule.mutate(
      { data },
      {
        onSuccess: (created) => {
          if (source === "restore") {
            toast({ title: "Rule restored" });
            return;
          }
          if (!previewSnapshot) {
            toast({ title: "Rule added" });
            // Surface the same "Apply to past too?" toast as the
            // Transactions / Amex auto-learn flow when the freshly
            // created rule has older uncategorized matches. Hook
            // returns early when candidate count is 0, so we don't
            // need to gate it here.
            const bulkRule = bulkRuleFromRuleAction(
              created.ruleAction,
              toCategoryName,
            );
            if (bulkRule) offerBulkRecategorize(bulkRule);
            return;
          }
          // Task #220 — chain the bulk recategorize so past
          // uncategorized rows snap onto the new category in one
          // user action — same single-step UX the edit flow gives
          // the user on Save.
          const displayName = toCategoryName ?? "the new category";
          recategorizeBulk.mutate(
            {
              data: {
                pattern: previewSnapshot.pattern,
                matchType: previewSnapshot.matchType,
                // The Add preview always scopes to uncategorized
                // rows (`fromCategoryId: null`) — explicit user
                // category edits are preserved by the server's
                // same guard.
                fromCategoryId: null,
                toCategoryId: previewSnapshot.toCategoryId,
              },
            },
            {
              onSuccess: (res) => {
                queryClient.invalidateQueries({
                  queryKey: getListTransactionsQueryKey(),
                });
                for (const m of res.affectedMonths) {
                  queryClient.invalidateQueries({
                    queryKey: getGetBudgetMonthQueryKey(m),
                  });
                }
                // No Undo affordance: the swap would require
                // flipping these rows back to a `null` category,
                // which the bulk endpoint rejects. The user can
                // manually re-edit a row if needed; the rule
                // itself can be deleted via the row-level Trash
                // with its own Undo.
                toast({
                  title: `Rule added · moved ${res.updated} past transaction${res.updated === 1 ? "" : "s"} into ${displayName}`,
                });
              },
              onError: (e) => {
                toast({
                  title: "Rule saved, but couldn't move past transactions",
                  description: (e as Error).message,
                  variant: "destructive",
                });
              },
            },
          );
        },
      },
    );
  };

  // Task #220 — debounced preview of older *uncategorized* transactions
  // that an unsaved Add-form rule would match. Fires whenever the user
  // has both a non-empty pattern and a target category typed in.
  // We debounce to avoid a request on every keystroke and we always
  // verify the response shape still matches the latest inputs before
  // committing it to state — otherwise an in-flight response could
  // overwrite a fresh one if the user is still editing.
  useEffect(() => {
    const trimmed = pattern.trim();
    if (!trimmed || !categoryId) {
      setAddPreview(null);
      return;
    }
    const handle = window.setTimeout(() => {
      previewRecategorizeByPattern.mutate(
        {
          data: {
            pattern: trimmed,
            // The matchType state is a plain string for parity with
            // the edit-row Select; cast at the call site instead of
            // narrowing the state type so the Add card's Select can
            // keep using the same value-type its onValueChange ships.
            matchType: matchType as "contains" | "exact" | "starts_with",
            toCategoryId: categoryId,
          },
        },
        {
          onSuccess: (res) => {
            // Drop late responses if the user has since edited the
            // form so a stale preview can never get pinned to the UI.
            if (
              res.pattern !== trimmed ||
              res.matchType !== matchType ||
              res.toCategoryId !== categoryId
            ) {
              return;
            }
            setAddPreview(res);
          },
          onError: () => {
            // Fail silently — a transient preview failure shouldn't
            // block the user from clicking Add. The Add path stays
            // functional without the banner.
            setAddPreview(null);
          },
        },
      );
    }, 300);
    return () => window.clearTimeout(handle);
    // The mutation hook reference is stable across renders so it's
    // safe to omit from the deps; including it would re-arm the
    // debounce timer on every render and defeat the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, matchType, categoryId]);

  const handleAddRule = () => {
    if (!pattern || !categoryId) return;
    // New manually-added rules go above any auto-learned ones (which top out
    // around priority 100) so the user's intent always wins. Reordering
    // afterwards rewrites priorities anyway.
    const topPriority = (rules ?? []).reduce(
      (m, r) => Math.max(m, r.priority),
      100,
    );
    const data: MappingRuleInput = {
      pattern,
      matchType,
      categoryId,
      priority: topPriority + 10,
    };
    // Snapshot what we'll need *after* the form clears so the chained
    // bulk recategorize and toast still know which pattern + category
    // to act on. Mirrors the edit flow's `previewSnapshot` capture in
    // `saveEdit` — fire the bulk only when the latest preview lines up
    // with what the user is about to save (else the preview is stale
    // and the user might reasonably expect no past rows to move).
    const trimmedPattern = pattern.trim();
    const previewSnapshot =
      addPreview &&
      addPreview.pattern === trimmedPattern &&
      addPreview.matchType === matchType &&
      addPreview.toCategoryId === categoryId &&
      addPreview.candidateCount > 0
        ? addPreview
        : null;
    const toCategoryName = catById.get(categoryId)?.name ?? "the new category";
    // Clear the form right away so the input feels responsive — the
    // optimistic row already shows the new rule in the list below.
    setPattern("");
    // Drop the preview snapshot from state too — the form is empty so
    // the banner shouldn't linger after the user has acted on it.
    setAddPreview(null);
    submitMappingRule(data, "create", {
      toCategoryName,
      previewSnapshot,
    });
  };

  // Bulk delete the currently selected rules with a single Undo toast
  // that recreates the whole batch in one go (Task #223). The API has no
  // bulk endpoint yet, so we fan out DELETE / POST requests in parallel
  // — fine for the realistic max of a few dozen rules.
  //
  // We bypass the per-id useDeleteMappingRule mutation here on purpose:
  // its onMutate snapshots `previous` and writes `previous.filter(...)`,
  // and N concurrent mutations would race on that snapshot and clobber
  // each other's optimistic deletions. Instead we apply *one* combined
  // optimistic update covering every selected id, then issue the network
  // calls; onSettled-style invalidation runs once at the end.
  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const allRules = rules ?? [];
    const idSet = new Set(ids);
    const deleted = allRules.filter((r) => idSet.has(r.id));
    if (deleted.length === 0) {
      clearSelection();
      return;
    }

    setBulkDeleting(true);
    await queryClient.cancelQueries({ queryKey: rulesQueryKey });
    const previous =
      queryClient.getQueryData<MappingRule[]>(rulesQueryKey) ?? [];
    queryClient.setQueryData<MappingRule[]>(
      rulesQueryKey,
      previous.filter((r) => !idSet.has(r.id)),
    );
    clearSelection();

    try {
      await Promise.all(deleted.map((r) => deleteMappingRule(r.id)));
      const count = deleted.length;
      const { dismiss } = toast({
        title: `Deleted ${count} rule${count === 1 ? "" : "s"}`,
        // Match the single-delete toast duration (~6s) — long enough to
        // recover from an accidental click on a long auto-learned list.
        duration: 6000,
        action: (
          <ToastAction
            altText="Undo bulk delete rules"
            data-testid="action-undo-bulk-delete-rules"
            onClick={() => {
              dismiss();
              void handleBulkUndo(deleted);
            }}
          >
            Undo
          </ToastAction>
        ),
      });
    } catch (e) {
      // Roll back the optimistic remove if any DELETE failed — server
      // state is now ambiguous (some may have succeeded), so we surface
      // an error and let the invalidation reconcile.
      rollback(previous);
      toast({
        title: "Couldn't delete rules",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setBulkDeleting(false);
      invalidateRules();
    }
  };

  // Restore a previously-deleted batch in one go. Each new rule is
  // recreated with the same pattern / matchType / categoryId / priority
  // so its position in the priority-sorted list lands back where it was.
  // (The server may issue new ids — that's fine, the cache invalidation
  // below picks them up.)
  const handleBulkUndo = async (deleted: MappingRule[]) => {
    if (deleted.length === 0) return;
    try {
      await Promise.all(
        deleted.map((r) =>
          createMappingRule({
            pattern: r.pattern,
            matchType: r.matchType,
            categoryId: r.categoryId,
            priority: r.priority,
          }),
        ),
      );
      toast({
        title: `Restored ${deleted.length} rule${deleted.length === 1 ? "" : "s"}`,
      });
    } catch (e) {
      toast({
        title: "Couldn't restore rules",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      invalidateRules();
    }
  };

  const handleDeleteRule = (id: string) => {
    // Capture the rule's full shape *before* the delete fires so the Undo
    // action can recreate it with the same pattern / matchType /
    // categoryId / priority. Each toast closes over its own `deleted`
    // value, so two quick deletions in a row each undo the right rule
    // even though only the most recent toast is visible at a time
    // (the toast hook is configured with TOAST_LIMIT = 1).
    const deleted = (rules ?? []).find((r) => r.id === id);
    deleteRule.mutate(
      { id },
      {
        onSuccess: () => {
          if (!deleted) {
            toast({ title: "Rule deleted" });
            return;
          }
          const { dismiss } = toast({
            title: "Rule deleted",
            // ~6 seconds — long enough to recover from an accidental
            // click on an auto-learned rule, short enough not to linger.
            duration: 6000,
            action: (
              <ToastAction
                altText="Undo delete rule"
                data-testid={`action-undo-delete-rule-${deleted.id}`}
                onClick={() => {
                  dismiss();
                  // source: "restore" suppresses the "Apply to past too?"
                  // prompt — the user is undoing, not making fresh
                  // categorization intent. See submitMappingRule above.
                  submitMappingRule(
                    {
                      pattern: deleted.pattern,
                      matchType: deleted.matchType,
                      categoryId: deleted.categoryId,
                      priority: deleted.priority,
                    },
                    "restore",
                  );
                }}
              >
                Undo
              </ToastAction>
            ),
          });
        },
      },
    );
  };

  const startEdit = (rule: MappingRule) => {
    setEditingId(rule.id);
    setEditPattern(rule.pattern);
    setEditMatchType(rule.matchType);
    setEditCategoryId(rule.categoryId ?? "");
    setEditPriority(String(rule.priority));
    setEditingOriginal({
      id: rule.id,
      categoryId: rule.categoryId ?? null,
      pattern: rule.pattern,
      matchType: rule.matchType,
    });
    setEditPreview(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingOriginal(null);
    setEditPreview(null);
  };

  // Triggered when the user picks a different category in the edit form.
  // We fire a read-only preview against the same rule so the form can
  // show "N past transactions will move into <new category>" with a
  // "Show matches" affordance — same dialog the Chase/Transactions page
  // surfaces after a quick-categorize repoints a rule. We skip the
  // round-trip when the rule is currently uncategorized (the bulk
  // endpoint can't safely scope without a fromCategoryId) or when the
  // target category is unchanged.
  const handleEditCategoryChange = (nextCategoryId: string) => {
    setEditCategoryId(nextCategoryId);
    if (!editingOriginal) return;
    const fromCategoryId = editingOriginal.categoryId;
    if (
      !fromCategoryId ||
      !nextCategoryId ||
      nextCategoryId === fromCategoryId
    ) {
      setEditPreview(null);
      return;
    }
    previewRecategorize.mutate(
      { id: editingOriginal.id, data: { toCategoryId: nextCategoryId } },
      {
        onSuccess: (res) => {
          // Drop late responses if the user has since flipped the select
          // again or cancelled the edit.
          if (res.toCategoryId !== nextCategoryId) return;
          setEditPreview(res);
        },
        onError: () => {
          // Silently fall back to the no-preview UX so a transient
          // failure doesn't block the user from saving the rule edit.
          setEditPreview(null);
        },
      },
    );
  };

  const saveEdit = (id: string) => {
    if (!editPattern || !editCategoryId) return;
    const priorityNum = Number.parseInt(editPriority, 10);
    // Capture preview before clearing edit state so the chained bulk
    // recategorize can fire even after we tear the edit row down.
    const previewSnapshot =
      editPreview &&
      editPreview.candidateCount > 0 &&
      editPreview.toCategoryId === editCategoryId &&
      editPreview.fromCategoryId
        ? editPreview
        : null;
    const toCategoryName =
      catById.get(editCategoryId)?.name ?? "the new category";
    // Close the editor immediately — the optimistic update from the
    // updateRule mutation config will repaint the read-only row with
    // the new values before the server replies. On error, that hook's
    // onError rolls back the cache and surfaces the failure toast.
    setEditingId(null);
    setEditingOriginal(null);
    setEditPreview(null);
    updateRule.mutate(
      {
        id,
        data: {
          pattern: editPattern,
          matchType: editMatchType,
          categoryId: editCategoryId,
          ...(Number.isFinite(priorityNum) ? { priority: priorityNum } : {}),
        },
      },
      {
        onSuccess: () => {
          if (!previewSnapshot) {
            toast({ title: "Rule updated" });
            return;
          }
          // Chain the bulk recategorize so the past transactions snap
          // onto the new category in one user action, mirroring the
          // Chase-page "Apply" toast UX.
          recategorizeBulk.mutate(
            {
              data: {
                pattern: previewSnapshot.pattern,
                matchType: previewSnapshot.matchType,
                fromCategoryId: previewSnapshot.fromCategoryId!,
                toCategoryId: previewSnapshot.toCategoryId,
              },
            },
            {
              onSuccess: (res) => {
                queryClient.invalidateQueries({
                  queryKey: getListTransactionsQueryKey(),
                });
                for (const m of res.affectedMonths) {
                  queryClient.invalidateQueries({
                    queryKey: getGetBudgetMonthQueryKey(m),
                  });
                }
                toast({
                  title: `Rule updated · moved ${res.updated} past transaction${res.updated === 1 ? "" : "s"} into ${toCategoryName}`,
                  action: (
                    <ToastAction
                      altText="Undo bulk recategorize"
                      data-testid="action-undo-bulk-recategorize-edit"
                      onClick={() => {
                        if (res.affectedIds.length === 0) return;
                        recategorizeBulk.mutate(
                          {
                            data: {
                              pattern: previewSnapshot.pattern,
                              matchType: previewSnapshot.matchType,
                              fromCategoryId: previewSnapshot.toCategoryId,
                              toCategoryId: previewSnapshot.fromCategoryId!,
                              ids: res.affectedIds,
                              // Re-point the rule back to its previous
                              // category too — without this the rule
                              // would still match new charges into the
                              // category the user just undid.
                              ruleId: previewSnapshot.ruleId,
                            },
                          },
                          {
                            onSuccess: (undoRes) => {
                              queryClient.invalidateQueries({
                                queryKey: getListTransactionsQueryKey(),
                              });
                              for (const m of undoRes.affectedMonths) {
                                queryClient.invalidateQueries({
                                  queryKey: getGetBudgetMonthQueryKey(m),
                                });
                              }
                              // The server-side `ruleId` re-point on the
                              // bulk endpoint also flipped the mapping
                              // rule's categoryId back to its pre-edit
                              // value (see Task #199 widening of
                              // /transactions/recategorize-by-pattern).
                              // Without invalidating the rules cache
                              // here the page would keep showing the
                              // rule pointed at the just-undone
                              // category until the next refetch — so
                              // the visible "Undo" outcome would be
                              // asymmetric with Save (txns snap back,
                              // rule appears unchanged). Invalidate so
                              // the read-only rule row repaints with
                              // the restored category badge.
                              invalidateRules();
                              toast({
                                title:
                                  undoRes.updated === 0
                                    ? "Rule reverted"
                                    : `Reverted ${undoRes.updated} transaction${undoRes.updated === 1 ? "" : "s"} and rule`,
                              });
                            },
                            onError: (e) => {
                              toast({
                                title: "Couldn't undo",
                                description: (e as Error).message,
                                variant: "destructive",
                              });
                            },
                          },
                        );
                      }}
                    >
                      Undo
                    </ToastAction>
                  ),
                });
              },
              onError: (e) => {
                toast({
                  title: "Rule saved, but couldn't move past transactions",
                  description: (e as Error).message,
                  variant: "destructive",
                });
              },
            },
          );
        },
      },
    );
  };

  const sorted = useMemo(() => {
    return [...(rules ?? [])].sort((a, b) => b.priority - a.priority);
  }, [rules]);

  const persistOrder = (orderedIds: string[]) => {
    reorderRules.mutate({ data: { orderedIds } });
  };

  const moveRule = (id: string, direction: -1 | 1) => {
    const idx = sorted.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= sorted.length) return;
    const nextOrder = arrayMove(sorted, idx, nextIdx);
    persistOrder(nextOrder.map((r) => r.id));
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const catById = useMemo(() => {
    const m = new Map<string, Category>();
    for (const c of categories ?? []) m.set(c.id, c);
    return m;
  }, [categories]);

  const handleDragStart = (e: DragStartEvent) => {
    setActiveDragId(String(e.active.id));
  };

  const reassignRuleCategory = (ruleId: string, newCategoryId: string) => {
    const rule = (rules ?? []).find((r) => r.id === ruleId);
    if (!rule) return;
    if (rule.categoryId === newCategoryId) return;
    const targetCat = catById.get(newCategoryId);
    updateRule.mutate(
      {
        id: ruleId,
        data: {
          pattern: rule.pattern,
          matchType: rule.matchType,
          categoryId: newCategoryId,
          priority: rule.priority,
        },
      },
      {
        onSuccess: () => {
          invalidateRules();
          toast({
            title: "Rule reassigned",
            description: targetCat
              ? `“${rule.pattern}” → ${targetCat.name}`
              : `“${rule.pattern}” moved to a new category.`,
          });
        },
        onError: (err) => {
          toast({
            title: "Couldn't reassign rule",
            description: (err as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveDragId(null);
    if (!over || active.id === over.id) return;
    const overId = String(over.id);
    if (overId.startsWith(CATEGORY_DROP_PREFIX)) {
      const newCategoryId = overId.slice(CATEGORY_DROP_PREFIX.length);
      reassignRuleCategory(String(active.id), newCategoryId);
      return;
    }
    const oldIdx = sorted.findIndex((r) => r.id === active.id);
    const newIdx = sorted.findIndex((r) => r.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const nextOrder = arrayMove(sorted, oldIdx, newIdx);
    persistOrder(nextOrder.map((r) => r.id));
  };

  const handleDragCancel = () => setActiveDragId(null);

  const activeDragRule = useMemo(
    () =>
      activeDragId ? (rules ?? []).find((r) => r.id === activeDragId) ?? null : null,
    [activeDragId, rules],
  );

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((r) => {
      const catName = catById.get(r.categoryId ?? "")?.name ?? "";
      return (
        r.pattern.toLowerCase().includes(q) ||
        catName.toLowerCase().includes(q) ||
        r.matchType.toLowerCase().includes(q)
      );
    });
  }, [sorted, catById, searchQuery]);

  // Drop selection ids that no longer exist in the server data so a
  // stale id can never linger in the set after a delete (single or
  // bulk). Selections deliberately survive search-query changes — the
  // user can search → tick a few → search again → tick more, then
  // bulk-delete the whole set.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set((rules ?? []).map((r) => r.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rules]);

  // Header checkbox is scoped to the *currently filtered* (visible)
  // rows. It reads as fully checked only when every visible row is
  // selected, indeterminate when some are.
  const visibleSelectionState: boolean | "indeterminate" = useMemo(() => {
    if (filtered.length === 0) return false;
    let selectedCount = 0;
    for (const r of filtered) if (selected.has(r.id)) selectedCount++;
    if (selectedCount === 0) return false;
    if (selectedCount === filtered.length) return true;
    return "indeterminate";
  }, [filtered, selected]);

  const toggleAllVisible = (on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of filtered) {
        if (on) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
  };

  const handleRunTest = () => {
    if (!testInput.trim()) return;
    testRules.mutate({ data: { description: testInput } });
  };

  const matchedIds = useMemo(() => {
    const data = testRules.data;
    if (!data) return new Set<string>();
    return new Set(data.matches.map((m) => m.rule.id));
  }, [testRules.data]);

  // ?focus=<ruleId>[,<ruleId>...] deep-link support — clicked from the
  // "rule: 'PATTERN'" chip on the Transactions / Amex pages, or from the
  // "View" action on the post-sync / post-import toast (which can pass
  // multiple ids when several rules contributed to a single batch). We
  // scroll the FIRST matched row into view and briefly flash a ring
  // around every matched row so the user spots all of them in a long
  // list, then drop the highlight after a few seconds. The focus also
  // forces the search to be cleared so the rows can never be filtered out
  // before we can scroll to them.
  const search = useSearch();
  const focusIds = useMemo(() => {
    const params = new URLSearchParams(search);
    const raw = params.get("focus");
    if (!raw) return [] as string[];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, [search]);
  const focusIdSet = useMemo(() => new Set(focusIds), [focusIds]);
  // Backwards-compat alias for the existing single-id call sites
  // (`isFocused = rule.id === focusId`) so the membership check below
  // can stay a one-liner.
  const focusId = focusIds[0] ?? null;
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const focusRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusIds.length === 0) return;
    if (!rules || rules.length === 0) return;
    const matched = focusIds.filter((id) => rules.some((r) => r.id === id));
    if (matched.length === 0) return;
    if (searchQuery) setSearchQuery("");
    setHighlightedIds(new Set(matched));
    const t = window.setTimeout(() => {
      focusRowRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 50);
    const clear = window.setTimeout(() => setHighlightedIds(new Set()), 4000);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIds, rules]);

  const winningId = useMemo(() => {
    const data = testRules.data;
    if (!data) return null;
    return data.matches.find((m) => m.winner)?.rule.id ?? null;
  }, [testRules.data]);

  if (rulesLoading || catsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // Drag-and-drop reorders the full sorted list, so we must disable it
  // whenever a search filter is hiding rules — otherwise dropping would
  // misplace items relative to the hidden ones.
  const dragDisabled = !!searchQuery || reorderRules.isPending;
  const sortableIds = sorted.map((r) => r.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Mapping Rules
        </h1>
        <p className="text-muted-foreground mt-1">
          Auto-categorize transactions based on description patterns. Higher
          priority rules win when more than one matches. New rules are also
          added automatically when you categorize a transaction.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add New Rule</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row items-end md:items-center gap-4">
            <div className="flex-1 w-full space-y-1">
              <label className="text-xs font-medium">If description</label>
              <Select value={matchType} onValueChange={setMatchType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">Contains</SelectItem>
                  <SelectItem value="exact">Equals Exactly</SelectItem>
                  <SelectItem value="starts_with">Starts With</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-[2] w-full space-y-1">
              <label className="text-xs font-medium">Text Pattern</label>
              <Input
                placeholder="e.g. STARBUCKS"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                data-testid="input-add-pattern"
              />
            </div>
            <div className="flex-1 w-full space-y-1">
              <label className="text-xs font-medium">Assign to Category</label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select Category" />
                </SelectTrigger>
                <SelectContent>
                  {categories?.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full md:w-auto"
              onClick={handleAddRule}
              disabled={!pattern || !categoryId || createRule.isPending}
              data-testid="btn-add-rule"
            >
              <Plus className="w-4 h-4 mr-2" /> Add
            </Button>
          </div>
          {/*
            * Task #220 — preview banner for the unsaved Add-form rule.
            * Mirrors the same shape and copy as the edit-row banner so
            * users see consistent affordances whichever path they used,
            * with "Show matches" opening the shared dialog.
            */}
          {addPreview &&
            addPreview.pattern === pattern.trim() &&
            addPreview.matchType === matchType &&
            addPreview.toCategoryId === categoryId &&
            addPreview.candidateCount > 0 && (
              <div
                className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
                data-testid="rule-add-preview"
              >
                <span>
                  <span
                    className="font-medium"
                    data-testid="rule-add-preview-count"
                  >
                    {addPreview.candidateCount}
                  </span>{" "}
                  past transaction
                  {addPreview.candidateCount === 1 ? "" : "s"} will move into{" "}
                  <span className="font-medium">
                    {catById.get(addPreview.toCategoryId)?.name ??
                      "the new category"}
                  </span>{" "}
                  when you add this rule.
                </span>
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2 hover:text-foreground"
                  data-testid="link-show-rule-matches-add"
                  onClick={() =>
                    setMatchesDialog({
                      pattern: addPreview.pattern,
                      candidateCount: addPreview.candidateCount,
                      sampleTransactions: addPreview.sampleTransactions,
                      toCategoryName:
                        catById.get(addPreview.toCategoryId)?.name ??
                        "the new category",
                    })
                  }
                >
                  Show matches
                </button>
              </div>
            )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Beaker className="w-4 h-4 text-muted-foreground" />
            Test a description
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
            <Input
              placeholder='e.g. "AMAZON FRESH 4732 SEATTLE WA"'
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRunTest();
              }}
              data-testid="input-test-description"
            />
            <div className="flex gap-2">
              <Button
                onClick={handleRunTest}
                disabled={!testInput.trim() || testRules.isPending}
                data-testid="btn-run-test"
              >
                Test
              </Button>
              {testRules.data && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    testRules.reset();
                    setTestInput("");
                  }}
                  data-testid="btn-clear-test"
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
          {testRules.data && (
            <div
              className="mt-3 text-sm"
              data-testid="test-result"
            >
              {testRules.data.matches.length === 0 ? (
                <p className="text-muted-foreground">
                  No rules match this description.
                </p>
              ) : (
                <p>
                  <span className="font-medium">
                    {testRules.data.matches.length}
                  </span>{" "}
                  matching {testRules.data.matches.length === 1 ? "rule" : "rules"}.{" "}
                  {testRules.data.winningCategoryId ? (
                    <>
                      Winner:{" "}
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">
                        {catById.get(testRules.data.winningCategoryId)?.name ??
                          "(unknown category)"}
                      </span>
                      .
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      No matching rule has a category set.
                    </span>
                  )}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search rules by pattern, category, or match type..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-rules"
        />
        {searchQuery && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {filtered.length} result{filtered.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {sorted.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No mapping rules yet. Categorize a transaction on the Chase page and
            a rule will be created automatically.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-base">
              <span>Rules in priority order</span>
              <span className="text-xs font-normal text-muted-foreground">
                {sorted.length} total{" "}
                {searchQuery ? `· ${filtered.length} shown` : ""}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {/* Bulk action bar — header checkbox toggles only the
              * currently filtered (visible) rows, but the "Delete
              * selected (N)" button reflects the *total* selection
              * (which can include rows hidden by the search filter).
              * Clear selection lets the user back out without
              * touching anything else. */}
            <div
              className="flex items-center gap-3 px-4 py-2 border-b bg-muted/30"
              data-testid="rule-bulk-bar"
            >
              <Checkbox
                checked={visibleSelectionState}
                onCheckedChange={(v) => toggleAllVisible(!!v)}
                aria-label="Select all visible rules"
                disabled={filtered.length === 0}
                data-testid="rule-select-all"
              />
              <span className="text-xs text-muted-foreground">
                {selected.size > 0
                  ? `${selected.size} selected`
                  : searchQuery
                    ? `Select all ${filtered.length} shown`
                    : "Select all"}
              </span>
              {selected.size > 0 && (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="ml-auto h-7"
                    onClick={handleBulkDelete}
                    disabled={bulkDeleting}
                    data-testid="rule-bulk-delete"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    Delete selected ({selected.size})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={clearSelection}
                    disabled={bulkDeleting}
                    data-testid="rule-bulk-clear"
                  >
                    Clear
                  </Button>
                </>
              )}
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={ruleCollisionDetection}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              {(categories?.length ?? 0) > 0 && (
                <div
                  className={`px-4 py-3 border-b bg-muted/20 transition-colors ${
                    activeDragId ? "bg-primary/5" : ""
                  }`}
                  data-testid="category-drop-strip"
                >
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                    {activeDragId
                      ? "Drop on a category to reassign"
                      : "Drag a rule onto a category to reassign it"}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {categories?.map((cat) => (
                      <CategoryDropTarget
                        key={cat.id}
                        category={cat}
                        isCurrent={
                          activeDragRule?.categoryId === cat.id
                        }
                        isDragActive={activeDragId !== null}
                      />
                    ))}
                  </div>
                </div>
              )}
              <SortableContext
                items={sortableIds}
                strategy={verticalListSortingStrategy}
              >
                <div className="divide-y divide-border">
                  {filtered.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground text-sm">
                      No rules match your search.
                    </div>
                  ) : (
                    filtered.map((rule) => {
                      const idxInFull = sorted.findIndex(
                        (r) => r.id === rule.id,
                      );
                      const isFirst = idxInFull === 0;
                      const isLast = idxInFull === sorted.length - 1;
                      const cat = rule.categoryId
                        ? catById.get(rule.categoryId) ?? null
                        : null;
                      const isMatched = matchedIds.has(rule.id);
                      const isWinner = winningId === rule.id;
                      const reorderDisabled =
                        reorderRules.isPending || !!searchQuery;
                      if (editingId === rule.id) {
                        return (
                          <div
                            key={rule.id}
                            className="flex flex-col gap-2 px-4 py-3 bg-muted/20"
                            data-testid={`rule-edit-${rule.id}`}
                          >
                            <Input
                              value={editPattern}
                              onChange={(e) => setEditPattern(e.target.value)}
                              className="h-8 text-sm font-mono"
                              autoFocus
                            />
                            <div className="flex items-center gap-2 flex-wrap">
                              <Select
                                value={editMatchType}
                                onValueChange={setEditMatchType}
                              >
                                <SelectTrigger className="h-8 text-xs flex-1 min-w-[120px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="contains">
                                    Contains
                                  </SelectItem>
                                  <SelectItem value="exact">Exact</SelectItem>
                                  <SelectItem value="starts_with">
                                    Starts With
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <Select
                                value={editCategoryId}
                                onValueChange={handleEditCategoryChange}
                              >
                                <SelectTrigger
                                  className="h-8 text-xs flex-[2] min-w-[160px]"
                                  data-testid={`rule-edit-category-${rule.id}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {categories?.map((cat) => (
                                    <SelectItem key={cat.id} value={cat.id}>
                                      {cat.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <div className="flex items-center gap-1">
                                <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                  Priority
                                </label>
                                <Input
                                  type="number"
                                  value={editPriority}
                                  onChange={(e) =>
                                    setEditPriority(e.target.value)
                                  }
                                  className="h-8 w-20 text-xs"
                                  data-testid={`rule-edit-priority-${rule.id}`}
                                />
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => saveEdit(rule.id)}
                                disabled={
                                  !editPattern ||
                                  !editCategoryId ||
                                  updateRule.isPending
                                }
                                data-testid={`rule-save-${rule.id}`}
                              >
                                <Check className="w-4 h-4 text-emerald-600" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={cancelEdit}
                              >
                                <X className="w-4 h-4" />
                              </Button>
                            </div>
                            {editPreview &&
                              editPreview.toCategoryId === editCategoryId &&
                              editPreview.candidateCount > 0 && (
                                <div
                                  className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
                                  data-testid={`rule-edit-preview-${rule.id}`}
                                >
                                  <span>
                                    <span
                                      className="font-medium"
                                      data-testid={`rule-edit-preview-count-${rule.id}`}
                                    >
                                      {editPreview.candidateCount}
                                    </span>{" "}
                                    past transaction
                                    {editPreview.candidateCount === 1
                                      ? ""
                                      : "s"}{" "}
                                    will move into{" "}
                                    <span className="font-medium">
                                      {catById.get(editPreview.toCategoryId)
                                        ?.name ?? "the new category"}
                                    </span>{" "}
                                    when you save.
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 underline underline-offset-2 hover:text-foreground"
                                    data-testid={`link-show-rule-matches-edit-${rule.id}`}
                                    onClick={() =>
                                      setMatchesDialog({
                                        pattern: editPreview.pattern,
                                        candidateCount:
                                          editPreview.candidateCount,
                                        sampleTransactions:
                                          editPreview.sampleTransactions,
                                        toCategoryName:
                                          catById.get(
                                            editPreview.toCategoryId,
                                          )?.name ?? "the new category",
                                      })
                                    }
                                  >
                                    Show matches
                                  </button>
                                </div>
                              )}
                          </div>
                        );
                      }
                      const isFocused = focusIdSet.has(rule.id);
                      // Only the first matched focus id receives the
                      // scroll-target ref so we don't bounce around
                      // jumping to multiple rows when the toast deep-link
                      // included several rule ids.
                      const isScrollTarget = rule.id === focusId;
                      return (
                        <SortableRuleRow
                          key={rule.id}
                          rule={rule}
                          category={cat}
                          isFirst={isFirst}
                          isLast={isLast}
                          isMatched={isMatched}
                          isWinner={isWinner}
                          reorderDisabled={reorderDisabled}
                          dragDisabled={dragDisabled}
                          isFocused={isFocused}
                          isHighlighted={highlightedIds.has(rule.id)}
                          setFocusRef={
                            isScrollTarget
                              ? (el) => {
                                  focusRowRef.current = el;
                                }
                              : null
                          }
                          isSelected={selected.has(rule.id)}
                          onToggleSelected={toggleSelected}
                          onMove={moveRule}
                          onStartEdit={startEdit}
                          onDelete={handleDeleteRule}
                        />
                      );
                    })
                  )}
                </div>
              </SortableContext>
              <DragOverlay>
                {activeDragRule ? (
                  <div
                    className="flex items-center gap-2 px-3 py-2 rounded-md border bg-card shadow-lg ring-2 ring-primary/40"
                    data-testid="rule-drag-overlay"
                  >
                    <GripVertical className="w-4 h-4 text-muted-foreground" />
                    <span className="font-mono text-xs bg-muted/60 px-2 py-0.5 rounded">
                      {activeDragRule.pattern}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {activeDragRule.matchType.replace("_", " ")}
                    </span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </CardContent>
        </Card>
      )}
      {previewDialog}

      <RuleMatchesPreviewDialog
        state={matchesDialog}
        onOpenChange={(open) => {
          if (!open) setMatchesDialog(null);
        }}
        onApply={() => {
          // From the Mapping Rules edit flow the bulk recategorize fires
          // on Save (after the PATCH succeeds) so the dialog's Apply
          // button is just a "got it, close this" — we still wire it to
          // close the dialog so behavior matches the Chase-page entry
          // point's keyboard/click affordances.
          setMatchesDialog(null);
        }}
      />

    </div>
  );
}
