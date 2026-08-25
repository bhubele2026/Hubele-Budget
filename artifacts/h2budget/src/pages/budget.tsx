import { useState, useEffect, useMemo, useRef } from "react";
import { useSearch, useLocation, Link } from "wouter";
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
import { formatCurrency, cn } from "@/lib/utils";
import {
  card,
  cardHead,
  btnLink,
  btnSm,
  btnSecondarySm,
  emptyNote,
  fieldLabel,
  input as inputControl,
  inputInline,
  Foot,
  Help,
  Stat,
} from "@/ui";
// `@/lib/cssBars` and NOT `@/lib/charts`: the latter statically imports
// recharts, and this page draws no chart. Reaching for the barrel would put
// ~450 KB behind a route that needs a coloured `<span>`.
import { CssFillMeter } from "@/lib/cssBars";
import { MoneyText } from "@/components/viz";
import { PlanStrip } from "./budget/planStrip";
import { AllowanceCard } from "./budget/allowanceCard";
import {
  PLAN_SECTIONS,
  splitBySource,
  sectionVerdict,
  type PlanSectionDef,
  type BudgetLine,
} from "./budget/planSources";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Pencil,
  Pin,
  CreditCard,
  Landmark,
  MoreHorizontal,
  Check,
  Info,
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

/**
 * ⭐ ONE DOM, TWO SHAPES — the envelope row.
 *
 * Below `sm` each figure stacks under the envelope name carrying its own
 * micro-cap label; from `sm` up the same nodes lock into fixed columns so
 * every plan, every actual and every meter in the card shares a vertical
 * edge. Rendering two different trees for the two widths is what makes a
 * table and its phone layout drift apart, and it doubles the number of
 * places a testid has to be kept alive.
 *
 * The columns are: envelope · plan · actual · used · left/over.
 */
// ⚠️ The meter column is CAPPED, not `1fr`. Left to grow it takes every pixel
// the card has spare and the bar stops reading as a measure and starts reading
// as a loading bar — while the envelope name, which is the column that
// actually has variable content (long names, source chips, row controls), gets
// squeezed. The slack belongs to the name.
const ROW_GRID =
  "grid grid-cols-1 gap-x-3 gap-y-1 px-4 py-2 sm:grid-cols-[minmax(9rem,1fr)_6.5rem_6.5rem_minmax(6rem,11rem)_7.25rem] sm:items-center sm:gap-y-0";
const headCell =
  "text-micro font-semibold uppercase tracking-wide text-neutral-400";

/**
 * ⚠️ THE COLUMNS HAVE TO BE NAMED. A row reads
 * `$ 460.00  $512.88  ▓▓▓ 111%  −$52.88 OVER` — five figures, and without a
 * head above them the reader has to infer which is the plan and which is the
 * spend from their size. It sits inside each source card rather than once at
 * the top of the page, because the cards scroll independently of it.
 *
 * `sm`+ only: below that the row stacks and each figure carries its own label
 * from `Cell`.
 */
function ColumnHeads() {
  return (
    <div
      role="row"
      className={`hidden border-b border-brand-line bg-platinum-2 sm:grid ${ROW_GRID.replace(
        "grid ",
        "",
      ).replace("py-2", "py-1.5")}`}
    >
      <span className={headCell}>Envelope</span>
      <span className={`${headCell} text-right`}>Plan</span>
      <span className={`${headCell} text-right`}>Spent</span>
      <span className={`${headCell} text-right`}>Used</span>
      <span className={`${headCell} text-right`}>Left / over</span>
    </div>
  );
}
/** Money, everywhere it renders: mono, tabular, and it must not reflow. */
const num = "font-mono text-label tabular-nums";

/**
 * The month stepper's two arrows, and the shape every quiet icon control on
 * this page takes. Keyboard focus is the navy ring from `index.css`, stated
 * again here so the control keeps it when it sits on a tinted row.
 */
const monthStep =
  "press grid h-6 w-6 place-items-center rounded-control text-neutral-500 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-navy/40 disabled:pointer-events-none disabled:opacity-30";
/**
 * The row-level affordances: rename, reorder, pin, delete. They fade in on
 * hover on a pointer device and are always present on touch.
 *
 * ⚠️ DISABLED IS A COLOUR HERE, NOT AN OPACITY. `disabled:opacity-30` and the
 * hover-reveal both set `opacity`, and the disabled variant wins the cascade —
 * so at rest the ONLY control visible on a row was the one you cannot use
 * (the greyed "move up" on every first row), while its working siblings sat
 * invisible at 0. Opacity belongs to the reveal alone; unavailability says so
 * in a lighter ink.
 */
const rowIcon =
  "press inline-flex h-6 w-6 items-center justify-center rounded-control text-neutral-400 hover:bg-neutral-100 hover:text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-navy/40 disabled:pointer-events-none disabled:text-neutral-300 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100";

