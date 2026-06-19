import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch, useLocation } from "wouter";
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
  useUncategorizeTransactionsByIds,
  getListMappingRulesQueryKey,
  createMappingRule,
  updateMappingRule,
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
  Check,
  X,
  Beaker,
  GripVertical,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
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
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import {
  CategoryDropTarget,
  CATEGORY_DROP_PREFIX,
} from "./mapping-rules/CategoryDropTarget";
import { SortableRuleRow } from "./mapping-rules/SortableRuleRow";

// Task #244 — persist "I've already reviewed this batch" across reloads
// and repeat clicks of the post-sync / post-import toast's "View" link.
// The pill is dismissible per visit (in component state), but without
// persistence a reload or a second "View" click for the same batch of
// rule ids re-shows the pill even though the user has already audited
// those rules. We key the dismissal by a hash of the sorted focus ids
// so a *different* combination (a genuinely new sync/import batch)
// still triggers the pill.
const FOCUS_PILL_DISMISSED_STORAGE_KEY =
  "h2budget:mappingRules:dismissedFocusBatches";
// Cap the persisted list so it can't grow unbounded over months of
// syncs. 50 is plenty for the "did I already see this?" check — older
// batches that fall off the list will just re-show the pill once,
// which is the same as never having dismissed them.
const FOCUS_PILL_DISMISSED_MAX = 50;

function focusBatchKey(ids: readonly string[]): string {
  // Sort so the URL's id ordering doesn't matter — `?focus=a,b` and
  // `?focus=b,a` are the same audit batch from the user's POV.
  return [...ids].sort().join(",");
}

function loadDismissedFocusBatches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FOCUS_PILL_DISMISSED_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

function isFocusBatchDismissed(ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  return loadDismissedFocusBatches().includes(focusBatchKey(ids));
}

