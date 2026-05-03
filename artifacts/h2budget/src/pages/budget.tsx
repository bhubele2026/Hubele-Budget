import { useState, useEffect, useMemo, useRef } from "react";
import {
  useGetBudgetMonth,
  useUpsertBudgetLine,
  useListCategories,
  useCreateCategory,
  useDeleteCategory,
  useSeedDefaultBudget,
  getGetBudgetMonthQueryKey,
  getListCategoriesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type SourceBreakdownEntry = {
  source: "Bank" | "Amex" | "Other";
  count: number;
  amount: string;
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
  sourceBreakdown?: SourceBreakdownEntry[] | null;
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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

function thisMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function BudgetPage() {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const tm = thisMonthStart();
    return tm < MIN_MONTH ? MIN_MONTH : tm;
  });

  const { data: budgetData, isLoading: isLoadingBudget } =
    useGetBudgetMonth(currentMonth);
  const { data: categories, isLoading: isLoadingCategories } =
    useListCategories();

  const upsertLine = useUpsertBudgetLine();
  const createCat = useCreateCategory();
  const deleteCat = useDeleteCategory();
  const seedDefaults = useSeedDefaultBudget();

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) return;
    if (isLoadingCategories) return;
    if ((categories?.length ?? 0) > 0) return;
    seededRef.current = true;
    seedDefaults.mutate(undefined, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        queryClient.invalidateQueries({
          queryKey: getGetBudgetMonthQueryKey(currentMonth),
        });
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
    const d = new Date(currentMonth);
    d.setMonth(d.getMonth() + offset);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    setCurrentMonth(next < MIN_MONTH ? MIN_MONTH : next);
  };

  const atFloor = currentMonth <= MIN_MONTH;

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getGetBudgetMonthQueryKey(currentMonth),
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

  const monthName = useMemo(() => {
    const d = new Date(currentMonth + "T00:00:00");
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(d);
  }, [currentMonth]);

  if (isLoadingBudget || isLoadingCategories) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const groups = budgetData?.groups ?? [];
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
                          No categories in this group yet.
                        </div>
                      )}
                      {group.lines.map((line) => (
                        <BudgetLineRow
                          key={line.categoryId}
                          line={line}
                          onUpdatePlanned={handleUpdatePlanned}
                          onDelete={handleDeleteCategory}
                        />
                      ))}
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
      </div>
    </div>
  );
}

function BudgetLineRow({
  line,
  onUpdatePlanned,
  onDelete,
}: {
  line: BudgetLineWithActual;
  onUpdatePlanned: (categoryId: string, amount: string) => void;
  onDelete: (id: string) => void;
}) {
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
  const isReadOnly = sourceKind !== "manual";

  return (
    <div
      className="group grid grid-cols-12 gap-4 px-4 py-3 items-center hover:bg-muted/10"
      data-testid={`row-budget-${line.categoryId}`}
    >
      <div className="col-span-12 md:col-span-5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate">{line.categoryName}</span>
          {sourceKind !== "manual" && <SourceBadge kind={sourceKind} />}
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
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 ml-auto md:ml-0 text-muted-foreground hover:text-foreground transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
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
        {line.note && (
          <div className="text-xs text-muted-foreground mt-0.5">
            {line.note}
          </div>
        )}
      </div>
      <div className="col-span-3 md:col-span-2 text-right">
        {isReadOnly ? (
          <div className="font-mono text-sm py-2 pr-3">
            {formatCurrency(line.plannedAmount)}
          </div>
        ) : (
          <Input
            type="number"
            step="1"
            className="h-8 text-right bg-transparent border-transparent hover:border-input focus:bg-background font-mono"
            defaultValue={planned.toString()}
            onBlur={(e) => {
              if (e.target.value !== planned.toString()) {
                onUpdatePlanned(line.categoryId, e.target.value);
              }
            }}
            data-testid={`input-planned-${line.categoryId}`}
          />
        )}
      </div>
      <div className="col-span-3 md:col-span-2 text-right font-mono text-sm">
        {formatCurrency(line.actualAmount)}
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
  );
}
