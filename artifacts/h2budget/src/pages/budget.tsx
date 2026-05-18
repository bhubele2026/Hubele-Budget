import { useState, useEffect, useMemo, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import {
  useGetBudgetMonth,
  useUpsertBudgetLine,
  useListCategories,
  useCreateCategory,
  useDeleteCategory,
  useUpdateCategory,
  useSeedDefaultBudget,
  usePinBudgetMonth,
  usePinBudgetLine,
  useListTransactions,
  useListMappingRules,
  useUpdateTransaction,
  getBudgetMonth,
  getGetBudgetMonthQueryKey,
  getListCategoriesQueryKey,
  getListTransactionsQueryKey,
  type MappingRule,
  type Transaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type SourceBreakdownEntry = {
  source: "Bank" | "Amex" | "Other";
  count: number;
  amount: string;
};

/**
 * Task #168 — picks the destination page for a category drill-down based
 * on which source contributed the most transactions to the line's actuals.
 * Amex-dominated lines deep-link into the Amex page (which only shows
 * Amex rows); everything else (including ties and lines with no actuals
 * yet) goes to the Transactions / Chase page so behavior matches the
 * pre-Amex-aware experience.
 *
 * Exported so the budget tests (and any future call site) can exercise
 * the routing decision without rendering the page.
 */
export function pickCategoryDrillDownHref(
  categoryName: string,
  monthStart: string,
  sourceBreakdown: SourceBreakdownEntry[] | null | undefined,
): string {
  const breakdown = sourceBreakdown ?? [];
  const bankCount = breakdown.find((b) => b.source === "Bank")?.count ?? 0;
  const amexCount = breakdown.find((b) => b.source === "Amex")?.count ?? 0;
  const base = amexCount > bankCount ? "/amex" : "/transactions";
  return `${base}?category=${encodeURIComponent(categoryName)}&month=${monthStart}`;
}
type LinkedBillEntry = {
  id: string;
  name: string;
  amount: string;
  frequency: string;
  eventCount: number;
};
type PlannedSource = {
  kind: "bills" | "pinned" | "derived" | "manual";
  bills: LinkedBillEntry[];
};
type BudgetLineWithActual = {
  id?: string | null;
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  actualAmount: string;
  note?: string | null;
  groupName: string;
  sourceKind: string;
  sortOrder: number;
  kind: string;
  pinned: boolean;
  sourceBreakdown?: SourceBreakdownEntry[] | null;
  plannedSource?: PlannedSource | null;
};
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Pencil,
  Pin,
  PinOff,
  Tag,
  CreditCard,
  Landmark,
  MoreHorizontal,
  Check,
  Info,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { ToastAction } from "@/components/ui/toast";

type SourceKind = "manual" | "auto_bills" | "auto_debts";

const SOURCE_LABEL: Record<SourceKind, string> = {
  manual: "Editable",
  auto_bills: "Auto-pulled from Income/Bills",
  auto_debts: "Auto-pulled from Debts",
};

function SourceBadge({ kind }: { kind: SourceKind }) {
  const variant =
    kind === "manual"
      ? "secondary"
      : kind === "auto_bills"
        ? "outline"
        : "outline";
  return (
    <Badge
      variant={variant}
      className={cn(
        "text-[10px] font-normal uppercase tracking-wide",
        kind === "auto_bills" &&
          "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300",
        kind === "auto_debts" &&
          "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300",
      )}
      data-testid={`badge-source-${kind}`}
    >
      {SOURCE_LABEL[kind]}
    </Badge>
  );
}

function SummaryTile({
  label,
  budget,
  actual,
  isPercent,
  testId,
}: {
  label: string;
  budget: string;
  actual: string;
  isPercent?: boolean;
  testId?: string;
}) {
  const fmt = (s: string) =>
    isPercent ? `${parseFloat(s).toFixed(1)}%` : formatCurrency(s);
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
          <div>
            <div className="text-[10px] uppercase text-muted-foreground">
              Budget
            </div>
            <div className="font-mono font-semibold">{fmt(budget)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-muted-foreground">
              Actual
            </div>
            <div className="font-mono font-semibold">{fmt(actual)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const MIN_MONTH = "2026-04-01";

// (#690) Dedicated group name for the "My budget" bucket — personal,
// non-bill-backed envelopes (e.g. "Birthday gifts", "Kid's soccer")
// the user wants to budget for without standing them up as recurring
// bills. We render this group as a separate card below the standard
// groups, with a distinct header and helper copy, and always surface
// it even when empty so users have an obvious place to add lines.
export const MY_BUDGET_GROUP = "My budget";

function thisMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function BudgetPage() {
  const search = useSearch();
  const [, navigateRoot] = useLocation();
  const [currentMonth, setCurrentMonth] = useState(() => {
    const params = new URLSearchParams(search);
    const m = params.get("month");
    if (m && /^\d{4}-\d{2}-01$/.test(m)) {
      return m < MIN_MONTH ? MIN_MONTH : m;
    }
    const tm = thisMonthStart();
    return tm < MIN_MONTH ? MIN_MONTH : tm;
  });

  useEffect(() => {
    const params = new URLSearchParams(search);
    const m = params.get("month");
    if (m && /^\d{4}-\d{2}-01$/.test(m) && m !== currentMonth) {
      setCurrentMonth(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // The "previous month stays on screen during refetch" behavior comes
  // from the global `placeholderData: keepPreviousData` default set on
  // the QueryClient in App.tsx — no per-call override needed here.
  const { data: budgetData, isLoading: isLoadingBudget } =
    useGetBudgetMonth(currentMonth);
  const { data: categories, isLoading: isLoadingCategories } =
    useListCategories();

  // Prefetch the adjacent months in the background so prev/next clicks
  // hit the cache and feel instant. Honors the MIN_MONTH floor used by
  // changeMonth() and skips when the response is already cached fresh.
  // Wait for the current month's first load to land before warming
  // neighbors, so any server-side healing/seeding on the active month
  // settles before its results would influence neighboring caches.
  const queryClientForPrefetch = useQueryClient();
  useEffect(() => {
    if (!budgetData) return;
    const [yStr, mStr] = currentMonth.split("-");
    const year = Number(yStr);
    const month = Number(mStr);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return;
    const offsets = [-1, 1];
    for (const offset of offsets) {
      const d = new Date(Date.UTC(year, month - 1 + offset, 1));
      const next = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
      if (offset < 0 && next < MIN_MONTH) continue;
      queryClientForPrefetch.prefetchQuery({
        queryKey: getGetBudgetMonthQueryKey(next),
        queryFn: ({ signal }) => getBudgetMonth(next, { signal }),
      });
    }
  }, [currentMonth, queryClientForPrefetch, !!budgetData]);

  const upsertLine = useUpsertBudgetLine();
  const createCat = useCreateCategory();
  const deleteCat = useDeleteCategory();
  const updateCat = useUpdateCategory();
  const seedDefaults = useSeedDefaultBudget();
  const pinMonth = usePinBudgetMonth();
  const pinLine = usePinBudgetLine();
  const updateTx = useUpdateTransaction();
  // #90 — pull all transactions to surface uncategorized rows for inline
  // categorization from each Budget row.
  const { data: allTxns } = useListTransactions({ limit: 5000 });
  // #176 — used both for the actuals-breakdown popover (per-row contributing
  // transactions) and for ranking which uncategorized transactions to suggest
  // for a given budget row (any rule whose pattern matches the description
  // and points at this row's categoryId surfaces it as a hint).
  const { data: mappingRules } = useListMappingRules();

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) return;
    if (isLoadingCategories) return;
    // (#594) The GET /budget/categories endpoint always lazy-inserts the
    // system-managed "Uncategorized" row (excludeFromBudget=true) before
    // returning, so a brand-new user's first response is `[Uncategorized]`
    // — length 1 but with zero real budget categories. Counting only the
    // real (non-excluded) rows ensures seedDefaults still fires for new
    // users and the e2e suite gets the full ~22-category seed.
    const realCount =
      categories?.filter((c) => !c.excludeFromBudget).length ?? 0;
    if (realCount > 0) return;
    seededRef.current = true;
    seedDefaults.mutate(undefined, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        invalidate();
        if (!res.alreadySeeded) {
          toast({ title: "Loaded default budget" });
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingCategories, categories?.length]);

  const toggleCollapse = (groupName: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const changeMonth = (offset: number) => {
    // Anchor the date to the 1st at noon UTC so DST/offset edge cases never
    // bump us into the previous month. Using `new Date("YYYY-MM-01")` then
    // `setMonth` parses as UTC midnight and can drift to the prior day in
    // negative-offset timezones, which silently breaks "next month".
    const [yStr, mStr] = currentMonth.split("-");
    const y = Number(yStr);
    const m0 = Number(mStr) - 1; // 0-indexed
    const targetY = y + Math.floor((m0 + offset) / 12);
    const targetM = ((m0 + offset) % 12 + 12) % 12;
    const raw = `${targetY}-${String(targetM + 1).padStart(2, "0")}-01`;
    const next = raw < MIN_MONTH ? MIN_MONTH : raw;
    if (next === currentMonth) return;
    setCurrentMonth(next);
    // Keep the ?month= URL param in sync so the URL→state useEffect above
    // doesn't snap currentMonth back to the previous URL value on the next
    // re-render. Pass the full pathname (not just `?…`) — wouter's navigate
    // treats a query-only string as a path, which would drop `/budget`.
    const params = new URLSearchParams(search);
    params.set("month", next);
    navigateRoot(`/budget?${params.toString()}`, { replace: true });
  };

  const atFloor = currentMonth <= MIN_MONTH;

  const invalidate = () => {
    // Invalidate every cached budget-month response, not just the
    // current month. With adjacent-month prefetch + a 30s default
    // staleTime, narrow per-month invalidation would leave neighbor
    // caches "fresh but outdated" after category/seed/line edits and
    // surface stale numbers when paging months.
    queryClient.invalidateQueries({
      predicate: (q) => {
        const k = q.queryKey?.[0];
        return typeof k === "string" && k.startsWith("/api/budget/months/");
      },
    });
  };

  const handleUpdatePlanned = (categoryId: string, amountStr: string) => {
    upsertLine.mutate(
      {
        data: {
          monthStart: currentMonth,
          categoryId,
          plannedAmount: amountStr || "0",
        },
      },
      { onSuccess: () => invalidate() },
    );
  };

  const handleAddCategory = (groupName: string) => {
    const name = newName.trim();
    if (!name) return;
    createCat.mutate(
      {
        data: {
          name,
          kind: groupName === "Income" ? "income" : "expense",
          groupName,
          sourceKind: "manual",
          sortOrder: 9999,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListCategoriesQueryKey(),
          });
          invalidate();
          setNewName("");
          setAddingFor(null);
          toast({ title: "Category added" });
        },
      },
    );
  };

  const monthPinned = budgetData?.monthPinned === true;

  const handleTogglePinMonth = () => {
    const next = !monthPinned;
    pinMonth.mutate(
      { monthStart: currentMonth, data: { pinned: next } },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: next
              ? "Month pinned"
              : "Month unpinned",
            description: next
              ? "Auto-pulled lines will hold their current planned amounts."
              : "Auto-pulled lines will track Bills and Debts again.",
          });
        },
      },
    );
  };

  const handleTogglePinLine = (categoryId: string, currentlyPinned: boolean) => {
    const next = !currentlyPinned;
    pinLine.mutate(
      { data: { monthStart: currentMonth, categoryId, pinned: next } },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: next ? "Line pinned" : "Line unpinned",
          });
        },
      },
    );
  };

  // Bounds of the currently viewed budget month, used to scope both the
  // uncategorized-this-month list and the per-row contributing-txn popover.
  const monthBounds = useMemo(() => {
    const start = currentMonth;
    const d = new Date(currentMonth + "T00:00:00");
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
    return { start, end };
  }, [currentMonth]);

  // #90 — uncategorized transactions in the currently viewed budget month,
  // skipping transfers (they're excluded from budget actuals server-side
  // anyway). Sorted newest-first so the most recent unassigned charges
  // surface first.
  const uncategorizedThisMonth = useMemo<Transaction[]>(() => {
    if (!allTxns) return [];
    return allTxns
      .filter(
        (t) =>
          !t.categoryId &&
          !t.isTransfer &&
          t.occurredOn >= monthBounds.start &&
          t.occurredOn < monthBounds.end,
      )
      .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
  }, [allTxns, monthBounds]);

  // Categorized transactions this month, indexed by categoryId. Powers the
  // actuals-breakdown popover on each row (Item 5) — same scope/exclusion
  // rules as the server-side actuals total in /budget/months (skip transfers).
  const txnsByCategoryThisMonth = useMemo<Map<string, Transaction[]>>(() => {
    const map = new Map<string, Transaction[]>();
    if (!allTxns) return map;
    for (const t of allTxns) {
      if (t.isTransfer) continue;
      if (!t.categoryId) continue;
      if (t.occurredOn < monthBounds.start || t.occurredOn >= monthBounds.end) continue;
      const arr = map.get(t.categoryId) ?? [];
      arr.push(t);
      map.set(t.categoryId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
    }
    return map;
  }, [allTxns, monthBounds]);

  // Mapping rules grouped by the categoryId they assign to. Used to decide
  // which uncategorized rows should be surfaced as suggestions on a given
  // budget row (Item 4 hint).
  const rulesByCategory = useMemo<Map<string, MappingRule[]>>(() => {
    const map = new Map<string, MappingRule[]>();
    for (const r of mappingRules ?? []) {
      if (!r.categoryId) continue;
      const arr = map.get(r.categoryId) ?? [];
      arr.push(r);
      map.set(r.categoryId, arr);
    }
    return map;
  }, [mappingRules]);

  const handleAssignTxn = async (txId: string, categoryId: string) => {
    try {
      await updateTx.mutateAsync({ id: txId, data: { categoryId } });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      invalidate();
      toast({ title: "Categorized" });
    } catch (e) {
      toast({
        title: "Couldn't categorize",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // Task #295 — re-tag a contributing transaction directly from the actuals
  // breakdown popover. Mirrors the simple "Categorized" + Undo flow used on
  // the Transactions page: the toast's Undo button PATCHes the row back to
  // its previous categoryId so a misclick is one tap to revert. Both the
  // popover total and the row's actual refresh because we invalidate both
  // the transactions list and the current budget month.
  const handleReassignTxn = async (
    txId: string,
    nextCategoryId: string,
    prevCategoryId: string | null,
  ) => {
    if (nextCategoryId === prevCategoryId) return;
    try {
      await updateTx.mutateAsync({ id: txId, data: { categoryId: nextCategoryId } });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      invalidate();
      const t = toast({
        title: "Categorized",
        action: (
          <ToastAction
            altText="Undo categorize"
            data-testid={`action-undo-reassign-${txId}`}
            onClick={async () => {
              t.dismiss();
              try {
                await updateTx.mutateAsync({
                  id: txId,
                  data: { categoryId: prevCategoryId },
                });
                queryClient.invalidateQueries({
                  queryKey: getListTransactionsQueryKey(),
                });
                invalidate();
                toast({ title: "Reverted category" });
              } catch (err) {
                toast({
                  title: "Couldn't undo",
                  description: (err as Error).message,
                  variant: "destructive",
                });
              }
            }}
          >
            Undo
          </ToastAction>
        ),
      });
    } catch (e) {
      toast({
        title: "Couldn't categorize",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // Task #692 — inline rename for any user-editable category. Trims
  // whitespace, no-ops on unchanged names, and surfaces the API's
  // 409 "name already in use" as a friendly toast so the user can
  // pick a different label without losing their input (the row stays
  // in edit mode if onError keeps it open at the call site).
  const handleRenameCategory = async (
    id: string,
    nextName: string,
    prevName: string,
  ): Promise<boolean> => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === prevName) return false;
    try {
      await updateCat.mutateAsync({ id, data: { name: trimmed } });
      queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
      invalidate();
      toast({ title: "Renamed" });
      return true;
    } catch (e) {
      toast({
        title: "Couldn't rename",
        description: (e as Error).message,
        variant: "destructive",
      });
      return false;
    }
  };

  // Task #692 — swap a category's sortOrder with its neighbor inside
  // the same group. The server orders categories by sortOrder ASC then
  // name, so swapping the two persisted sortOrders is enough to flip
  // the displayed order. We fire both PATCHes in parallel and only
  // invalidate once both settle so the list doesn't redraw mid-swap.
  const handleMoveCategory = async (
    a: { id: string; sortOrder: number },
    b: { id: string; sortOrder: number },
  ) => {
    // If two rows somehow share a sortOrder (legacy data, or a fresh
    // seed where every row in a group sits at the same base offset),
    // a straight swap is a no-op. Push the target row to neighbor+1
    // (or -1 if moving up) so the swap still produces a visible change.
    const aOrder = a.sortOrder === b.sortOrder ? b.sortOrder + 1 : b.sortOrder;
    const bOrder = a.sortOrder === b.sortOrder ? b.sortOrder : a.sortOrder;
    try {
      await Promise.all([
        updateCat.mutateAsync({ id: a.id, data: { sortOrder: aOrder } }),
        updateCat.mutateAsync({ id: b.id, data: { sortOrder: bOrder } }),
      ]);
      queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
      invalidate();
    } catch (e) {
      toast({
        title: "Couldn't reorder",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleDeleteCategory = (id: string) => {
    if (!confirm("Delete this category?")) return;
    deleteCat.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListCategoriesQueryKey(),
          });
          invalidate();
          toast({ title: "Category deleted" });
        },
      },
    );
  };

  // (#692) Rename a manual envelope in the "My budget" bucket. Hooked up
  // only from that card — the BudgetLineRow on the bill-/debt-backed
  // groups never gets the onRename prop, so this handler is unreachable
  // from those rows. The server also enforces sourceKind="manual" so an
  // API client can't bypass the UI guard.
  const handleRenameMyBudgetCategory = (categoryId: string, nextName: string) => {
    updateCat.mutate(
      { id: categoryId, data: { name: nextName } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListCategoriesQueryKey(),
          });
          invalidate();
          toast({ title: "Renamed", description: `Now called "${nextName}".` });
        },
        onError: (err: unknown) => {
          const msg =
            err instanceof Error ? err.message : "Could not rename category";
          toast({
            title: "Rename failed",
            description: msg,
            variant: "destructive",
          });
        },
      },
    );
  };

  // (#692) Swap a "My budget" envelope's sortOrder with its neighbor in
  // the supplied ordered list to move it up/down one slot. We compute the
  // swap pair here (rather than persisting absolute positions) so the
  // existing sortOrder column drives display order without needing a
  // dedicated "position" field. The optimistic invalidate refreshes the
  // budget month query so the row appears in its new position on the
  // next render.
  const handleMoveMyBudgetCategory = (
    orderedLines: { categoryId: string }[],
    categoryId: string,
    direction: "up" | "down",
  ) => {
    const idx = orderedLines.findIndex((l) => l.categoryId === categoryId);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= orderedLines.length) return;
    const here = categories?.find((c) => c.id === orderedLines[idx].categoryId);
    const there = categories?.find(
      (c) => c.id === orderedLines[swapIdx].categoryId,
    );
    if (!here || !there) return;
    const hereOrder = here.sortOrder;
    const thereOrder = there.sortOrder;
    // Direction-aware fallback for the equal-sortOrder case (very common
    // since newly-created categories are all seeded at 9999): plain swap
    // would leave order unchanged. Bump whichever side needs to end up
    // later so the move is actually observable.
    let nextHere: number;
    let nextThere: number;
    if (hereOrder === thereOrder) {
      if (direction === "down") {
        nextThere = thereOrder;
        nextHere = thereOrder + 1;
      } else {
        nextHere = hereOrder;
        nextThere = hereOrder + 1;
      }
    } else {
      nextHere = thereOrder;
      nextThere = hereOrder;
    }
    Promise.all([
      updateCat.mutateAsync({
        id: here.id,
        data: { sortOrder: nextHere },
      }),
      updateCat.mutateAsync({
        id: there.id,
        data: { sortOrder: nextThere },
      }),
    ])
      .then(() => {
        queryClient.invalidateQueries({
          queryKey: getListCategoriesQueryKey(),
        });
        invalidate();
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error ? err.message : "Could not reorder category";
        toast({
          title: "Reorder failed",
          description: msg,
          variant: "destructive",
        });
      });
  };

  const monthName = useMemo(() => {
    const d = new Date(currentMonth + "T00:00:00");
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(d);
  }, [currentMonth]);

  // Only show the full-page skeleton on the very first load (before any
  // budget data exists). Once we have data for any month, keepPreviousData
  // keeps the previous month visible while the new one fetches — showing
  // a skeleton there would defeat the whole point of the smoother swap.
  if ((isLoadingBudget && !budgetData) || (isLoadingCategories && !categories)) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const allGroups = budgetData?.groups ?? [];
  // (#690) Split off the "My budget" group so the standard groups list
  // renders unchanged (bill-backed envelopes with their info icon and
  // auto-pull behavior) and the manual bucket gets its own card below.
  const groups = allGroups.filter((g) => g.groupName !== MY_BUDGET_GROUP);
  const myBudgetGroup = allGroups.find(
    (g) => g.groupName === MY_BUDGET_GROUP,
  ) ?? {
    groupName: MY_BUDGET_GROUP,
    plannedTotal: "0",
    actualTotal: "0",
    lines: [],
  };
  const summary = budgetData?.summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Budget
          </h1>
          <p className="text-muted-foreground mt-1">
            A plan for every dollar this month.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-4 bg-card px-4 py-2 rounded-md shadow-sm border border-border">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => changeMonth(-1)}
              disabled={atFloor}
              aria-disabled={atFloor}
              title={atFloor ? "April 2026 is the earliest month" : undefined}
              data-testid="button-prev-month"
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <span className="font-medium text-lg w-32 text-center">
              {monthName}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => changeMonth(1)}
              data-testid="button-next-month"
            >
              <ChevronRight className="w-5 h-5" />
            </Button>
          </div>
          <Button
            variant={monthPinned ? "default" : "outline"}
            size="sm"
            onClick={handleTogglePinMonth}
            disabled={pinMonth.isPending}
            title={
              monthPinned
                ? "Auto-pulled lines are locked to the persisted planned amounts for this month. Click to unpin and let them track Bills/Debts again."
                : "Lock every auto-pulled line to its current planned amount so it doesn't shift when Bills/Debts produce a different monthly total."
            }
            data-testid="button-toggle-pin-month"
          >
            {monthPinned ? (
              <>
                <Pin className="w-4 h-4 mr-1 fill-current" />
                Pinned
              </>
            ) : (
              <>
                <Pin className="w-4 h-4 mr-1" />
                Pin month
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <SourceBadge kind="manual" />
        <SourceBadge kind="auto_debts" />
        <SourceBadge kind="auto_bills" />
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryTile
            label="Income"
            budget={summary.income.budget}
            actual={summary.income.actual}
            testId="tile-income"
          />
          <SummaryTile
            label="Expenses"
            budget={summary.expenses.budget}
            actual={summary.expenses.actual}
            testId="tile-expenses"
          />
          <SummaryTile
            label="Net"
            budget={summary.net.budget}
            actual={summary.net.actual}
            testId="tile-net"
          />
          <SummaryTile
            label="% Spent"
            budget={summary.percentSpent.budget}
            actual={summary.percentSpent.actual}
            isPercent
            testId="tile-percent-spent"
          />
        </div>
      )}

      <div className="space-y-4">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.groupName);
          const planned = parseFloat(group.plannedTotal) || 0;
          const actual = parseFloat(group.actualTotal) || 0;
          const isIncomeGroup = group.lines[0]?.kind === "income";
          // Income: positive delta = surplus (actual > budget); Expense: positive delta = under budget.
          const delta = isIncomeGroup ? actual - planned : planned - actual;
          const deltaColor =
            delta < 0
              ? "text-destructive"
              : delta > 0
                ? "text-green-600 dark:text-green-400"
                : "text-muted-foreground";

          return (
            <Card key={group.groupName} data-testid={`group-${group.groupName}`}>
              <CardContent className="p-0">
                <button
                  type="button"
                  className="w-full flex items-center justify-between gap-4 p-4 border-b border-border hover:bg-muted/20 text-left"
                  onClick={() => toggleCollapse(group.groupName)}
                  data-testid={`button-toggle-${group.groupName}`}
                >
                  <div className="flex items-center gap-3">
                    {isCollapsed ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronUp className="w-4 h-4 text-muted-foreground" />
                    )}
                    <div>
                      <div className="font-serif font-semibold text-lg">
                        {group.groupName}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {group.lines.length}{" "}
                        {group.lines.length === 1 ? "line" : "lines"}
                      </div>
                    </div>
                  </div>
                  <div className="hidden md:flex items-center gap-6 text-sm font-mono">
                    <div>
                      <span className="text-muted-foreground mr-1">Budget</span>
                      {formatCurrency(group.plannedTotal)}
                    </div>
                    <div>
                      <span className="text-muted-foreground mr-1">Actual</span>
                      {formatCurrency(group.actualTotal)}
                    </div>
                    <div className={cn("font-medium w-28 text-right", deltaColor)}>
                      Δ {delta >= 0 ? "+" : ""}
                      {formatCurrency(delta)}
                    </div>
                  </div>
                </button>

                {!isCollapsed && (
                  <>
                    <div className="hidden md:grid grid-cols-12 gap-4 px-4 py-2 border-b border-border bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                      <div className="col-span-5">Category</div>
                      <div className="col-span-2 text-right">Budgeted</div>
                      <div className="col-span-2 text-right">Actual</div>
                      <div className="col-span-2 text-right">Difference</div>
                      <div className="col-span-1 text-right">% Spent</div>
                    </div>
                    <div className="divide-y divide-border">
                      {group.lines.length === 0 && (
                        <div className="px-4 py-6 text-sm text-muted-foreground italic">
                          All clear — no categories in this group yet.
                        </div>
                      )}
                      {group.lines.map((line, idx) => {
                        const prev = idx > 0 ? group.lines[idx - 1] : null;
                        const next =
                          idx < group.lines.length - 1
                            ? group.lines[idx + 1]
                            : null;
                        return (
                          <BudgetLineRow
                            key={line.categoryId}
                            line={line}
                            monthPinned={monthPinned}
                            monthStart={currentMonth}
                            onUpdatePlanned={handleUpdatePlanned}
                            onDelete={handleDeleteCategory}
                            onRename={handleRenameCategory}
                            onMoveUp={
                              prev
                                ? () =>
                                    handleMoveCategory(
                                      {
                                        id: line.categoryId,
                                        sortOrder: line.sortOrder,
                                      },
                                      {
                                        id: prev.categoryId,
                                        sortOrder: prev.sortOrder,
                                      },
                                    )
                                : null
                            }
                            onMoveDown={
                              next
                                ? () =>
                                    handleMoveCategory(
                                      {
                                        id: line.categoryId,
                                        sortOrder: line.sortOrder,
                                      },
                                      {
                                        id: next.categoryId,
                                        sortOrder: next.sortOrder,
                                      },
                                    )
                                : null
                            }
                            reorderDisabled={updateCat.isPending}
                            onTogglePin={handleTogglePinLine}
                            pinDisabled={pinLine.isPending}
                            uncategorizedTxns={uncategorizedThisMonth}
                            categoryRules={
                              rulesByCategory.get(line.categoryId) ?? []
                            }
                            contributingTxns={
                              txnsByCategoryThisMonth.get(line.categoryId) ?? []
                            }
                            onAssignTxn={handleAssignTxn}
                            onReassignTxn={handleReassignTxn}
                            allCategories={categories ?? []}
                            assigning={updateTx.isPending}
                          />
                        );
                      })}
                    </div>

                    <div className="p-3 border-t border-border bg-muted/10">
                      {addingFor === group.groupName ? (
                        <div className="flex items-center gap-2">
                          <Input
                            autoFocus
                            placeholder="New line name"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                handleAddCategory(group.groupName);
                              if (e.key === "Escape") {
                                setAddingFor(null);
                                setNewName("");
                              }
                            }}
                            className="max-w-xs"
                            data-testid={`input-new-line-${group.groupName}`}
                          />
                          <Button
                            size="sm"
                            onClick={() => handleAddCategory(group.groupName)}
                            disabled={!newName.trim() || createCat.isPending}
                            data-testid={`button-confirm-add-${group.groupName}`}
                          >
                            Add
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setAddingFor(null);
                              setNewName("");
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setAddingFor(group.groupName);
                            setNewName("");
                          }}
                          data-testid={`button-add-line-${group.groupName}`}
                        >
                          <Plus className="w-4 h-4 mr-1" /> Add line
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}

        {/* (#690) "My budget" — a dedicated card for personal envelopes
            that aren't tied to a bill. Rendered separately from the
            bill-backed groups above so users have an obvious place to
            stand up one-off categories ("Birthday gifts", "Kid's
            soccer"). Always visible, even when empty. These lines are
            plain manual categories (sourceKind = "manual", no linked
            recurring items), so they naturally render without the
            bill info icon or auto-pull/pin badge. Their actuals roll
            up the same way as every other manual envelope (any
            transaction the user categorizes into them counts). */}
        <Card
          key={myBudgetGroup.groupName}
          data-testid={`group-${myBudgetGroup.groupName}`}
          className="border-primary/30"
        >
          <CardContent className="p-0">
            <button
              type="button"
              className="w-full flex items-center justify-between gap-4 p-4 border-b border-border hover:bg-muted/20 text-left"
              onClick={() => toggleCollapse(myBudgetGroup.groupName)}
              data-testid={`button-toggle-${myBudgetGroup.groupName}`}
            >
              <div className="flex items-center gap-3">
                {collapsed.has(myBudgetGroup.groupName) ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                )}
                <div>
                  <div className="font-serif font-semibold text-lg">
                    My budget
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Things you're budgeting for that aren't tied to a bill.
                  </div>
                </div>
              </div>
              {(() => {
                const planned = parseFloat(myBudgetGroup.plannedTotal) || 0;
                const actual = parseFloat(myBudgetGroup.actualTotal) || 0;
                const delta = planned - actual;
                const deltaColor =
                  delta < 0
                    ? "text-destructive"
                    : delta > 0
                      ? "text-green-600 dark:text-green-400"
                      : "text-muted-foreground";
                return (
                  <div className="hidden md:flex items-center gap-6 text-sm font-mono">
                    <div>
                      <span className="text-muted-foreground mr-1">Budget</span>
                      {formatCurrency(myBudgetGroup.plannedTotal)}
                    </div>
                    <div>
                      <span className="text-muted-foreground mr-1">Actual</span>
                      {formatCurrency(myBudgetGroup.actualTotal)}
                    </div>
                    <div className={cn("font-medium w-28 text-right", deltaColor)}>
                      Δ {delta >= 0 ? "+" : ""}
                      {formatCurrency(delta)}
                    </div>
                  </div>
                );
              })()}
            </button>

            {!collapsed.has(myBudgetGroup.groupName) && (
              <>
                <div className="hidden md:grid grid-cols-12 gap-4 px-4 py-2 border-b border-border bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                  <div className="col-span-5">Category</div>
                  <div className="col-span-2 text-right">Budgeted</div>
                  <div className="col-span-2 text-right">Actual</div>
                  <div className="col-span-2 text-right">Difference</div>
                  <div className="col-span-1 text-right">% Spent</div>
                </div>
                <div className="divide-y divide-border">
                  {myBudgetGroup.lines.length === 0 && (
                    <div
                      className="px-4 py-6 text-sm text-muted-foreground italic"
                      data-testid="empty-my-budget"
                    >
                      Add a line below to start a personal envelope —
                      e.g. "Birthday gifts" or "Kid's soccer".
                    </div>
                  )}
                  {myBudgetGroup.lines.map((line, idx) => (
                    <BudgetLineRow
                      key={line.categoryId}
                      line={line}
                      monthPinned={monthPinned}
                      monthStart={currentMonth}
                      onUpdatePlanned={handleUpdatePlanned}
                      onDelete={handleDeleteCategory}
                      onTogglePin={handleTogglePinLine}
                      pinDisabled={pinLine.isPending}
                      uncategorizedTxns={uncategorizedThisMonth}
                      categoryRules={rulesByCategory.get(line.categoryId) ?? []}
                      contributingTxns={
                        txnsByCategoryThisMonth.get(line.categoryId) ?? []
                      }
                      onAssignTxn={handleAssignTxn}
                      onReassignTxn={handleReassignTxn}
                      allCategories={categories ?? []}
                      assigning={updateTx.isPending}
                      onRename={handleRenameMyBudgetCategory}
                      onMove={(catId, dir) =>
                        handleMoveMyBudgetCategory(myBudgetGroup.lines, catId, dir)
                      }
                      canMoveUp={idx > 0}
                      canMoveDown={idx < myBudgetGroup.lines.length - 1}
                      renaming={updateCat.isPending}
                    />
                  ))}
                </div>

                <div className="p-3 border-t border-border bg-muted/10">
                  {addingFor === myBudgetGroup.groupName ? (
                    <div className="flex items-center gap-2">
                      <Input
                        autoFocus
                        placeholder="New envelope name"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter")
                            handleAddCategory(myBudgetGroup.groupName);
                          if (e.key === "Escape") {
                            setAddingFor(null);
                            setNewName("");
                          }
                        }}
                        className="max-w-xs"
                        data-testid={`input-new-line-${myBudgetGroup.groupName}`}
                      />
                      <Button
                        size="sm"
                        onClick={() =>
                          handleAddCategory(myBudgetGroup.groupName)
                        }
                        disabled={!newName.trim() || createCat.isPending}
                        data-testid={`button-confirm-add-${myBudgetGroup.groupName}`}
                      >
                        Add
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setAddingFor(null);
                          setNewName("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAddingFor(myBudgetGroup.groupName);
                        setNewName("");
                      }}
                      data-testid={`button-add-line-${myBudgetGroup.groupName}`}
                    >
                      <Plus className="w-4 h-4 mr-1" /> Add line
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Editable Budgeted cell with a "where did this come from?" info popover.
// Every row stays editable — typing in a bill-backed row (Insurance,
// Utilities, Misc/Buffer, …) writes a manual override AND auto-pins the
// line so the override sticks instead of getting overwritten by the next
// bill-rollup recompute. The Avalanche payment row is the one exception
// (managed by the Avalanche page); income/expense pinning works the same
// way for both kinds. The info icon shows the contributing bills (or the
// pin/debt note) so you always know what the displayed number was before
// you overrode it.
function PlannedAmountCell({
  line,
  planned,
  isAvalanchePayment,
  onUpdatePlanned,
  onPinLine,
}: {
  line: BudgetLineWithActual;
  planned: number;
  isAvalanchePayment: boolean;
  onUpdatePlanned: (categoryId: string, amount: string) => void;
  onPinLine: (categoryId: string, currentlyPinned: boolean) => void;
}) {
  const source = line.plannedSource;
  const kind = source?.kind ?? "manual";
  const hasSourceInfo = kind !== "manual";

  const handleBlur = (rawValue: string) => {
    if (rawValue === planned.toString()) return;
    onUpdatePlanned(line.categoryId, rawValue);
    // For bill-backed / derived rows, auto-pin so the manual override
    // survives the next recompute. Skip if already pinned.
    if (
      (kind === "bills" || kind === "derived") &&
      !line.pinned &&
      !isAvalanchePayment
    ) {
      onPinLine(line.categoryId, false);
    }
  };

  if (isAvalanchePayment) {
    // Read-only: this row is managed by the Avalanche page slider.
    return (
      <div className="font-mono text-sm py-1 pr-3 text-right">
        {formatCurrency(line.plannedAmount)}
      </div>
    );
  }

  const input = (
    <Input
      type="number"
      step="1"
      className="h-7 text-right bg-transparent border-transparent hover:border-input focus:bg-background font-mono"
      defaultValue={planned.toString()}
      key={`${line.categoryId}-${line.plannedAmount}`}
      onBlur={(e) => handleBlur(e.target.value)}
      data-testid={`input-planned-${line.categoryId}`}
    />
  );

  if (!hasSourceInfo) return input;

  return (
    <div className="flex items-center justify-end gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground p-1"
            title="Where did this amount come from?"
            data-testid={`button-planned-source-${line.categoryId}`}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="end">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium">{line.categoryName}</div>
            <div className="text-[10px] text-muted-foreground">
              {formatCurrency(line.plannedAmount)}
            </div>
          </div>
          {kind === "pinned" && (
            <div className="text-xs text-muted-foreground space-y-2">
              <p>
                This amount is <span className="font-medium">pinned</span> —
                it holds at this value instead of tracking the live
                Bills/Debts derivation.
              </p>
              {(source?.bills ?? []).length > 0 && (
                <BillList bills={source!.bills} />
              )}
              <p className="text-[10px]">
                Use the pin icon next to the row name to unpin and let it
                track again.
              </p>
            </div>
          )}
          {kind === "derived" && (
            <div className="text-xs text-muted-foreground">
              <p>
                Pulled from the linked debt's current minimum payment. Edit
                this row to override; it will be auto-pinned so the override
                sticks.
              </p>
            </div>
          )}
          {kind === "bills" && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Sum of {(source?.bills ?? []).length} bill
                {(source?.bills ?? []).length === 1 ? "" : "s"} linked to
                this category. Edit this row to override; it will be
                auto-pinned so the override sticks. Reassign a bill on the
                Bills page to change where it lands.
              </p>
              <BillList bills={source!.bills} />
            </div>
          )}
        </PopoverContent>
      </Popover>
      <div className="flex-1 max-w-[8rem]">{input}</div>
    </div>
  );
}