/**
 * A figure and the word for its column, on the phone. On `sm` and up the
 * column head above says it once for the whole card and this label goes away.
 */
function Cell({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 sm:block sm:text-right",
        className,
      )}
    >
      <span className={`${fieldLabel} sm:hidden`}>{label}</span>
      {children}
    </div>
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
  // #90 — surface uncategorized rows for inline categorization from each Budget
  // row. Every consumer of allTxns filters to the currently viewed month, so
  // (#perf) scope the fetch to that same month window with a small cap instead
  // of pulling the whole ledger; the downstream aggregation is identical.
  const txnMonthStart = currentMonth;
  const txnMonthEnd = useMemo(() => {
    const d = new Date(currentMonth + "T00:00:00");
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
  }, [currentMonth]);
  const { data: allTxns } = useListTransactions({
    from: txnMonthStart,
    to: txnMonthEnd,
    limit: 200,
  });
  // #176 — used both for the actuals-breakdown popover (per-row contributing
  // transactions) and for ranking which uncategorized transactions to suggest
  // for a given budget row (any rule whose pattern matches the description
  // and points at this row's categoryId surfaces it as a hint).
  const { data: mappingRules } = useListMappingRules();

  const queryClient = useQueryClient();
  const { toast } = useToast();

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

  /**
   * ⚠️ NOT A CONTROL — THE MECHANISM BEHIND AN OVERRIDE.
   *
   * The per-line pin button is gone, but the behaviour it backed is not: when
   * you type a plan into a bill- or debt-derived row, the line has to be pinned
   * or the next Bills/Debts recompute silently overwrites what you just typed.
   * `PlannedAmountCell` calls this on commit. It stays quiet — no toast — since
   * the user did not ask to pin anything, they asked for their number to stick.
   */
  const handleAutoPinLine = (categoryId: string, currentlyPinned: boolean) => {
    if (currentlyPinned) return;
    pinLine.mutate(
      { data: { monthStart: currentMonth, categoryId, pinned: true } },
      { onSuccess: () => invalidate() },
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

  // (#698) Delete a "My budget" envelope with a tailored confirm when
  // the envelope has already absorbed real spending this month. The
  // default DELETE just removes the category row, which silently
  // un-links every transaction pointing at it (categoryId becomes
  // null) and drops them off the monthly roll-up. For empty envelopes
  // we skip the prompt entirely — there's no destructive side effect
  // to warn about. For non-empty ones we show the count and total
  // about to be unlinked so the user can back out.
  //
  // The "actual" param comes from the row's already-loaded budget-month
  // line and is the source of truth for "is this envelope empty?" — it
  // sidesteps a race where allTxns (useListTransactions) is still
  // loading and txnsByCategoryThisMonth would otherwise look empty.
  // When the per-transaction list is also loaded we use it to fill in
  // the exact count + signed total in the prompt; if it isn't, we fall
  // back to a generic "transactions this month (~$total)" message
  // sourced from the actual so the user is still warned, just with
  // less specificity.
  const handleDeleteMyBudgetCategory = (id: string, actual: string) => {
    const actualNum = Math.abs(parseFloat(actual) || 0);
    const txnsLoaded = !!allTxns;
    const txns = txnsByCategoryThisMonth.get(id) ?? [];
    const hasSpending = txns.length > 0 || actualNum > 0;
    if (hasSpending) {
      const message =
        txnsLoaded && txns.length > 0
          ? `Delete this envelope? ${txns.length} transaction${
              txns.length === 1 ? "" : "s"
            } this month (${formatCurrency(
              txns
                .reduce(
                  (sum, t) => sum + Math.abs(parseFloat(t.amount) || 0),
                  0,
                )
                .toFixed(2),
            )}) will become uncategorized and drop off the monthly roll-up.`
          : `Delete this envelope? ~${formatCurrency(
              actualNum.toFixed(2),
            )} of transactions this month will become uncategorized and drop off the monthly roll-up.`;
      const ok = confirm(message);
      if (!ok) return;
    }
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
        <div className="skeleton h-8 w-40" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  const lines = budgetData?.lines ?? [];
  const plan = budgetData?.planBySource;
  const allowance = budgetData?.allowance;
  const bySource = splitBySource(lines);
  const summary = budgetData?.summary;

  // ⭐ THE HERO IS THE PLAN, NOT THE SPEND. The page exists to answer "what am
  // I committed to this month, and where does it come from" — so the figure at
  // the top is `plannedTotal` (bills + debt payments) read against planned
  // income, both straight off the server's `planBySource`. The page does no
  // money arithmetic of its own (CLAUDE.md §1); these three `Number(...)` calls
  // parse a decimal string the server already settled, they do not compute one.
  const plannedTotal = Number(plan?.plannedTotal ?? 0);
  const plannedIncome = Number(plan?.income.planned ?? 0);
  const actualTotal = Number(plan?.actualTotal ?? 0);
  const committedPct =
    plannedIncome > 0
      ? Math.min(100, Math.round((plannedTotal / plannedIncome) * 100))
      : 0;
  const overCommitted = plannedIncome > 0 && plannedTotal > plannedIncome;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display font-semibold text-brand-navy">Budget</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              className={monthStep}
              onClick={() => changeMonth(-1)}
              disabled={atFloor}
              aria-disabled={atFloor}
              aria-label="Previous month"
              title={atFloor ? "April 2026 is the earliest month" : undefined}
              data-testid="button-prev-month"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-[8.5rem] text-center text-label font-medium text-neutral-700">
              {monthName}
            </span>
            <button
              type="button"
              className={monthStep}
              onClick={() => changeMonth(1)}
              aria-label="Next month"
              data-testid="button-next-month"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
          <button
            type="button"
            onClick={handleTogglePinMonth}
            disabled={pinMonth.isPending}
            title={
              monthPinned
                ? "Locked to this month's planned amounts. Click to unpin."
                : "Lock planned amounts so they don't shift with Bills/Debts."
            }
            data-testid="button-toggle-pin-month"
            className={
              monthPinned
                ? "press inline-flex items-center gap-1 rounded-control bg-brand-navy px-2.5 py-1 text-micro font-semibold text-white hover:bg-brand-navy2 disabled:pointer-events-none disabled:opacity-55"
                : btnLink
            }
          >
            <Pin className={cn("h-3 w-3", monthPinned && "fill-current")} />
            {monthPinned ? "Pinned" : "Pin month"}
          </button>
        </div>
      </div>

      {/* ── The hero ─────────────────────────────────────────────────────────
          One figure, the sentence that qualifies it, and the same ratio drawn
          flush to the card's bottom edge — the avalanche hero's shape, which is
          the strongest anchor the app has. The old page's biggest type was a
          `Stat` inside a five-up grid, so nothing on it was the point. */}
      {plan && (
        <section className={card} data-testid="budget-hero">
          <div className="flex flex-col gap-4 px-5 pb-5 pt-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <div className={fieldLabel}>Planned this month</div>
              <div
                className="mt-1 font-mono text-hero font-semibold leading-none tabular-nums text-brand-navy"
                data-testid="hero-planned"
              >
                <MoneyText countUp amount={plannedTotal} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-label text-neutral-500">
                <span data-testid="hero-basis">
                  {plannedIncome > 0
                    ? `${committedPct}% of ${formatCurrency(plannedIncome)} income · bills and debt payments`
                    : "bills and debt payments"}
                </span>
                <Help>
                  Bills plus debt payments, and nothing else. The allowance is
                  already inside the bills that fund it, and envelopes planned
                  by hand are listed but not added — so the same dollar is only
                  counted once.
                </Help>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Stat
                index={0}
                data-testid="tile-spent"
                label="Spent so far"
                value={formatCurrency(actualTotal)}
                hint={`of ${formatCurrency(plannedTotal)} planned`}
              />
              <Stat
                index={1}
                data-testid="tile-left-to-earn"
                label="Left over"
                value={formatCurrency(Number(plan.net))}
                tone={Number(plan.net) < 0 ? "bad" : "navy"}
                hint="income less the plan"
              />
              <Stat
                index={2}
                data-testid="tile-income"
                label="Income"
                value={formatCurrency(plannedIncome)}
                hint={`${formatCurrency(plan.income.actual)} in so far`}
              />
            </div>
          </div>
          {/* The ratio, drawn. Flush to the bottom edge — no radius, no gap. */}
          <div
            className="h-1.5 w-full bg-platinum-4"
            role="img"
            aria-label={`${committedPct} percent of income is committed`}
          >
            <div
              className={`bar-sweep h-full ${overCommitted ? "bg-bad" : "bg-brand-navy"}`}
              style={{ width: `${committedPct}%` }}
              data-testid="hero-committed-bar"
            />
          </div>
        </section>
      )}

      {plan && allowance && (
        <PlanStrip
          plan={plan}
          allowanceActual={Number(allowance.actual)}
          allowancePlanned={Number(allowance.planned)}
        />
      )}

      {/* ── The sections, by source ──────────────────────────────────────── */}
      {PLAN_SECTIONS.map((section, i) => (
        <PlanSection
          key={section.key}
          def={section}
          index={i}
          bucket={plan?.[section.key]}
          lines={bySource[section.key]}
          renderLine={(line) => (
            <BudgetLineRow
              key={line.categoryId}
              line={line}
              monthPinned={monthPinned}
              monthStart={currentMonth}
              onUpdatePlanned={handleUpdatePlanned}
              onAutoPinLine={handleAutoPinLine}
              // ⚠️ DELETE ONLY WHERE DELETE MEANS SOMETHING. A bill-backed or
              // debt-backed row is rebuilt from its source on the next read, so
              // deleting it only un-files its transactions for a moment and then
              // the row comes back. Those are managed on Bills and Debts.
              onDelete={
                section.key === "unbacked"
                  ? (catId) => handleDeleteMyBudgetCategory(catId, line.actualAmount)
                  : undefined
              }
              onRename={section.key === "unbacked" ? handleRenameMyBudgetCategory : undefined}
              uncategorizedTxns={uncategorizedThisMonth}
              categoryRules={rulesByCategory.get(line.categoryId) ?? []}
              contributingTxns={txnsByCategoryThisMonth.get(line.categoryId) ?? []}
              onAssignTxn={handleAssignTxn}
              onReassignTxn={handleReassignTxn}
              allCategories={categories ?? []}
              assigning={updateTx.isPending}
              renaming={updateCat.isPending}
            />
          )}
          footer={
            section.key === "unbacked" ? (
              <AddEnvelope
                adding={addingFor === MY_BUDGET_GROUP}
                value={newName}
                onChange={setNewName}
                onCommit={() => handleAddCategory(MY_BUDGET_GROUP)}
                onOpen={() => {
                  setAddingFor(MY_BUDGET_GROUP);
                  setNewName("");
                }}
                onCancel={() => {
                  setAddingFor(null);
                  setNewName("");
                }}
                commitDisabled={!newName.trim() || createCat.isPending}
              />
            ) : null
          }
        />
      ))}

      {allowance && (
        <AllowanceCard
          allowance={allowance}
          rowGrid={ROW_GRID}
          index={PLAN_SECTIONS.length}
        />
      )}

      {summary && (
        <Foot data-testid="budget-basis-note">
          Every figure on this page is the server's, for {monthName}. Spend is
          what has cleared — {formatCurrency(summary.expenses.actual)} against
          all envelopes, of which {formatCurrency(actualTotal)} sits against the
          plan.
        </Foot>
      )}
    </div>
  );
}

/**
 * One source, one card. The head carries the source's name, its two figures
 * and the verdict IN WORDS — good is navy on this palette and so is "no
 * opinion", which means the colour cannot be the statement.
 */
function PlanSection({
  def,
  index,
  bucket,
  lines,
  renderLine,
  footer,
}: {
  def: PlanSectionDef;
  index: number;
  bucket: { planned: string; actual: string; lineCount: number } | undefined;
  lines: BudgetLine[];
  renderLine: (line: BudgetLine) => React.ReactNode;
  footer?: React.ReactNode;
}) {
  const planned = Number(bucket?.planned ?? 0);
  const actual = Number(bucket?.actual ?? 0);
  // An empty section with nothing to add is a card that says nothing. The
  // unbacked one stays put even when empty, because "nothing is planned by
  // hand" is the good outcome and worth being able to read.
  if (lines.length === 0 && def.key !== "unbacked") return null;
  const verdict = sectionVerdict(def.key, planned, actual);

  return (
    <section
      className={`${card} tile-in`}
      style={{ animationDelay: `calc(${Math.min(index, 12)} * var(--stagger))` }}
      data-testid={def.testId}
    >
      <div className={cardHead}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-title font-semibold text-brand-navy">
              {def.title}
            </span>
            {/* ⚠️ ONLY ON THE HAND-PLANNED CARD. Income is not in the expense
                plan either, but saying so there reads as a criticism of the
                paychecks rather than as the caveat it is. */}
            {def.key === "unbacked" && (
              <span className="chip gray" data-testid={`${def.testId}-not-in-plan`}>
                not in the plan
              </span>
            )}
          </div>
          <div className="text-micro text-neutral-400">{def.sub}</div>
        </div>
        <Help>{def.help}</Help>
        <div className="text-right">
          <div
            className="font-mono text-label font-semibold tabular-nums text-brand-navy"
            data-testid={`${def.testId}-planned`}
          >
            {formatCurrency(planned)}
          </div>
          <div className="font-mono text-micro tabular-nums text-neutral-400">
            {formatCurrency(actual)} in
          </div>
        </div>
        <span className={`chip ${verdict.tone}`} data-testid={`${def.testId}-verdict`}>
          {verdict.word}
        </span>
      </div>

      {lines.length === 0 ? (
        <div className={emptyNote}>Nothing planned by hand. Good.</div>
      ) : (
        <>
          <ColumnHeads />
          <div className="divide-y divide-brand-line/70">{lines.map(renderLine)}</div>
        </>
      )}

      {footer}
      <Foot>{def.foot}</Foot>
    </section>
  );
}

/** The one add control left on the page, and the only place a new envelope
 *  can be created — which is the point: an envelope with no bill behind it is
 *  the exception now, not the default way to plan. */
function AddEnvelope({
  adding,
  value,
  onChange,
  onCommit,
  onOpen,
  onCancel,
  commitDisabled,
}: {
  adding: boolean;
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onOpen: () => void;
  onCancel: () => void;
  commitDisabled: boolean;
}) {
  return (
    <div className="border-t border-brand-line px-4 py-2.5">
      {adding ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            autoFocus
            placeholder="New envelope name"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommit();
              if (e.key === "Escape") onCancel();
            }}
            className={`${inputControl} max-w-[16rem]`}
            data-testid="input-new-line-My budget"
          />
          <button
            type="button"
            className={btnSm}
            onClick={onCommit}
            disabled={commitDisabled}
            data-testid="button-confirm-add-My budget"
          >
            Add
          </button>
          <button type="button" className={btnSecondarySm} onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={btnLink}
          onClick={onOpen}
          data-testid="button-add-line-My budget"
        >
          <Plus className="h-3 w-3" /> Add envelope
        </button>
      )}
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
    const parsed = parseFloat(rawValue);
    if (Number.isFinite(parsed) && parsed === planned) return;
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
      <div className={`${num} pr-1.5 text-right text-neutral-700`}>
        {formatCurrency(line.plannedAmount)}
      </div>
    );
  }

  // ⭐ AN EDITABLE FIELD THAT DOES NOT LOOK LIKE A FORM. At rest it is the
  // same mono figure as the column beside it; the ring only appears under the
  // pointer, and the navy one on focus. A page of boxed number inputs reads as
  // data entry, and this is a table you mostly just read.
  // ⚠️ The `$` rides NEXT TO the field, not pinned to the far edge of the
  // column. Anchored left it left a visible gap in front of every short
  // figure, and it was the only money on the row whose symbol did not sit
  // against its digits.
  const input = (
    <div className="flex items-center justify-end gap-px">
      <span className="text-micro text-neutral-400">$</span>
      <input
        type="number"
        step="0.01"
        // ⚠️ Wide enough for a five-figure plan. At 4.75rem a mortgage line
        // rendered "1980.0" with the last digit clipped inside the field —
        // a budget that silently hides a digit is worse than no budget.
        className={`${inputInline} w-[5.5rem] text-right`}
        defaultValue={planned.toFixed(2)}
        key={`${line.categoryId}-${line.plannedAmount}`}
        onBlur={(e) => handleBlur(e.target.value)}
        data-testid={`input-planned-${line.categoryId}`}
      />
    </div>
  );

  if (!hasSourceInfo) {
    return <div className="flex items-center justify-end">{input}</div>;
  }

  return (
    <div className="group/planned flex items-center justify-end gap-0.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="press rounded-control p-1 text-neutral-400 hover:text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-navy/40 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover/planned:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
            title="Where did this amount come from?"
            data-testid={`button-planned-source-${line.categoryId}`}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        {/* ⭐ WHERE THE PROSE IS ALLOWED TO LIVE. The word diet demotes
            explanations, it does not delete them — and provenance is exactly
            the disclosure the drills-must-tie rule says a figure owes the
            reader. One hover away, in full sentences, is the right place for
            it; the row face keeps a number and a word. */}
        <PopoverContent className="w-80 p-3" align="end">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-label font-semibold text-brand-navy">
              {line.categoryName}
            </div>
            <div className={`${num} text-neutral-500`}>
              {formatCurrency(line.plannedAmount)}
            </div>
          </div>
          {kind === "pinned" && (
            <div className="space-y-2 text-micro text-neutral-500">
              <p>
                Pinned — it holds at this value instead of tracking the live
                Bills/Debts derivation. Unpin the month to let it track Bills
                and Debts again.
              </p>
              {(source?.bills ?? []).length > 0 && (
                <BillList bills={source!.bills} />
              )}
            </div>
          )}
          {kind === "derived" && (
            <p className="text-micro text-neutral-500">
              Pulled from the linked debt's current minimum payment. Edit this
              row to override; it will be auto-pinned so the override sticks.
            </p>
          )}
          {kind === "bills" && (
            <div className="space-y-2">
              <p className="text-micro text-neutral-500">
                Sum of {(source?.bills ?? []).length} bill
                {(source?.bills ?? []).length === 1 ? "" : "s"} linked to this
                category. Edit this row to override; it will be auto-pinned so
                the override sticks. Reassign a bill on the Bills page to
                change where it lands.
              </p>
              <BillList bills={source!.bills} />
            </div>
          )}
        </PopoverContent>
      </Popover>
      {input}
    </div>
  );
}

