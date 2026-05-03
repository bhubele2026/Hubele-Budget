import { useState, useEffect, useMemo } from "react";
import {
  useGetBudgetMonth,
  useUpsertBudgetLine,
  useListCategories,
  useCreateCategory,
  useDeleteCategory,
  useListTransactions,
  useUpdateTransaction,
  getGetBudgetMonthQueryKey,
  getListCategoriesQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  CheckCircle2,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Txn = {
  id: string;
  description: string | null;
  amount: string;
  occurredOn: string;
  source: string | null;
  categoryId: string | null;
};

function tokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 4),
  );
}

export default function BudgetPage() {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });

  const { data: budgetData, isLoading: isLoadingBudget } = useGetBudgetMonth(currentMonth);
  const { data: categories, isLoading: isLoadingCategories } = useListCategories();

  // Pull this month's transactions for expansion suggestions
  const monthEnd = useMemo(() => {
    const d = new Date(currentMonth + "T00:00:00");
    const e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}`;
  }, [currentMonth]);

  const { data: monthTxns } = useListTransactions({
    from: currentMonth,
    to: monthEnd,
    limit: 1000,
  });

  const upsertLine = useUpsertBudgetLine();
  const createCat = useCreateCategory();
  const deleteCat = useDeleteCategory();
  const updateTxn = useUpdateTransaction();

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [newCatName, setNewCatName] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const changeMonth = (offset: number) => {
    const d = new Date(currentMonth);
    d.setMonth(d.getMonth() + offset);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetBudgetMonthQueryKey(currentMonth) });
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  };

  const handleUpdatePlanned = (categoryId: string, amountStr: string) => {
    upsertLine.mutate({ data: { monthStart: currentMonth, categoryId, plannedAmount: amountStr || "0" } }, {
      onSuccess: () => invalidate(),
    });
  };

  const handleAddCategory = () => {
    if (!newCatName) return;
    createCat.mutate({ data: { name: newCatName, kind: "expense", sortOrder: 0 } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        setNewCatName("");
        toast({ title: "Category added" });
      }
    });
  };

  const handleDeleteCategory = (id: string) => {
    if (confirm("Delete this category?")) {
      deleteCat.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
          invalidate();
          toast({ title: "Category deleted" });
        }
      });
    }
  };

  const assignTxn = (txnId: string, categoryId: string | null) => {
    updateTxn.mutate(
      { id: txnId, data: { categoryId } },
      { onSuccess: () => invalidate() },
    );
  };

  // Build assigned + suggested per category
  const { assignedByCat, suggestedByCat } = useMemo(() => {
    const all: Txn[] = (monthTxns ?? []) as Txn[];
    const assigned = new Map<string, Txn[]>();
    const suggested = new Map<string, Txn[]>();
    const cats = categories ?? [];

    for (const t of all) {
      if (t.categoryId) {
        const arr = assigned.get(t.categoryId) ?? [];
        arr.push(t);
        assigned.set(t.categoryId, arr);
      }
    }

    // Build per-category token vocabulary from already-assigned txns + the category name itself
    const catTokens = new Map<string, Set<string>>();
    for (const c of cats) {
      const set = new Set<string>(tokens(c.name));
      const list = assigned.get(c.id) ?? [];
      for (const t of list) {
        for (const w of tokens(t.description)) set.add(w);
      }
      catTokens.set(c.id, set);
    }

    const uncats = all.filter((t) => !t.categoryId);
    for (const c of cats) {
      const vocab = catTokens.get(c.id);
      if (!vocab || vocab.size === 0) continue;
      const matches: Txn[] = [];
      for (const t of uncats) {
        const ttok = tokens(t.description);
        let hit = false;
        for (const w of ttok) {
          if (vocab.has(w)) {
            hit = true;
            break;
          }
        }
        if (hit) matches.push(t);
      }
      if (matches.length > 0) {
        suggested.set(
          c.id,
          matches.slice(0, 8),
        );
      }
    }

    return { assignedByCat: assigned, suggestedByCat: suggested };
  }, [monthTxns, categories]);

  if (isLoadingBudget || isLoadingCategories) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  const d = new Date(currentMonth + "T00:00:00");
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(d);

  const lineMap = new Map((budgetData?.lines || []).map(l => [l.categoryId, l]));
  const displayLines = (categories || []).map(cat => {
    const line = lineMap.get(cat.id);
    return {
      categoryId: cat.id,
      categoryName: cat.name,
      plannedAmount: line?.plannedAmount || "0",
      actualAmount: line?.actualAmount || "0",
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Budget</h1>
          <p className="text-muted-foreground mt-1">Planned vs Actual. Click a row to assign transactions.</p>
        </div>
        <div className="flex items-center gap-4 bg-card px-4 py-2 rounded-md shadow-sm border border-border">
          <Button variant="ghost" size="icon" onClick={() => changeMonth(-1)}><ChevronLeft className="w-5 h-5" /></Button>
          <span className="font-medium text-lg w-32 text-center">{monthName}</span>
          <Button variant="ghost" size="icon" onClick={() => changeMonth(1)}><ChevronRight className="w-5 h-5" /></Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-12 gap-4 p-4 border-b border-border bg-muted/30 font-medium text-sm text-muted-foreground">
            <div className="col-span-1"></div>
            <div className="col-span-3">Category</div>
            <div className="col-span-3 text-right">Planned</div>
            <div className="col-span-3 text-right">Actual</div>
            <div className="col-span-2 text-right">Diff</div>
          </div>
          <div className="divide-y divide-border">
            {displayLines.map(line => {
              const planned = parseFloat(line.plannedAmount) || 0;
              const actual = parseFloat(line.actualAmount) || 0;
              const diff = planned - actual;
              const diffColor = diff < 0 ? "text-destructive" : diff > 0 ? "text-green-600 dark:text-green-400" : "text-muted-foreground";
              const isOpen = expanded.has(line.categoryId);
              const assignedTxns = assignedByCat.get(line.categoryId) ?? [];
              const suggestedTxns = suggestedByCat.get(line.categoryId) ?? [];

              return (
                <div key={line.categoryId} data-testid={`row-budget-${line.categoryId}`}>
                  <div className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-muted/10">
                    <div className="col-span-1 flex justify-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => toggleExpand(line.categoryId)}
                        data-testid={`button-expand-${line.categoryId}`}
                      >
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                    <div className="col-span-3 font-medium flex items-center justify-between gap-2">
                      <span className="truncate">{line.categoryName}</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleDeleteCategory(line.categoryId)}>
                        <Trash2 className="w-3 h-3 text-destructive" />
                      </Button>
                    </div>
                    <div className="col-span-3 text-right">
                      <Input
                        type="number"
                        step="1"
                        className="h-8 text-right bg-transparent border-transparent hover:border-input focus:bg-background"
                        defaultValue={parseFloat(line.plannedAmount).toString()}
                        onBlur={(e) => {
                          if (e.target.value !== parseFloat(line.plannedAmount).toString()) {
                            handleUpdatePlanned(line.categoryId, e.target.value);
                          }
                        }}
                      />
                    </div>
                    <div className="col-span-3 text-right font-mono text-sm py-1">
                      {formatCurrency(line.actualAmount)}
                    </div>
                    <div className={`col-span-2 text-right font-mono text-sm font-medium ${diffColor} py-1`}>
                      {diff >= 0 ? "+" : ""}{formatCurrency(diff)}
                    </div>
                  </div>

                  {isOpen && (
                    <div className="bg-muted/10 border-t border-border px-6 py-4 space-y-4">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                          Assigned ({assignedTxns.length})
                        </div>
                        {assignedTxns.length === 0 ? (
                          <div className="text-sm text-muted-foreground italic">
                            No transactions assigned to this category yet.
                          </div>
                        ) : (
                          <ul className="space-y-1">
                            {assignedTxns.map((t) => (
                              <li
                                key={t.id}
                                className="flex items-center gap-3 text-sm py-1"
                                data-testid={`assigned-${t.id}`}
                              >
                                <span className="text-xs text-muted-foreground w-20 shrink-0">{t.occurredOn}</span>
                                <span className="flex-1 truncate">{t.description}</span>
                                <span
                                  className={cn(
                                    "font-mono w-24 text-right shrink-0",
                                    parseFloat(t.amount) < 0
                                      ? "text-destructive"
                                      : "text-green-600 dark:text-green-400",
                                  )}
                                >
                                  {formatCurrency(t.amount)}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  title="Unassign"
                                  onClick={() => assignTxn(t.id, null)}
                                  data-testid={`button-unassign-${t.id}`}
                                >
                                  <X className="w-3.5 h-3.5 text-muted-foreground" />
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {suggestedTxns.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                            Suggested ({suggestedTxns.length})
                          </div>
                          <ul className="space-y-1">
                            {suggestedTxns.map((t) => (
                              <li
                                key={t.id}
                                className="flex items-center gap-3 text-sm py-1"
                                data-testid={`suggested-${t.id}`}
                              >
                                <span className="text-xs text-muted-foreground w-20 shrink-0">{t.occurredOn}</span>
                                <span className="flex-1 truncate">{t.description}</span>
                                <span
                                  className={cn(
                                    "font-mono w-24 text-right shrink-0",
                                    parseFloat(t.amount) < 0
                                      ? "text-destructive"
                                      : "text-green-600 dark:text-green-400",
                                  )}
                                >
                                  {formatCurrency(t.amount)}
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7"
                                  onClick={() => assignTxn(t.id, line.categoryId)}
                                  disabled={updateTxn.isPending}
                                  data-testid={`button-assign-suggested-${t.id}`}
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                                  Assign
                                </Button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="p-4 border-t border-border flex items-center gap-2">
            <Input
              placeholder="New Category Name"
              className="max-w-xs"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
            />
            <Button variant="secondary" onClick={handleAddCategory} disabled={!newCatName || createCat.isPending}>
              <Plus className="w-4 h-4 mr-2" /> Add Category
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