function rememberDismissedFocusBatch(ids: readonly string[]): void {
  if (typeof window === "undefined" || ids.length === 0) return;
  const key = focusBatchKey(ids);
  try {
    const existing = loadDismissedFocusBatches();
    if (existing.includes(key)) return;
    const next = [...existing, key];
    if (next.length > FOCUS_PILL_DISMISSED_MAX) {
      next.splice(0, next.length - FOCUS_PILL_DISMISSED_MAX);
    }
    window.localStorage.setItem(
      FOCUS_PILL_DISMISSED_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    /* ignore quota / disabled storage */
  }
}

// Task #336 — persist which category cards the user has collapsed on
// the Mapping Rules page so the per-category grouping (Task #282) can
// scale as a user accumulates categories. The collapsed state is keyed
// by category id (or the literal "__uncategorized__" sentinel used by
// the cardGroups grouping). State that points at a category that no
// longer exists is harmless — it just means re-creating that category
// later restores its previously-collapsed state.
const COLLAPSED_CATEGORIES_STORAGE_KEY =
  "h2budget:mappingRules:collapsedCategories";

function loadCollapsedCategories(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsedCategories(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COLLAPSED_CATEGORIES_STORAGE_KEY,
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    /* ignore quota / disabled storage */
  }
}

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

export default function MappingRulesPage() {
  const { data: rules, isLoading: rulesLoading } = useListMappingRules();
  const { data: allCategories, isLoading: catsLoading } = useListCategories();
  // (#474) Hide `excludeFromBudget` categories (today: just "Uncategorized")
  // from every mapping-rules surface — assign-to dropdowns, bulk change
  // dropdown, drag-and-drop strip, and the per-category cards. Mapping
  // rules cannot target a category that's outside the budget; the API
  // also rejects POST/PATCH attempts so this is purely a UX guard.
  const categories = useMemo(
    () => (allCategories ?? []).filter((c) => !c.excludeFromBudget),
    [allCategories],
  );

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
  // Task #242 — undo path for the Add-flow's chained bulk recategorize.
  // The existing /transactions/recategorize-by-pattern endpoint can't
  // model the swap (the prior category is null and that endpoint requires
  // a non-null toCategoryId), so we POST to the dedicated
  // /transactions/uncategorize-by-ids endpoint with the affectedIds the
  // bulk returned + the new category as the `fromCategoryId` guard. Rows
  // the user has since manually re-edited away from that category are
  // preserved by the guard.
  const uncategorizeByIds = useUncategorizeTransactionsByIds();

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
  // Task #231 — bulk-change category. Tracked separately from
  // bulkDeleting so the bar can disable both controls during either
  // operation without confusing onSettled bookkeeping.
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  // Task #336 — collapsed-per-category state, hydrated from
  // localStorage so the user's choices survive reloads. We persist on
  // every change via the effect below.
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    () => loadCollapsedCategories(),
  );
  useEffect(() => {
    saveCollapsedCategories(collapsedCategories);
  }, [collapsedCategories]);
  const toggleCategoryCollapsed = (key: string) =>
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
          // Task #243 — the preview is now fired without a
          // `toCategoryId` (so it can run before the user has picked
          // one), so the snapshot's `toCategoryId` is `null`. The
          // destination is whatever the user picked on the form,
          // which is exactly `data.categoryId` (we already gated the
          // submit on it being set in handleAddRule). Fall back to
          // the snapshot value as a defensive belt-and-suspenders.
          const bulkToCategoryId =
            data.categoryId ?? previewSnapshot.toCategoryId;
          if (!bulkToCategoryId) return;
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
                toCategoryId: bulkToCategoryId,
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
                // Task #242 — one-click Undo. Posts the affected
                // ids to /transactions/uncategorize-by-ids with
                // the new category as the `fromCategoryId` guard
                // so any rows the user has since manually re-edited
                // away from `toCategoryId` are preserved. The
                // freshly-added rule itself is left alone — the
                // user can delete it via the row-level Trash with
                // its own Undo if they don't want it pinned.
                //
                // NOTE: must use `bulkToCategoryId` (the actual
                // destination the bulk fired against), not
                // `previewSnapshot.toCategoryId`. After Task #243
                // dropped `toCategoryId` from the preview request,
                // the snapshot value is `null`, which would make
                // the server guard match every row and silently
                // wipe categories the user never asked us to touch.
                const undoTargetCategoryId = bulkToCategoryId;
                const affectedIds = res.affectedIds;
                const undoable = res.updated > 0 && affectedIds.length > 0;
                const { dismiss } = toast({
                  title: `Rule added · moved ${res.updated} past transaction${res.updated === 1 ? "" : "s"} into ${displayName}`,
                  // ~6s — long enough to react to an accidental
                  // bulk on a too-broad pattern without lingering.
                  duration: 6000,
                  ...(undoable
                    ? {
                        action: (
                          <ToastAction
                            altText="Undo rule-added bulk recategorize"
                            data-testid="action-undo-add-rule-bulk"
                            onClick={() => {
                              dismiss();
                              uncategorizeByIds.mutate(
                                {
                                  data: {
                                    ids: affectedIds,
                                    fromCategoryId: undoTargetCategoryId,
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
                                    toast({
                                      title:
                                        undoRes.updated === 0
                                          ? "Nothing to undo"
                                          : `Restored ${undoRes.updated} transaction${undoRes.updated === 1 ? "" : "s"} to uncategorized`,
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
                      }
                    : {}),
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

  // Task #220 / Task #243 — debounced preview of older *uncategorized*
  // transactions an unsaved Add-form rule would match. Fires as soon
  // as the user has a non-empty pattern, *before* they've picked a
  // destination category, so they can see "this would match N rows"
  // and refine the pattern (e.g. tighten "AMZN" to "AMZN MARKETPLACE")
  // before committing. The candidate count + samples only depend on
  // pattern + matchType (the bulk recategorize always scopes to
  // uncategorized rows), so picking a category afterwards just
  // upgrades the banner copy — it does not refetch.
  //
  // We debounce to avoid a request on every keystroke and we always
  // verify the response shape still matches the latest inputs before
  // committing it to state — otherwise an in-flight response could
  // overwrite a fresh one if the user is still editing.
  useEffect(() => {
    const trimmed = pattern.trim();
    if (!trimmed) {
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
            // Deliberately omit `toCategoryId` so the request shape
            // stays stable across category picks — the server returns
            // the same count + samples whether or not it's supplied.
            // The `categoryId` state controls which banner copy renders
            // at paint time, not which preview we fetched.
          },
        },
        {
          onSuccess: (res) => {
            // Drop late responses if the user has since edited the
            // pattern/matchType so a stale preview can never get
            // pinned to the UI. We don't gate on `categoryId` here:
            // the response is independent of it.
            if (res.pattern !== trimmed || res.matchType !== matchType) {
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
    // categoryId is intentionally NOT a dep — picking/changing the
    // category shouldn't refetch a preview that doesn't depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, matchType]);

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
    // The preview no longer carries `toCategoryId` (Task #243 — it's
    // fired before the user has picked one and reused after), so the
    // snapshot only needs to line up with the pattern + matchType the
    // user is about to save. The destination is whatever `categoryId`
    // they ended up picking; we pass it explicitly to the chained
    // bulk recategorize below.
    const previewSnapshot =
      addPreview &&
      addPreview.pattern === trimmedPattern &&
      addPreview.matchType === matchType &&
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

  // Task #231 — bulk re-assign category for the selected rules. Mirrors
  // the bulk-delete pattern: one combined optimistic update, fan out
  // PATCH calls in parallel, single toast with a single Undo that
  // restores each rule's prior categoryId in one go. Rules already
  // pointed at the chosen category are skipped (no-op) so the toast
  // count and the Undo set stay accurate.
  const handleBulkChangeCategory = async (newCategoryId: string) => {
    if (!newCategoryId) return;
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const allRules = rules ?? [];
    const idSet = new Set(ids);
    const targets = allRules.filter(
      (r) => idSet.has(r.id) && r.categoryId !== newCategoryId,
    );
    if (targets.length === 0) {
      clearSelection();
      return;
    }
    const targetCatName =
      catById.get(newCategoryId)?.name ?? "the new category";

    setBulkUpdating(true);
    await queryClient.cancelQueries({ queryKey: rulesQueryKey });
    const previous =
      queryClient.getQueryData<MappingRule[]>(rulesQueryKey) ?? [];
    queryClient.setQueryData<MappingRule[]>(
      rulesQueryKey,
      previous.map((r) =>
        idSet.has(r.id) ? { ...r, categoryId: newCategoryId } : r,
      ),
    );
    clearSelection();

    try {
      await Promise.all(
        targets.map((r) =>
          updateMappingRule(r.id, {
            pattern: r.pattern,
            matchType: r.matchType,
            categoryId: newCategoryId,
            priority: r.priority,
          }),
        ),
      );
      const count = targets.length;
      const { dismiss } = toast({
        title: `Updated ${count} rule${count === 1 ? "" : "s"} → ${targetCatName}`,
        // Match the bulk-delete toast duration (~6s) so the Undo affordance
        // stays visible long enough to recover from an accidental change.
        duration: 6000,
        action: (
          <ToastAction
            altText="Undo bulk change category"
            data-testid="action-undo-bulk-change-category"
            onClick={() => {
              dismiss();
              void handleBulkUndoCategoryChange(targets);
            }}
          >
            Undo
          </ToastAction>
        ),
      });
    } catch (e) {
      // Roll back the optimistic update if any PATCH failed — server
      // state is now ambiguous (some may have succeeded), so we surface
      // an error and let the invalidation reconcile.
      rollback(previous);
      toast({
        title: "Couldn't update rules",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setBulkUpdating(false);
      invalidateRules();
    }
  };

  // Restore each changed rule's prior categoryId in one go. Each PATCH
  // resends the rule's pattern / matchType / priority unchanged so only
  // categoryId flips back. The cache invalidation below picks up the
  // server's authoritative response.
  const handleBulkUndoCategoryChange = async (changed: MappingRule[]) => {
    if (changed.length === 0) return;
    try {
      await Promise.all(
        changed.map((r) =>
          updateMappingRule(r.id, {
            pattern: r.pattern,
            matchType: r.matchType,
            categoryId: r.categoryId,
            priority: r.priority,
          }),
        ),
      );
      toast({
        title: `Restored ${changed.length} rule${changed.length === 1 ? "" : "s"}`,
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

  // Task #282 — reorder within a category card without disturbing the
  // global ordering of any other card's rules. We capture the global
  // slot indices currently occupied by same-card rules, arrayMove the
  // same-card *id list* (not the global list), then write the new
  // arrangement back into those captured slots. Rules from other cards
  // keep both their global position AND their relative priority — only
  // the two same-card rules swap (or, for drag, shift) priority slots.
  const reorderWithinCard = (
    activeId: string,
    overId: string,
  ): string[] | null => {
    const activeRule = sorted.find((r) => r.id === activeId);
    const overRule = sorted.find((r) => r.id === overId);
    if (!activeRule || !overRule) return null;
    const activeCat = activeRule.categoryId ?? null;
    const overCat = overRule.categoryId ?? null;
    if (activeCat !== overCat) return null;
    const sameCardIds: string[] = [];
    const slots: number[] = [];
    sorted.forEach((r, i) => {
      if ((r.categoryId ?? null) === activeCat) {
        sameCardIds.push(r.id);
        slots.push(i);
      }
    });
    const fromIdx = sameCardIds.indexOf(activeId);
    const toIdx = sameCardIds.indexOf(overId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return null;
    const reorderedIds = arrayMove(sameCardIds, fromIdx, toIdx);
    const next = sorted.map((r) => r.id);
    slots.forEach((slotIdx, k) => {
      next[slotIdx] = reorderedIds[k];
    });
    return next;
  };

  const moveRule = (id: string, direction: -1 | 1) => {
    const rule = sorted.find((r) => r.id === id);
    if (!rule) return;
    const ruleCatKey = rule.categoryId ?? null;
    const sameCard = sorted.filter(
      (r) => (r.categoryId ?? null) === ruleCatKey,
    );
    const cardIdx = sameCard.findIndex((r) => r.id === id);
    const targetCardIdx = cardIdx + direction;
    if (targetCardIdx < 0 || targetCardIdx >= sameCard.length) return;
    const targetId = sameCard[targetCardIdx].id;
    const nextOrder = reorderWithinCard(id, targetId);
    if (!nextOrder) return;
    persistOrder(nextOrder);
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
    // Snapshot the rule's pre-drop shape so the toast's Undo action can
    // PATCH it back. We capture the full input shape (not just
    // categoryId) because the PATCH endpoint requires the complete
    // MappingRuleInput body — same reason the forward path echoes them.
    const previousCategoryId = rule.categoryId;
    const previousPattern = rule.pattern;
    const previousMatchType = rule.matchType;
    const previousPriority = rule.priority;
    const previousCat = previousCategoryId
      ? catById.get(previousCategoryId)
      : null;
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
            action: (
              <ToastAction
                altText="Undo rule reassignment"
                data-testid="action-undo-rule-reassign"
                onClick={() => {
                  updateRule.mutate(
                    {
                      id: ruleId,
                      data: {
                        pattern: previousPattern,
                        matchType: previousMatchType,
                        categoryId: previousCategoryId,
                        priority: previousPriority,
                      },
                    },
                    {
                      onSuccess: () => {
                        invalidateRules();
                        toast({
                          title: "Reassignment undone",
                          description: previousCat
                            ? `“${previousPattern}” → ${previousCat.name}`
                            : `“${previousPattern}” moved back to its previous category.`,
                        });
                      },
                      onError: (e) => {
                        toast({
                          title: "Couldn't undo reassignment",
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
    // Task #282 — drag-to-reorder is now scoped to within a single
    // category card. Cross-card drops are ignored (cross-category
    // moves go through the dedicated category drop strip). Same-card
    // drops go through reorderWithinCard, which only re-arranges
    // same-card rules in their existing global slots — every other
    // card's rules keep both their global position and their relative
    // priority, so the auto-categorization engine's "higher priority
    // wins" outcome for unrelated rules is unchanged.
    const nextOrder = reorderWithinCard(String(active.id), String(over.id));
    if (!nextOrder) return;
    persistOrder(nextOrder);
  };

  const handleDragCancel = () => setActiveDragId(null);

  const activeDragRule = useMemo(
    () =>
      activeDragId ? (rules ?? []).find((r) => r.id === activeDragId) ?? null : null,
    [activeDragId, rules],
  );

  // ?focus=<ruleId>[,<ruleId>...] deep-link support — clicked from the
  // "rule: 'PATTERN'" chip on the Transactions / Amex pages, or from the
  // "View" action on the post-sync / post-import toast (which can pass
  // multiple ids when several rules contributed to a single batch). We
  // scroll the FIRST matched row into view and briefly flash a ring
  // around every matched row so the user spots all of them in a long
  // list, then drop the highlight after a few seconds. The focus also
  // forces the search to be cleared so the rows can never be filtered out
  // before we can scroll to them.
  //
  // Declared up here (before `filtered`) because the Task #236 "Show
  // only these" toggle below feeds back into the rules-list filtering
  // pipeline.
  const search = useSearch();
  const [, navigate] = useLocation();
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

  // Task #236 — when the post-sync / post-import toast deep-links here
  // with multiple ids, surface a "N rules matched..." pill so the user
  // can collapse the list to just those rows instead of scanning a
  // long list for highlighted rings. The pill is only worth showing
  // when 2+ ids actually exist in the current rules — a single id is
  // already trivially in view because we scroll it into the viewport.
  const matchedFocusIds = useMemo(() => {
    if (focusIds.length === 0 || !rules) return [] as string[];
    const live = new Set(rules.map((r) => r.id));
    return focusIds.filter((id) => live.has(id));
  }, [focusIds, rules]);
  // Task #244 — initial dismissal state is sourced from localStorage
  // so the pill stays dismissed for batches the user has already
  // audited (across reloads and repeat clicks of the toast's "View"
  // link). A *different* combination of focus ids hashes to a
  // different key and so still shows the pill.
  const [pillDismissed, setPillDismissed] = useState(() =>
    isFocusBatchDismissed(focusIds),
  );
  const [showOnlyFocused, setShowOnlyFocused] = useState(false);
  // Reset the dismissed/toggle flags whenever the focus param changes
  // (e.g. the user clicks "View" on a fresh sync toast). For dismissal
  // we re-consult persisted storage so a previously-audited batch
  // stays dismissed even when the user navigates back to it; new
  // batches get a fresh pill.
  useEffect(() => {
    setPillDismissed(isFocusBatchDismissed(focusIds));
    setShowOnlyFocused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  // Spec (Task #236): pill shows when the URL carries 2+ focus ids and
  // *at least one* of them still exists in the current rules. The
  // count rendered in the pill is the matched-live count (which can
  // legitimately be 1 if the others were since deleted).
  const showFocusPill =
    focusIds.length >= 2 && matchedFocusIds.length >= 1 && !pillDismissed;
  // The "Show only these" toggle hides everything except the matched
  // focused rules. We collapse it back when the pill is dismissed (or
  // when no live ids remain) so the user can never end up looking at
  // an empty list with no obvious way out.
  const focusFilterActive =
    showOnlyFocused && showFocusPill && matchedFocusIds.length > 0;
  const dismissFocusPill = () => {
    // Task #244 — remember this batch so re-opening the page or
    // re-clicking the toast's "View" link with the same focus ids
    // doesn't re-show the pill.
    rememberDismissedFocusBatch(focusIds);
    setPillDismissed(true);
    setShowOnlyFocused(false);
    // Strip just the focus param while preserving anything else the
    // caller stuffed into the URL (none today, but cheap insurance).
    const params = new URLSearchParams(search);
    params.delete("focus");
    const qs = params.toString();
    navigate(qs ? `/mapping-rules?${qs}` : `/mapping-rules`, {
      replace: true,
    });
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let base = sorted;
    if (q) {
      base = base.filter((r) => {
        const catName = catById.get(r.categoryId ?? "")?.name ?? "";
        return (
          r.pattern.toLowerCase().includes(q) ||
          catName.toLowerCase().includes(q) ||
          r.matchType.toLowerCase().includes(q)
        );
      });
    }
    // Task #236 — when the "Show only these" pill toggle is active,
    // collapse to just the rules deep-linked from the most recent
    // sync/import toast. Done last so it composes correctly with any
    // other filter (today only the search box).
    if (focusFilterActive) {
      const focusOnly = new Set(matchedFocusIds);
      base = base.filter((r) => focusOnly.has(r.id));
    }
    return base;
  }, [sorted, catById, searchQuery, focusFilterActive, matchedFocusIds]);

  // Task #282 — group filtered rules into per-category cards. Cards
  // with zero matching rules are hidden (so search/focus filters
  // collapse the list naturally). Categories are sorted alphabetically
  // by name; an "Uncategorized" card (rules with categoryId === null)
  // is always rendered last so it doesn't push real categories down.
  // Within each card, rules keep the global priority-descending order
  // so the existing "higher wins" semantics are still visually obvious.
  const cardGroups = useMemo(() => {
    const map = new Map<string, MappingRule[]>();
    for (const r of filtered) {
      const key = r.categoryId ?? "__uncategorized__";
      const arr = map.get(key);
      if (arr) arr.push(r);
      else map.set(key, [r]);
    }
    const entries = Array.from(map.entries()).map(([catKey, groupRules]) => {
      const cat =
        catKey === "__uncategorized__" ? null : catById.get(catKey) ?? null;
      return {
        key: catKey,
        category: cat,
        name: cat?.name ?? "Uncategorized",
        rules: groupRules,
      };
    });
    entries.sort((a, b) => {
      if (a.key === "__uncategorized__") return 1;
      if (b.key === "__uncategorized__") return -1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }, [filtered, catById]);

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

  // Task #336 — the rules the user can actually see right now: rules
  // in cards that are not collapsed, with the same "filters force
  // expand" / "focus deep-link force expand" rules used in the render
  // below. Bulk select-all is scoped to this set so a collapsed
  // category card can't have its rows silently swept into a bulk
  // delete or bulk category change.
  const visibleRules = useMemo(() => {
    const filterActive = !!searchQuery || focusFilterActive;
    const out: MappingRule[] = [];
    for (const group of cardGroups) {
      const groupHasFocusTarget =
        !!focusId && group.rules.some((r) => r.id === focusId);
      const isCollapsed =
        collapsedCategories.has(group.key) &&
        !filterActive &&
        !groupHasFocusTarget;
      if (!isCollapsed) out.push(...group.rules);
    }
    return out;
  }, [
    cardGroups,
    collapsedCategories,
    searchQuery,
    focusFilterActive,
    focusId,
  ]);

  // Header checkbox is scoped to the *currently visible* (expanded +
  // filtered) rows. It reads as fully checked only when every visible
  // row is selected, indeterminate when some are.
  const visibleSelectionState: boolean | "indeterminate" = useMemo(() => {
    if (visibleRules.length === 0) return false;
    let selectedCount = 0;
    for (const r of visibleRules) if (selected.has(r.id)) selectedCount++;
    if (selectedCount === 0) return false;
    if (selectedCount === visibleRules.length) return true;
    return "indeterminate";
  }, [visibleRules, selected]);

  const toggleAllVisible = (on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of visibleRules) {
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

  // The transient highlight ring + scroll-into-view side effects live
  // here (after `filtered`) because they only need to fire once the
  // rules query has resolved. The state lookup keys (`focusIds`,
  // `rules`, `searchQuery`) are all in scope from above.
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
    return null;
  }

  // Drag-and-drop reorders the full sorted list, so we must disable it
  // whenever a filter is hiding rules — otherwise dropping would
  // misplace items relative to the hidden ones. The "Show only these"
  // focus filter is treated the same as the search filter for this.
  const dragDisabled =
    !!searchQuery || focusFilterActive || reorderRules.isPending;
  const sortableIds = sorted.map((r) => r.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[1.75rem] font-semibold tracking-tight text-foreground">
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
                <SelectTrigger aria-label="If description match type">
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
                aria-label="Text pattern"
              />
            </div>
            <div className="flex-1 w-full space-y-1">
              <label className="text-xs font-medium">Assign to Category</label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger aria-label="Assign to category">
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
            * Task #220 / Task #243 — preview banner for the unsaved
            * Add-form rule. Two variants:
            *   - Pattern only (no category yet): neutral count so the
            *     user can refine the pattern before picking a
            *     destination.
            *   - Pattern + category: the existing "N will move into
            *     <category>" copy with a "Show matches" link that
            *     opens the shared dialog.
            * Both variants reuse the same response — picking a
            * category does not trigger a refetch.
            */}
          {addPreview &&
            addPreview.pattern === pattern.trim() &&
            addPreview.matchType === matchType &&
            addPreview.candidateCount > 0 && (
              <div
                className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
                data-testid="rule-add-preview"
              >
                {categoryId ? (
                  <span>
                    <span
                      className="font-medium"
                      data-testid="rule-add-preview-count"
                    >
                      {addPreview.candidateCount}
                    </span>{" "}
                    past transaction
                    {addPreview.candidateCount === 1 ? "" : "s"} will move
                    into{" "}
                    <span className="font-medium">
                      {catById.get(categoryId)?.name ?? "the new category"}
                    </span>{" "}
                    when you add this rule.
                  </span>
                ) : (
                  <span>
                    This would match{" "}
                    <span
                      className="font-medium"
                      data-testid="rule-add-preview-count"
                    >
                      {addPreview.candidateCount}
                    </span>{" "}
                    uncategorized past transaction
                    {addPreview.candidateCount === 1 ? "" : "s"}. Pick a
                    category to assign them.
                  </span>
                )}
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2 hover:text-foreground"
                  data-testid="link-show-rule-matches-add"
                  onClick={() =>
                    setMatchesDialog({
                      pattern: addPreview.pattern,
                      candidateCount: addPreview.candidateCount,
                      sampleTransactions: addPreview.sampleTransactions,
                      // Omit toCategoryName when no category is picked
                      // yet so the dialog renders the no-destination
                      // copy and hides its Apply button (Task #246).
                      ...(categoryId
                        ? {
                            toCategoryName:
                              catById.get(categoryId)?.name ??
                              "the new category",
                          }
                        : {}),
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
              aria-label="Test a description"
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

      {showFocusPill && (
        <div
          className="flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
          data-testid="focus-pill"
        >
          <span className="flex-1">
            <span className="font-medium" data-testid="focus-pill-count">
              {matchedFocusIds.length}
            </span>{" "}
            rule{matchedFocusIds.length === 1 ? "" : "s"} matched your recent
            sync/import
          </span>
          <button
            type="button"
            className="text-xs font-medium underline underline-offset-2 hover:text-foreground"
            onClick={() => setShowOnlyFocused((v) => !v)}
            data-testid="focus-pill-toggle"
          >
            {focusFilterActive ? "Show all rules" : "Show only these"}
          </button>
          <button
            type="button"
            aria-label="Dismiss matched-rules pill"
            className="text-amber-700 dark:text-amber-300 hover:text-foreground"
            onClick={dismissFocusPill}
            data-testid="focus-pill-dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search rules by pattern, category, or match type..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-rules"
          aria-label="Search rules by pattern, category, or match type"
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
        // Task #282 — the previously single "Rules in priority order"
        // card is now split into a controls card (summary + bulk bar +
        // category drop strip) followed by one Card per category that
        // has at least one rule. A single DndContext + SortableContext
        // wraps everything so drag-to-reorder (within a card) and
        // drag-to-reassign (onto the strip's category chip) keep
        // working unchanged.
        <DndContext
          sensors={sensors}
          collisionDetection={ruleCollisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span>Rules grouped by category</span>
                <div className="flex items-center gap-3">
                  {cardGroups.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs font-normal"
                      onClick={() => {
                        // If every visible group is collapsed, treat
                        // the button as Expand all; otherwise Collapse
                        // all visible groups. We never touch state for
                        // groups that aren't currently in cardGroups so
                        // hidden-by-filter cards keep their setting.
                        const allCollapsed = cardGroups.every((g) =>
                          collapsedCategories.has(g.key),
                        );
                        setCollapsedCategories((prev) => {
                          const next = new Set(prev);
                          if (allCollapsed) {
                            for (const g of cardGroups) next.delete(g.key);
                          } else {
                            for (const g of cardGroups) next.add(g.key);
                          }
                          return next;
                        });
                      }}
                      data-testid="rule-collapse-all"
                    >
                      {cardGroups.every((g) =>
                        collapsedCategories.has(g.key),
                      )
                        ? "Expand all"
                        : "Collapse all"}
                    </Button>
                  )}
                  <span className="text-xs font-normal text-muted-foreground">
                    {sorted.length} total{" "}
                    {searchQuery || focusFilterActive
                      ? `· ${filtered.length} shown`
                      : ""}
                  </span>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div
                className="flex items-center gap-3 px-4 py-2 border-b bg-muted/30"
                data-testid="rule-bulk-bar"
              >
                <Checkbox
                  checked={visibleSelectionState}
                  onCheckedChange={(v) => toggleAllVisible(!!v)}
                  aria-label="Select all visible rules"
                  disabled={visibleRules.length === 0}
                  data-testid="rule-select-all"
                />
                <span className="text-xs text-muted-foreground">
                  {selected.size > 0
                    ? `${selected.size} selected`
                    : searchQuery || visibleRules.length !== sorted.length
                      ? `Select all ${visibleRules.length} shown`
                      : "Select all"}
                </span>
                {selected.size > 0 && (
                  <>
                    <div className="ml-auto">
                      <Select
                        key={`bulk-category-${selected.size}`}
                        value=""
                        onValueChange={(v) =>
                          void handleBulkChangeCategory(v)
                        }
                        disabled={bulkDeleting || bulkUpdating}
                      >
                        <SelectTrigger
                          className="h-7 w-[180px] text-xs"
                          data-testid="rule-bulk-change-category"
                          aria-label="Change category for selected rules"
                        >
                          <SelectValue placeholder="Change category…" />
                        </SelectTrigger>
                        <SelectContent>
                          {categories?.map((cat) => (
                            <SelectItem
                              key={cat.id}
                              value={cat.id}
                              data-testid={`rule-bulk-change-category-option-${cat.id}`}
                            >
                              {cat.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7"
                      onClick={handleBulkDelete}
                      disabled={bulkDeleting || bulkUpdating}
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
                      disabled={bulkDeleting || bulkUpdating}
                      data-testid="rule-bulk-clear"
                    >
                      Clear
                    </Button>
                  </>
                )}
              </div>
              {(categories?.length ?? 0) > 0 && (
                <div
                  className={`px-4 py-3 transition-colors ${
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
            </CardContent>
          </Card>

          <SortableContext
            items={sortableIds}
            strategy={verticalListSortingStrategy}
          >
            {filtered.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground text-sm">
                  No rules match your search.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4" data-testid="rule-category-cards">
                {cardGroups.map((group) => {
                  // Search and the focus-pill "Show only these" toggle
                  // already prune the rule list; if a card survives that
                  // filter the user wants to see its rules, so we ignore
                  // the persisted collapsed state while a filter is
                  // active. We also force-expand the card containing the
                  // current ?focus deep-link target so the auto-scroll
                  // lands on a visible row.
                  const groupHasFocusTarget =
                    !!focusId && group.rules.some((r) => r.id === focusId);
                  const filterActive =
                    !!searchQuery || focusFilterActive;
                  const isCollapsed =
                    collapsedCategories.has(group.key) &&
                    !filterActive &&
                    !groupHasFocusTarget;
                  return (
                  <Card
                    key={group.key}
                    data-testid={`rule-category-card-${group.key}`}
                    data-collapsed={isCollapsed ? "true" : undefined}
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center justify-between text-base">
                        <button
                          type="button"
                          onClick={() => toggleCategoryCollapsed(group.key)}
                          className="flex items-center gap-2 text-left hover:text-foreground/80 -ml-1 px-1 py-0.5 rounded"
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.name}`}
                          data-testid={`rule-category-card-toggle-${group.key}`}
                        >
                          {isCollapsed ? (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          )}
                          <span
                            data-testid={`rule-category-card-name-${group.key}`}
                          >
                            {group.name}
                          </span>
                        </button>
                        <Badge
                          variant="outline"
                          className="text-[10px] tabular-nums"
                          data-testid={`rule-category-card-count-${group.key}`}
                        >
                          {group.rules.length} rule
                          {group.rules.length === 1 ? "" : "s"}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    {!isCollapsed && (
                    <CardContent className="p-0">
                      {/* Fixed-height scroll box per spec — keeps very
                        * large categories from dominating the page while
                        * still allowing the user to scan + edit any rule. */}
                      <div
                        className="max-h-80 overflow-y-auto divide-y divide-border"
                        data-testid={`rule-category-card-list-${group.key}`}
                      >
                        {group.rules.map((rule, idxInGroup) => {
                          const isFirst = idxInGroup === 0;
                          const isLast = idxInGroup === group.rules.length - 1;
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
                                  onChange={(e) =>
                                    setEditPattern(e.target.value)
                                  }
                                  className="h-8 text-sm font-mono"
                                  autoFocus
                                  aria-label="Rule pattern"
                                />
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Select
                                    value={editMatchType}
                                    onValueChange={setEditMatchType}
                                  >
                                    <SelectTrigger
                                      className="h-8 text-xs flex-1 min-w-[120px]"
                                      aria-label="Rule match type"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="contains">
                                        Contains
                                      </SelectItem>
                                      <SelectItem value="exact">
                                        Exact
                                      </SelectItem>
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
                                      aria-label="Rule category"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-[280px]">
                                      {categories?.map((cat) => (
                                        <SelectItem
                                          key={cat.id}
                                          value={cat.id}
                                        >
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
                                      aria-label="Rule priority"
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
                                    aria-label="Save rule"
                                  >
                                    <Check className="w-4 h-4 text-emerald-600" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={cancelEdit}
                                    aria-label="Cancel editing rule"
                                  >
                                    <X className="w-4 h-4" />
                                  </Button>
                                </div>
                                {editPreview &&
                                  editPreview.toCategoryId ===
                                    editCategoryId &&
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
                                          {catById.get(
                                            editPreview.toCategoryId,
                                          )?.name ?? "the new category"}
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
                        })}
                      </div>
                    </CardContent>
                    )}
                  </Card>
                  );
                })}
              </div>
            )}
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