function BillList({ bills }: { bills: LinkedBillEntry[] }) {
  if (bills.length === 0) {
    return (
      <div className="py-1 text-micro text-neutral-400">
        No linked bills hit this month.
      </div>
    );
  }
  return (
    <div
      className="max-h-64 space-y-0.5 overflow-y-auto pr-1"
      data-testid="planned-source-bill-list"
    >
      {bills.map((b) => (
        <div
          key={b.id}
          className="flex items-start justify-between gap-2 rounded-control px-2 py-1.5 hover:bg-platinum-3"
          data-testid={`planned-source-bill-${b.id}`}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-label font-medium text-neutral-700">
              {b.name}
            </div>
            <div className="text-micro text-neutral-400">
              {b.frequency}
              {b.eventCount === 0
                ? " · no events this month"
                : b.eventCount > 1
                  ? ` · ${b.eventCount} events this month`
                  : ""}
            </div>
          </div>
          <div className={`${num} whitespace-nowrap text-neutral-700`}>
            {formatCurrency(b.amount)}
          </div>
        </div>
      ))}
    </div>
  );
}

// Single uncategorized-transaction row inside the inline-categorize popover.
// `highlight` adds a subtle navy tint when the row is in the "Suggested"
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
        "press flex w-full items-start justify-between gap-2 rounded-control px-2 py-1.5 text-left hover:bg-platinum-3 disabled:pointer-events-none disabled:opacity-50",
        highlight && "bg-ok-bg",
      )}
      data-testid={`button-assign-${tx.id}-to-${categoryId}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-label font-medium text-neutral-700">
          {tx.description}
        </div>
        <div className="text-micro text-neutral-400">
          {tx.occurredOn}
          {tx.source ? ` · ${tx.source}` : ""}
        </div>
      </div>
      {/* The minus sign already says which way the money went; spending the
          one alarm colour on every ordinary debit would leave nothing to say
          "this is wrong" with. */}
      <div className={`${num} whitespace-nowrap text-neutral-700`}>
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
        <button
          type="button"
          className="press -mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-neutral-400 hover:bg-neutral-100 hover:text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-navy/40 disabled:pointer-events-none disabled:opacity-50"
          disabled={assigning}
          onClick={(e) => e.stopPropagation()}
          title="Re-categorize this transaction"
          data-testid={`button-reassign-${tx.id}`}
          aria-label="Re-categorize this transaction"
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
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
  onAutoPinLine,
  onDelete,
  onRename,
  uncategorizedTxns,
  categoryRules,
  contributingTxns,
  onAssignTxn,
  onReassignTxn,
  allCategories,
  assigning,
  renaming,
}: {
  line: BudgetLineWithActual;
  monthPinned: boolean;
  monthStart: string;
  onUpdatePlanned: (categoryId: string, amount: string) => void;
  /** See `handleAutoPinLine` — this is how a typed override survives the next
   *  Bills/Debts recompute, not a user-facing pin control. */
  onAutoPinLine: (categoryId: string, currentlyPinned: boolean) => void;
  onDelete?: (id: string) => void;
  // (#692) Optional inline-rename hook. Provided only by the "My
  // budget" card; the bill-/debt-backed rows omit it so the pencil
  // affordance never appears on rows the server would reject the
  // rename for.
  onRename?: (categoryId: string, nextName: string) => void;
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
  // Under the palette rule good is the resting state, so only the wrong side
  // of the plan takes a colour — which is precisely why the figure needs the
  // chip beside it: navy and "no opinion" are the same navy.
  const diffColor = diff < 0 ? "text-bad" : "text-neutral-700";
  const state =
    diff === 0
      ? { word: "on plan", aria: "on plan" }
      : isIncome
        ? diff < 0
          ? { word: "short", aria: "short of plan" }
          : { word: "above plan", aria: "above plan" }
        : diff < 0
          ? { word: "over", aria: "over plan" }
          : { word: "left", aria: "under plan" };
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
      className={`group ${ROW_GRID} hover:bg-platinum-2`}
      data-testid={`row-budget-${line.categoryId}`}
      role="row"
    >
      <div className="min-w-0" role="cell">
        <div className="flex flex-wrap items-center gap-1.5">
          {renameDraft !== null && onRename ? (
            // (#692) Inline rename input — replaces the drill-down name
            // button while editing. Enter commits, Esc cancels, blur
            // commits if the value changed (so clicking away mirrors
            // Enter rather than dropping the edit silently).
            <input
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
              className={`${inputControl} max-w-[14rem] py-1`}
              data-testid={`input-rename-${line.categoryId}`}
            />
          ) : null}
          {renameDraft !== null && onRename ? null : (() => {
            const opensInAmex = drillDownHref.startsWith("/amex");
            const destLabel = opensInAmex ? "Amex" : "Transactions";
            return (
              <button
                type="button"
                className="press inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-body font-medium text-brand-navy hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-brand-navy/40"
                title={`View ${line.categoryName} transactions — Opens in ${destLabel}`}
                onClick={() => navigate(drillDownHref)}
                data-testid={`button-category-name-${line.categoryId}`}
                data-drilldown-target={opensInAmex ? "amex" : "transactions"}
              >
                <span className="truncate">{line.categoryName}</span>
                {/* Both marks are the same neutral: which ledger a drill opens
                    is a destination, not a verdict, so it must not spend a
                    palette colour. `aria-hidden` keeps the button's accessible
                    name exactly the category name. */}
                {opensInAmex ? (
                  <CreditCard
                    className="h-3 w-3 shrink-0 text-neutral-400"
                    aria-hidden="true"
                    data-testid={`icon-drilldown-amex-${line.categoryId}`}
                  />
                ) : (
                  <Landmark
                    className="h-3 w-3 shrink-0 text-neutral-400"
                    aria-hidden="true"
                    data-testid={`icon-drilldown-transactions-${line.categoryId}`}
                  />
                )}
              </button>
            );
          })()}
          {(line.sourceBreakdown ?? []).map((b) => (
            <span
              key={b.source}
              className="chip gray"
              title={`${b.count} txn${b.count === 1 ? "" : "s"} · ${formatCurrency(b.amount)}`}
              data-testid={`badge-source-${b.source.toLowerCase()}-${line.categoryId}`}
            >
              {b.source} · {b.count}
            </span>
          ))}
          {line.pinned && (
            <span
              className="text-neutral-400"
              title={
                monthPinned
                  ? "This month is pinned — every auto-pulled line is locked to its persisted planned amount."
                  : "This line is pinned to its persisted planned amount."
              }
              aria-label="Pinned"
              data-testid={`badge-pinned-${line.categoryId}`}
            >
              <Pin className="h-3 w-3" />
            </span>
          )}
          {/* #90 / #176 / #417 — inline categorize from Budget. Surfaces
              the teal "N matches" hint only when one or more
              uncategorized transactions match an existing rule for this
              category or contain the category name. Click to assign in
              one tap. The neutral "+N other" fallback was removed in
              #417 to keep rows compact. */}
          {suggestedTxns.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="chip info press cursor-pointer hover:brightness-95 focus-visible:ring-2 focus-visible:ring-brand-navy/40"
                  title={`${suggestedTxns.length} uncategorized transaction${suggestedTxns.length === 1 ? "" : "s"} look like ${line.categoryName} (rule or name match) — click to assign.`}
                  data-testid={`button-categorize-${line.categoryId}`}
                  data-suggested-count={suggestedTxns.length}
                >
                  {`${suggestedTxns.length} match${suggestedTxns.length === 1 ? "" : "es"}`}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-3" align="start">
                <div className="mb-2 text-label font-semibold text-brand-navy">
                  Assign to {line.categoryName}
                </div>
                <div
                  className="max-h-72 space-y-3 overflow-y-auto pr-1"
                  data-testid={`uncategorized-list-${line.categoryId}`}
                >
                  {suggestedTxns.length > 0 && (
                    <div>
                      <div className={`mb-1 ${headCell}`}>
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
                      <div className={`mb-1 ${headCell}`}>
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
                          <div className="pt-1 text-center text-micro text-neutral-400">
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
            <span
              className="chip gray ml-auto sm:ml-0"
              title="Edit this on the Avalanche page slider — both stay in sync."
            >
              Managed by Avalanche
            </span>
          ) : (
            <div className="ml-auto flex items-center gap-0.5 sm:ml-0">
              {/* (#692) Rename + reorder controls — only shown when the
                  parent wires up onRename — i.e. inside the "Not from a
                  bill" card, the only place a rename is legal (the server
                  rejects a rename on anything but sourceKind "manual"). It
                  mirrors the hover-fade pattern so it adds no visual noise
                  on the rest of the rows. */}
              {onRename && (
                <button
                  type="button"
                  className={rowIcon}
                  onClick={() => setRenameDraft(line.categoryName)}
                  disabled={renaming}
                  data-testid={`button-rename-${line.categoryId}`}
                  aria-label="Rename this envelope"
                  title="Rename this envelope"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  className={`${rowIcon} hover:bg-bad-bg hover:text-bad`}
                  onClick={() => onDelete(line.categoryId)}
                  data-testid={`button-delete-${line.categoryId}`}
                  aria-label="Delete this envelope"
                  title="Delete this envelope"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <Cell label="Plan">
        <PlannedAmountCell
          line={line}
          planned={planned}
          isAvalanchePayment={isAvalanchePayment}
          onUpdatePlanned={onUpdatePlanned}
          onPinLine={onAutoPinLine}
        />
      </Cell>
      <Cell label="Spent">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`press ${num} rounded px-1 py-0.5 text-neutral-700 hover:bg-neutral-100 hover:text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-navy/40`}
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
            {/* ⭐ THE DRILL TIES TO THE ROW THAT OPENED IT. The head restates
                the row's own actual beside the count, so a reader can see the
                list below sums to the figure they clicked. */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-label font-semibold text-brand-navy">
                {line.categoryName}
              </div>
              <div className={`${num} text-neutral-500`}>
                {contributingTxns.length} txn{contributingTxns.length === 1 ? "" : "s"} · {formatCurrency(line.actualAmount)}
              </div>
            </div>
            {contributingTxns.length === 0 ? (
              <div className="py-2 text-micro text-neutral-400">
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
                          className="flex items-start justify-between gap-2 rounded-control px-2 py-1.5 hover:bg-platinum-3"
                          data-testid={`actuals-row-${t.id}`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-label font-medium text-neutral-700">
                              {t.description}
                            </div>
                            <div className="text-micro text-neutral-400">
                              {t.occurredOn}
                              {(() => {
                                const lbl = friendlySourceLabel(t.source);
                                return lbl ? ` · ${lbl}` : "";
                              })()}
                            </div>
                          </div>
                          <div className="flex flex-col items-end whitespace-nowrap">
                            <div className={`${num} text-neutral-700`}>
                              {formatCurrency(amt)}
                            </div>
                            <div
                              className={`${num} text-neutral-400`}
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
                        className="mt-1 flex items-start justify-between gap-2 rounded-control border-t border-brand-line bg-platinum-3 px-2 py-1.5"
                        data-testid={`actuals-hidden-tail-${line.categoryId}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-micro font-semibold text-neutral-500">
                            + {hidden.length} earlier transaction{hidden.length === 1 ? "" : "s"}
                          </div>
                          <div className="text-micro text-neutral-400">
                            Included in the running total above
                          </div>
                        </div>
                        <div
                          className={`${num} text-neutral-500`}
                          data-testid={`actuals-hidden-tail-sum-${line.categoryId}`}
                        >
                          {formatCurrency(hiddenSum)}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <div className="mt-2 border-t border-brand-line pt-2">
                  <button
                    type="button"
                    className={btnLink}
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
              <div className="mt-2 space-y-1 border-t border-brand-line pt-2">
                {(line.sourceBreakdown ?? []).map((b) => (
                  <div
                    key={b.source}
                    className="flex items-center justify-between text-micro text-neutral-400"
                  >
                    <span>{b.source}</span>
                    <span className={num}>
                      {b.count} txn · {formatCurrency(b.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </Cell>

      {/* ── Used ── the bar and the ratio it draws. */}
      {/* ⚠️ The bar and its percentage stay ON ONE LINE. Stacking the number
          under the bar drops it off the row's shared baseline, so it no longer
          lines up with the plan, actual and difference figures beside it —
          which is the one thing a table of money has to get right. */}
      <Cell label="Used">
        <div className="flex w-full min-w-0 items-center gap-2">
          <CssFillMeter
            className="min-w-[2.5rem] flex-1"
            value={actual}
            ceiling={planned}
            title={`${formatCurrency(line.actualAmount)} of ${formatCurrency(
              line.plannedAmount,
            )} planned`}
          />
          <span className={`${num} w-[2.75rem] shrink-0 text-right text-neutral-500`}>
            {pct === null ? "—" : `${pct}%`}
          </span>
        </div>
      </Cell>

      {/* ── Left / over ── the figure, and the WORD for which side of the plan
          it falls on. The arrow that used to live here said "up" and "down",
          which is not the same statement as "over" and "left", and it said it
          in colour alone. */}
      <Cell label="Left / over">
        <div className="flex items-center gap-1.5 sm:flex-col sm:items-end sm:gap-0.5">
          <span className={`${num} font-medium ${diffColor}`}>
            {diff >= 0 ? "+" : ""}
            {formatCurrency(diff)}
          </span>
          {planned > 0 && (
            <span
              className={`chip ${diff < 0 ? "bad" : "gray"}`}
              aria-label={state.aria}
              data-testid={`pct-direction-${line.categoryId}`}
            >
              {state.word}
            </span>
          )}
        </div>
      </Cell>

    {contributingTxns.length > 0 && (
      <div
        className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-micro text-neutral-400 tabular-nums sm:col-span-5"
        data-testid={`analysis-strip-${line.categoryId}`}
      >
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
          // Unchanged severity: burning through an envelope faster than the
          // calendar has always been a WATCH here, never an alarm — the month
          // can still end inside plan. Grey for that, navy for comfortably
          // behind, and the label carries the meaning either way.
          const paceTone =
            Math.abs(aheadBy) <= 5 ? "gray" : aheadBy > 0 ? "warn" : "ok";
          return (
            <span
              className={`chip ${paceTone}`}
              data-testid={`analysis-pace-${line.categoryId}`}
            >
              {paceLabel}
            </span>
          );
        })()}
      </div>
    )}
    </div>
  );
}