function BillList({ bills }: { bills: LinkedBillEntry[] }) {
  if (bills.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-1">
        No linked bills hit this month.
      </div>
    );
  }
  return (
    <div
      className="space-y-0.5 max-h-64 overflow-y-auto pr-1"
      data-testid="planned-source-bill-list"
    >
      {bills.map((b) => (
        <div
          key={b.id}
          className="flex items-start justify-between gap-2 px-2 py-1.5 rounded hover:bg-muted/40"
          data-testid={`planned-source-bill-${b.id}`}
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{b.name}</div>
            <div className="text-[10px] text-muted-foreground">
              {b.frequency}
              {b.eventCount === 0
                ? " · no events this month"
                : b.eventCount > 1
                  ? ` · ${b.eventCount} events this month`
                  : ""}
            </div>
          </div>
          <div className="text-xs font-mono tabular-nums whitespace-nowrap">
            {formatCurrency(b.amount)}
          </div>
        </div>
      ))}
    </div>
  );
}

// Single uncategorized-transaction row inside the inline-categorize popover.
// `highlight` adds a subtle violet tint when the row is in the "Suggested"
// section (matched a rule or category-name substring).
function UncategorizedRow({
  tx,
  categoryId,
  onAssign,
  assigning,
  highlight = false,
}: {
  tx: Transaction;
  categoryId: string;
  onAssign: (txId: string, categoryId: string) => void;
  assigning: boolean;
  highlight?: boolean;
}) {
  const amt = Number(tx.amount);
  return (
    <button
      type="button"
      disabled={assigning}
      onClick={() => onAssign(tx.id, categoryId)}
      className={cn(
        "w-full flex items-start justify-between gap-2 text-left px-2 py-1.5 rounded hover:bg-muted/50 disabled:opacity-50",
        highlight && "bg-violet-50/60 dark:bg-violet-950/20",
      )}
      data-testid={`button-assign-${tx.id}-to-${categoryId}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate">{tx.description}</div>
        <div className="text-[10px] text-muted-foreground">
          {tx.occurredOn}
          {tx.source ? ` · ${tx.source}` : ""}
        </div>
      </div>
      <div
        className={cn(
          "text-xs font-mono tabular-nums whitespace-nowrap",
          amt < 0 ? "text-rose-700" : "text-emerald-700",
        )}
      >
        {formatCurrency(amt)}
      </div>
    </button>
  );
}

// Mirrors the server-side source label collapse in /budget/months
// (artifacts/api-server/src/routes/budget.ts) so the actuals-breakdown
// popover surfaces the same friendly "Bank" / "Amex" labels the row's
// source-breakdown badges already use, instead of raw strings like
// "plaid:amex_xxx" or "manual" that leak from the underlying source field.
function friendlySourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source === "amex" || source.startsWith("plaid:amex")) return "Amex";
  if (source.startsWith("plaid:")) return "Bank";
  if (source === "manual") return "Manual";
  return source;
}

// Task #295 — small "..." affordance that opens a searchable category
// picker for a single transaction inside the actuals breakdown popover.
// Stays mounted inside the parent popover so opening this nested picker
// does not close the actuals popover. The currently-selected category is
// passed in so we can short-circuit no-op picks (avoiding a redundant
// PATCH and an empty Undo toast).
function ActualsRowReassignPicker({
  tx,
  currentCategoryId,
  allCategories,
  onReassign,
  assigning,
}: {
  tx: Transaction;
  currentCategoryId: string;
  allCategories: { id: string; name: string }[];
  onReassign: (
    txId: string,
    nextCategoryId: string,
    prevCategoryId: string | null,
  ) => void;
  assigning: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground -mr-1"
          disabled={assigning}
          onClick={(e) => e.stopPropagation()}
          title="Re-categorize this transaction"
          data-testid={`button-reassign-${tx.id}`}
          aria-label="Re-categorize this transaction"
        >
          <MoreHorizontal className="w-3 h-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0"
        align="end"
        onClick={(e) => e.stopPropagation()}
      >
        <Command>
          <CommandInput placeholder="Move to category…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
              {allCategories.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  onSelect={() => {
                    setOpen(false);
                    if (c.id !== currentCategoryId) {
                      onReassign(tx.id, c.id, currentCategoryId);
                    }
                  }}
                  data-testid={`item-reassign-${tx.id}-to-${c.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-3 w-3",
                      c.id === currentCategoryId ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Returns true when `description` matches `rule` per its matchType.
function ruleMatches(description: string, rule: MappingRule): boolean {
  const pattern = rule.pattern.toLowerCase();
  if (!pattern) return false;
  const hay = (description ?? "").toLowerCase();
  switch (rule.matchType) {
    case "starts_with":
      return hay.startsWith(pattern);
    case "exact":
      return hay === pattern;
    case "contains":
    default:
      return hay.includes(pattern);
  }
}

function BudgetLineRow({
  line,
  monthPinned,
  monthStart,
  onUpdatePlanned,
  onDelete,
  onRename,
  onMoveUp,
  onMoveDown,
  reorderDisabled,
  onTogglePin,
  pinDisabled,
  uncategorizedTxns,
  categoryRules,
  contributingTxns,
  onAssignTxn,
  onReassignTxn,
  allCategories,
  assigning,
  onMove,
  canMoveUp,
  canMoveDown,
  renaming,
}: {
  line: BudgetLineWithActual;
  monthPinned: boolean;
  monthStart: string;
  onUpdatePlanned: (categoryId: string, amount: string) => void;
  onDelete: (id: string) => void;
  onRename: (
    id: string,
    nextName: string,
    prevName: string,
  ) => Promise<boolean>;
  onMoveUp: (() => void) | null;
  onMoveDown: (() => void) | null;
  reorderDisabled: boolean;
  onTogglePin: (categoryId: string, currentlyPinned: boolean) => void;
  pinDisabled: boolean;
  uncategorizedTxns: Transaction[];
  categoryRules: MappingRule[];
  contributingTxns: Transaction[];
  onAssignTxn: (txId: string, categoryId: string) => void;
  onReassignTxn: (
    txId: string,
    nextCategoryId: string,
    prevCategoryId: string | null,
  ) => void;
  allCategories: { id: string; name: string }[];
  assigning: boolean;
  // (#692) Optional reorder hook. Provided only by the
  // "My budget" card so the standard groups (auto_bills / auto_debts)
  // never expose controls that the backend would reject anyway.
  onMove?: (categoryId: string, direction: "up" | "down") => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  renaming?: boolean;
}) {
  // Task #692 — inline rename. The pencil icon next to the name flips
  // the row into edit mode; we save on blur/Enter and bail on Escape.
  // We keep the rename affordance off the Avalanche-payment row (system
  // managed) and off the system-managed "Uncategorized" bucket — every
  // other line, including bill-backed ones, can be relabeled freely.
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(line.categoryName);
  useEffect(() => {
    if (!editingName) setDraftName(line.categoryName);
  }, [line.categoryName, editingName]);
  const isUncategorizedRow = line.categoryName === "Uncategorized";
  const [, navigate] = useLocation();
  // (#692) Local rename state — only ever shown when onRename is wired
  // up (i.e. from the My budget card). The draft input replaces the
  // drill-down name button while editing; Enter commits, Esc cancels.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  // #176 (Item 4) — split uncategorized into "suggested" (descriptions that
  // match an existing rule for this category, or contain the row's category
  // name as a fallback) vs the rest. Surfaces the rule-based hint without
  // hiding the long tail the user may still want to triage manually.
  const { suggestedTxns, otherTxns } = useMemo(() => {
    const catNeedle = (line.categoryName ?? "").toLowerCase().trim();
    const suggested: Transaction[] = [];
    const other: Transaction[] = [];
    for (const t of uncategorizedTxns) {
      const ruleHit = categoryRules.some((r) => ruleMatches(t.description, r));
      const nameHit =
        catNeedle.length >= 3 &&
        (t.description ?? "").toLowerCase().includes(catNeedle);
      if (ruleHit || nameHit) suggested.push(t);
      else other.push(t);
    }
    return { suggestedTxns: suggested, otherTxns: other };
  }, [uncategorizedTxns, categoryRules, line.categoryName]);
  const planned = parseFloat(line.plannedAmount) || 0;
  const actual = parseFloat(line.actualAmount) || 0;
  const isIncome = line.kind === "income";
  // Income: positive diff = surplus (actual > budget). Expense: positive diff = under budget.
  const diff = isIncome ? actual - planned : planned - actual;
  const diffColor =
    diff < 0
      ? "text-destructive"
      : diff > 0
        ? "text-green-600 dark:text-green-400"
        : "text-muted-foreground";
  const pct = planned > 0 ? Math.round((actual / planned) * 100) : null;
  const sourceKind = line.sourceKind as SourceKind;
  // The "Avalanche payment" line is system-managed: created/updated by the
  // Avalanche page slider. It's still editable here (POST mirrors back into
  // avalancheSettings.manualExtra) but it can't be deleted.
  const isAvalanchePayment = line.categoryName === "Avalanche payment";
  const isReadOnly = sourceKind !== "manual";

  // Task #168 — pick the destination page for category drill-down based on
  // where this line's actuals actually came from. See
  // `pickCategoryDrillDownHref` above for the routing rule.
  const drillDownHref = useMemo(
    () =>
      pickCategoryDrillDownHref(
        line.categoryName,
        monthStart,
        line.sourceBreakdown,
      ),
    [line.sourceBreakdown, line.categoryName, monthStart],
  );

  return (
    <div
      className="group px-4 py-1.5 hover:bg-muted/10"
      data-testid={`row-budget-${line.categoryId}`}
    >
    <div className="grid grid-cols-12 gap-4 items-center">
      <div className="col-span-12 md:col-span-5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {renameDraft !== null && onRename ? (
            // (#692) Inline rename input — replaces the drill-down name
            // button while editing. Enter commits, Esc cancels, blur
            // commits if the value changed (so clicking away mirrors
            // Enter rather than dropping the edit silently).
            <Input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const next = renameDraft.trim();
                  if (next && next !== line.categoryName) {
                    onRename(line.categoryId, next);
                  }
                  setRenameDraft(null);
                } else if (e.key === "Escape") {
                  setRenameDraft(null);
                }
              }}
              onBlur={() => {
                const next = renameDraft.trim();
                if (next && next !== line.categoryName) {
                  onRename(line.categoryId, next);
                }
                setRenameDraft(null);
              }}
              className="h-7 max-w-[220px] text-sm"
              data-testid={`input-rename-${line.categoryId}`}
            />
          ) : null}
          {renameDraft !== null && onRename ? null : (() => {
            const opensInAmex = drillDownHref.startsWith("/amex");
            const destLabel = opensInAmex ? "Amex" : "Transactions";
            return (
              <button
                type="button"
                className="font-medium truncate hover:underline decoration-dotted underline-offset-2 text-left inline-flex items-center gap-1"
                title={`View ${line.categoryName} transactions — Opens in ${destLabel}`}
                onClick={() => navigate(drillDownHref)}
                data-testid={`button-category-name-${line.categoryId}`}
                data-drilldown-target={opensInAmex ? "amex" : "transactions"}
              >
                <span className="truncate">{line.categoryName}</span>
                {opensInAmex ? (
                  <CreditCard
                    className="w-3 h-3 shrink-0 text-blue-600 dark:text-blue-300"
                    aria-hidden="true"
                    data-testid={`icon-drilldown-amex-${line.categoryId}`}
                  />
                ) : (
                  <Landmark
                    className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-300"
                    aria-hidden="true"
                    data-testid={`icon-drilldown-transactions-${line.categoryId}`}
                  />
                )}
              </button>
            );
          })()}
          {(line.sourceBreakdown ?? []).map((b) => (
            <Badge
              key={b.source}
              variant="outline"
              className={cn(
                "text-[10px] font-normal",
                b.source === "Bank" &&
                  "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300",
                b.source === "Amex" &&
                  "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300",
              )}
              title={`${b.count} txn${b.count === 1 ? "" : "s"} · ${formatCurrency(b.amount)}`}
              data-testid={`badge-source-${b.source.toLowerCase()}-${line.categoryId}`}
            >
              {b.source} · {b.count}
            </Badge>
          ))}
          {line.pinned && (
            <Badge
              variant="outline"
              className="text-[10px] font-normal border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300"
              title={
                monthPinned
                  ? "This month is pinned — every auto-pulled line is locked to its persisted planned amount."
                  : "This line is pinned to its persisted planned amount."
              }
              data-testid={`badge-pinned-${line.categoryId}`}
            >
              <Pin className="w-3 h-3 mr-1 fill-current" />
              Pinned
            </Badge>
          )}
          {/* #90 / #176 / #417 — inline categorize from Budget. Surfaces
              the violet "N matches" hint only when one or more
              uncategorized transactions match an existing rule for this
              category or contain the category name. Click to assign in
              one tap. The neutral "+N other" fallback was removed in
              #417 to keep rows compact. */}
          {suggestedTxns.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Badge
                  variant="outline"
                  className="text-[10px] font-normal cursor-pointer border-dashed border-violet-300 text-violet-700 bg-violet-50 hover:border-violet-500 dark:bg-violet-950/30 dark:text-violet-300"
                  title={`${suggestedTxns.length} uncategorized transaction${suggestedTxns.length === 1 ? "" : "s"} look like ${line.categoryName} (rule or name match) — click to assign.`}
                  data-testid={`button-categorize-${line.categoryId}`}
                  data-suggested-count={suggestedTxns.length}
                >
                  <Tag className="w-3 h-3 mr-1" />
                  {`${suggestedTxns.length} match${suggestedTxns.length === 1 ? "" : "es"}`}
                </Badge>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-3" align="start">
                <div className="text-xs font-medium mb-2">
                  Assign to {line.categoryName}
                </div>
                <div
                  className="space-y-3 max-h-72 overflow-y-auto pr-1"
                  data-testid={`uncategorized-list-${line.categoryId}`}
                >
                  {suggestedTxns.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-300 mb-1">
                        Suggested · matches rule or name
                      </div>
                      <div className="space-y-1">
                        {suggestedTxns.slice(0, 25).map((t) => (
                          <UncategorizedRow
                            key={t.id}
                            tx={t}
                            categoryId={line.categoryId}
                            onAssign={onAssignTxn}
                            assigning={assigning}
                            highlight
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {otherTxns.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                        {suggestedTxns.length > 0 ? "Other uncategorized" : "Uncategorized this month"}
                      </div>
                      <div className="space-y-1">
                        {otherTxns.slice(0, 50).map((t) => (
                          <UncategorizedRow
                            key={t.id}
                            tx={t}
                            categoryId={line.categoryId}
                            onAssign={onAssignTxn}
                            assigning={assigning}
                          />
                        ))}
                        {otherTxns.length > 50 && (
                          <div className="text-[10px] text-muted-foreground text-center pt-1">
                            Showing 50 of {otherTxns.length}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {isAvalanchePayment ? (
            <Badge
              variant="outline"
              className="text-[10px] font-normal ml-auto md:ml-0 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300"
              title="Edit this on the Avalanche page slider — both stay in sync."
            >
              Managed by Avalanche
            </Badge>
          ) : (
            <div className="ml-auto md:ml-0 flex items-center gap-1">
              {/* Task #692 — reorder this category within its group.
                  Buttons are present on every non-Avalanche row so power
                  users can shuffle bill-backed envelopes too; they no-op
                  (disabled) at the top/bottom of the group. */}
              {!isAvalanchePayment && !onMove && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 disabled:opacity-30"
                    onClick={() => onMoveUp?.()}
                    disabled={!onMoveUp || reorderDisabled}
                    title="Move up"
                    aria-label="Move up"
                    data-testid={`button-move-up-${line.categoryId}`}
                  >
                    <ArrowUp className="w-3 h-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 disabled:opacity-30"
                    onClick={() => onMoveDown?.()}
                    disabled={!onMoveDown || reorderDisabled}
                    title="Move down"
                    aria-label="Move down"
                    data-testid={`button-move-down-${line.categoryId}`}
                  >
                    <ArrowDown className="w-3 h-3" />
                  </Button>
                </>
              )}
              {isReadOnly && !isAvalanchePayment && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 disabled:opacity-50"
                  onClick={() => onTogglePin(line.categoryId, line.pinned)}
                  disabled={pinDisabled || monthPinned}
                  data-testid={`button-toggle-pin-${line.categoryId}`}
                  title={
                    monthPinned
                      ? "This month is pinned — unpin the month to control individual lines."
                      : line.pinned
                        ? "Unpin this line so it tracks Bills/Debts again."
                        : "Pin this line to its current planned amount."
                  }
                >
                  {line.pinned ? (
                    <PinOff className="w-3 h-3" />
                  ) : (
                    <Pin className="w-3 h-3" />
                  )}
                </Button>
              )}
              {/* (#692) Rename + reorder controls — only shown when the
                  parent wires up onRename / onMove (i.e. inside the My
                  budget card). The buttons mirror the existing hover-fade
                  pattern so they don't add visual noise on the rest of
                  the budget rows. */}
              {onRename && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
                  onClick={() => setRenameDraft(line.categoryName)}
                  disabled={renaming}
                  data-testid={`button-rename-${line.categoryId}`}
                  title="Rename this envelope"
                >
                  <Pencil className="w-3 h-3" />
                </Button>
              )}
              {onMove && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 disabled:opacity-30"
                    onClick={() => onMove(line.categoryId, "up")}
                    disabled={!canMoveUp || renaming}
                    data-testid={`button-move-up-${line.categoryId}`}
                    title="Move up"
                  >
                    <ChevronUp className="w-3 h-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 disabled:opacity-30"
                    onClick={() => onMove(line.categoryId, "down")}
                    disabled={!canMoveDown || renaming}
                    data-testid={`button-move-down-${line.categoryId}`}
                    title="Move down"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
                onClick={() => onDelete(line.categoryId)}
                data-testid={`button-delete-${line.categoryId}`}
                title={
                  isReadOnly
                    ? "Delete this auto-pulled line (re-seeding will restore it)"
                    : "Delete this line"
                }
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="col-span-3 md:col-span-2 text-right">
        <PlannedAmountCell
          line={line}
          planned={planned}
          isAvalanchePayment={isAvalanchePayment}
          onUpdatePlanned={onUpdatePlanned}
          onPinLine={onTogglePin}
        />
      </div>
      <div className="col-span-3 md:col-span-2 text-right font-mono text-sm">
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="hover:underline decoration-dotted underline-offset-2 cursor-pointer tabular-nums"
              title="View contributing transactions"
              data-testid={`button-actuals-${line.categoryId}`}
            >
              {formatCurrency(line.actualAmount)}
            </button>
          </PopoverTrigger>
          {/* #176 (Item 5) — actuals breakdown popover. Lists every
              transaction that contributed to this row's actual total this
              month (newest first), plus a deep link into the Transactions
              page filtered to the same category + month for the full view. */}
          <PopoverContent className="w-80 p-3" align="end">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium">{line.categoryName}</div>
              <div className="text-[10px] text-muted-foreground">
                {contributingTxns.length} txn{contributingTxns.length === 1 ? "" : "s"} · {formatCurrency(line.actualAmount)}
              </div>
            </div>
            {contributingTxns.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">
                No transactions contributed to this line this month.
              </div>
            ) : (
              <>
                {/* Running total — accumulates chronologically (oldest →
                    newest) so the newest row at the top shows the full
                    category total, and each older row shows what was spent
                    up to that point. Helps answer "which week added up the
                    most?" at a glance for high-traffic categories. */}
                <div
                  className="space-y-0.5 max-h-64 overflow-y-auto pr-1"
                  data-testid={`actuals-list-${line.categoryId}`}
                >
                  {(() => {
                    const runningById = new Map<string, number>();
                    let acc = 0;
                    for (let i = contributingTxns.length - 1; i >= 0; i--) {
                      const t = contributingTxns[i];
                      acc += Number(t.amount);
                      runningById.set(t.id, acc);
                    }
                    return contributingTxns.slice(0, 25).map((t) => {
                      const amt = Number(t.amount);
                      const running = runningById.get(t.id) ?? amt;
                      return (
                        <div
                          key={t.id}
                          className="flex items-start justify-between gap-2 px-2 py-1.5 rounded hover:bg-muted/40"
                          data-testid={`actuals-row-${t.id}`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium truncate">{t.description}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {t.occurredOn}
                              {(() => {
                                const lbl = friendlySourceLabel(t.source);
                                return lbl ? ` · ${lbl}` : "";
                              })()}
                            </div>
                          </div>
                          <div className="flex flex-col items-end whitespace-nowrap">
                            <div
                              className={cn(
                                "text-xs font-mono tabular-nums",
                                amt < 0 ? "text-rose-700" : "text-emerald-700",
                              )}
                            >
                              {formatCurrency(amt)}
                            </div>
                            <div
                              className="text-[10px] font-mono tabular-nums text-muted-foreground"
                              title="Running total of this category (oldest through this row)"
                              data-testid={`actuals-running-${t.id}`}
                            >
                              {formatCurrency(running)}
                            </div>
                          </div>
                          {/* Task #295 — inline re-categorize affordance.
                              Opens a category picker so a misfiled charge
                              (e.g. Costco gas → Auto instead of Groceries)
                              can be re-pointed without leaving the Budget
                              page. The handler invalidates both the txn
                              list and the current month so the popover
                              total and the row's actual refresh in place. */}
                          <ActualsRowReassignPicker
                            tx={t}
                            currentCategoryId={line.categoryId}
                            allCategories={allCategories}
                            onReassign={onReassignTxn}
                            assigning={assigning}
                          />
                        </div>
                      );
                    });
                  })()}
                  {contributingTxns.length > 25 && (() => {
                    const hidden = contributingTxns.slice(25);
                    const hiddenSum = hidden.reduce((s, t) => s + Number(t.amount), 0);
                    return (
                      <div
                        className="flex items-start justify-between gap-2 px-2 py-1.5 rounded bg-muted/30 border-t mt-1"
                        data-testid={`actuals-hidden-tail-${line.categoryId}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] font-medium text-muted-foreground">
                            + {hidden.length} earlier transaction{hidden.length === 1 ? "" : "s"}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            Included in the running total above
                          </div>
                        </div>
                        <div
                          className="text-xs font-mono tabular-nums text-muted-foreground"
                          data-testid={`actuals-hidden-tail-sum-${line.categoryId}`}
                        >
                          {formatCurrency(hiddenSum)}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <div className="border-t mt-2 pt-2">
                  <button
                    type="button"
                    className="text-xs text-violet-700 hover:underline dark:text-violet-300"
                    onClick={() => navigate(drillDownHref)}
                    data-testid={`button-view-all-${line.categoryId}`}
                  >
                    View all in {drillDownHref.startsWith("/amex") ? "Amex" : "Transactions"} →
                  </button>
                </div>
              </>
            )}
            {/* Source split — kept for at-a-glance Bank vs Amex parity but
                now subordinate to the txn list above. */}
            {(line.sourceBreakdown ?? []).length > 0 && (
              <div className="border-t mt-2 pt-2 space-y-1">
                {(line.sourceBreakdown ?? []).map((b) => (
                  <div key={b.source} className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{b.source}</span>
                    <span className="tabular-nums font-mono">
                      {b.count} txn · {formatCurrency(b.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
      <div
        className={cn(
          "col-span-3 md:col-span-2 text-right font-mono text-sm font-medium",
          diffColor,
        )}
      >
        {diff >= 0 ? "+" : ""}
        {formatCurrency(diff)}
      </div>
      <div className="col-span-3 md:col-span-1 text-right font-mono text-sm text-muted-foreground">
        {pct === null ? "—" : `${pct}%`}
      </div>
    </div>
    {contributingTxns.length > 0 && (
      <div
        className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums"
        data-testid={`analysis-strip-${line.categoryId}`}
      >
        <span>
          <span className="font-mono">{formatCurrency(actual)}</span>
          <span className="text-muted-foreground/70"> spent</span>
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span>
          <span className="font-mono">{formatCurrency(planned)}</span>
          <span className="text-muted-foreground/70"> planned</span>
        </span>
        {pct !== null && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span>
              <span className="font-mono">{pct}%</span>
              <span className="text-muted-foreground/70"> of plan</span>
            </span>
          </>
        )}
        {planned > 0 && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className={cn("font-mono", diffColor)}>
              {diff >= 0
                ? `${formatCurrency(Math.abs(diff))} ${isIncome ? "over plan" : "remaining"}`
                : `${formatCurrency(Math.abs(diff))} ${isIncome ? "under plan" : "over"}`}
            </span>
          </>
        )}
        {planned > 0 && !isIncome && (() => {
          const monthDate = new Date(monthStart + "T00:00:00");
          const year = monthDate.getUTCFullYear();
          const month = monthDate.getUTCMonth();
          const daysInMonth = new Date(year, month + 1, 0).getDate();
          const today = new Date();
          const sameMonth =
            today.getUTCFullYear() === year && today.getUTCMonth() === month;
          if (!sameMonth) return null;
          const dayOfMonth = today.getUTCDate();
          const expectedPct = Math.round((dayOfMonth / daysInMonth) * 100);
          if (pct === null) return null;
          const aheadBy = pct - expectedPct;
          const paceLabel =
            Math.abs(aheadBy) <= 5
              ? "on pace"
              : aheadBy > 0
                ? `${aheadBy}% ahead of pace`
                : `${Math.abs(aheadBy)}% under pace`;
          const paceColor =
            Math.abs(aheadBy) <= 5
              ? "text-muted-foreground"
              : aheadBy > 0
                ? "text-amber-600 dark:text-amber-400"
                : "text-emerald-600 dark:text-emerald-400";
          return (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className={paceColor} data-testid={`analysis-pace-${line.categoryId}`}>
                {paceLabel}
              </span>
            </>
          );
        })()}
      </div>
    )}
    </div>
  );
}
