import { useMemo, useState } from "react";
import { useListMappingRules, useCreateMappingRule, useDeleteMappingRule, useListCategories, getListMappingRulesQueryKey } from "@workspace/api-client-react";
import type { MappingRule, Category } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function MappingRulesPage() {
  const { data: rules, isLoading: rulesLoading } = useListMappingRules();
  const { data: categories, isLoading: catsLoading } = useListCategories();

  const createRule = useCreateMappingRule();
  const deleteRule = useDeleteMappingRule();

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState("contains");
  const [categoryId, setCategoryId] = useState("");

  const handleAddRule = () => {
    if (!pattern || !categoryId) return;
    createRule.mutate({ data: { pattern, matchType, categoryId, priority: 10 } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMappingRulesQueryKey() });
        setPattern("");
        toast({ title: "Rule added" });
      }
    });
  };

  const handleDeleteRule = (id: string) => {
    deleteRule.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMappingRulesQueryKey() });
        toast({ title: "Rule deleted" });
      }
    });
  };

  const grouped = useMemo(() => {
    const byCat = new Map<string, { category: Category | null; rules: MappingRule[] }>();
    const catById = new Map<string, Category>();
    for (const c of categories ?? []) catById.set(c.id, c);
    for (const r of rules ?? []) {
      const key = r.categoryId ?? "__uncat__";
      if (!byCat.has(key)) {
        byCat.set(key, {
          category: r.categoryId ? catById.get(r.categoryId) ?? null : null,
          rules: [],
        });
      }
      byCat.get(key)!.rules.push(r);
    }
    const arr = Array.from(byCat.entries()).map(([key, v]) => ({
      key,
      name: v.category?.name ?? "Uncategorized",
      rules: v.rules,
    }));
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [rules, categories]);

  if (rulesLoading || catsLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Mapping Rules</h1>
        <p className="text-muted-foreground mt-1">
          Auto-categorize transactions based on description patterns. New rules
          are added automatically when you categorize a transaction.
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
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">Contains</SelectItem>
                  <SelectItem value="exact">Equals Exactly</SelectItem>
                  <SelectItem value="starts_with">Starts With</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-[2] w-full space-y-1">
              <label className="text-xs font-medium">Text Pattern</label>
              <Input placeholder="e.g. STARBUCKS" value={pattern} onChange={e => setPattern(e.target.value)} />
            </div>
            <div className="flex-1 w-full space-y-1">
              <label className="text-xs font-medium">Assign to Category</label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger><SelectValue placeholder="Select Category" /></SelectTrigger>
                <SelectContent>
                  {categories?.map(cat => (
                    <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full md:w-auto" onClick={handleAddRule} disabled={!pattern || !categoryId || createRule.isPending}>
              <Plus className="w-4 h-4 mr-2" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {grouped.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No mapping rules yet. Categorize a transaction on the Chase page and a rule will be created automatically.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {grouped.map((g) => (
            <Card key={g.key} data-testid={`rule-group-${g.key}`}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{g.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {g.rules.length} {g.rules.length === 1 ? "rule" : "rules"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-64 overflow-y-auto divide-y divide-border">
                  {g.rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/30"
                      data-testid={`rule-row-${rule.id}`}
                    >
                      <span className="font-mono text-xs bg-muted/60 px-2 py-0.5 rounded truncate flex-1">
                        {rule.pattern}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                        {rule.matchType.replace("_", " ")}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleDeleteRule(rule.id)}
                        data-testid={`rule-delete-${rule.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
