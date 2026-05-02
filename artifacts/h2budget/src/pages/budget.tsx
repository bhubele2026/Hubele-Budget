import { useState, useEffect } from "react";
import { useGetBudgetMonth, useUpsertBudgetLine, useListCategories, useCreateCategory, useDeleteCategory, getGetBudgetMonthQueryKey, getListCategoriesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function BudgetPage() {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });

  const { data: budgetData, isLoading: isLoadingBudget } = useGetBudgetMonth(currentMonth);
  const { data: categories, isLoading: isLoadingCategories } = useListCategories();
  
  const upsertLine = useUpsertBudgetLine();
  const createCat = useCreateCategory();
  const deleteCat = useDeleteCategory();
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [newCatName, setNewCatName] = useState("");

  const changeMonth = (offset: number) => {
    const d = new Date(currentMonth);
    d.setMonth(d.getMonth() + offset);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
  };

  const handleUpdatePlanned = (categoryId: string, amountStr: string) => {
    upsertLine.mutate({ data: { monthStart: currentMonth, categoryId, plannedAmount: amountStr || "0" } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBudgetMonthQueryKey(currentMonth) });
      }
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
          queryClient.invalidateQueries({ queryKey: getGetBudgetMonthQueryKey(currentMonth) });
          toast({ title: "Category deleted" });
        }
      });
    }
  };

  if (isLoadingBudget || isLoadingCategories) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  const d = new Date(currentMonth + "T00:00:00");
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(d);

  // Merge budget lines with all categories to show zeroes
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
          <p className="text-muted-foreground mt-1">Planned vs Actual.</p>
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
            <div className="col-span-4">Category</div>
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

              return (
                <div key={line.categoryId} className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-muted/10">
                  <div className="col-span-4 font-medium flex items-center justify-between">
                    <span>{line.categoryName}</span>
                    <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:opacity-100" onClick={() => handleDeleteCategory(line.categoryId)}>
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
