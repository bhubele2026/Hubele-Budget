import { useMemo, useState } from "react";
import { useListMappingRules, useCreateMappingRule, useUpdateMappingRule, useDeleteMappingRule, useListCategories, getListMappingRulesQueryKey } from "@workspace/api-client-react";
import type { MappingRule, Category } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, Search, Pencil, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function MappingRulesPage() {
  const { data: rules, isLoading: rulesLoading } = useListMappingRules();
  const { data: categories, isLoading: catsLoading } = useListCategories();

  const createRule = useCreateMappingRule();
  const updateRule = useUpdateMappingRule();
  const deleteRule = useDeleteMappingRule();

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState("contains");
  const [categoryId, setCategoryId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPattern, setEditPattern] = useState("");
  const [editMatchType, setEditMatchType] = useState("contains");
  const [editCategoryId, setEditCategoryId] = useState("");

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

  const startEdit = (rule: MappingRule) => {
    setEditingId(rule.id);
    setEditPattern(rule.pattern);
    setEditMatchType(rule.matchType);
    setEditCategoryId(rule.categoryId ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = (id: string) => {
    if (!editPattern || !editCategoryId) return;
    updateRule.mutate(
      {
        id,
        data: {
          pattern: editPattern,
          matchType: editMatchType,
          categoryId: editCategoryId,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMappingRulesQueryKey() });
          setEditingId(null);
          toast({ title: "Rule updated" });
        },
        onError: (e) => {
          toast({
            title: "Couldn't update rule",
            description: (e as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

  const catById = useMemo(() => {
    const m = new Map<string, Category>();
    for (const c of categories ?? []) m.set(c.id, c);
    return m;
  }, [categories]);

  const grouped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filteredRules = (rules ?? []).filter((r) => {
      if (!q) return true;
      const catName = catById.get(r.categoryId ?? "")?.name ?? "";
      return r.pattern.toLowerCase().includes(q) || catName.toLowerCase().includes(q);
    });

    const byCat = new Map<string, { category: Category | null; rules: MappingRule[] }>();
    for (const r of filteredRules) {
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
  }, [rules, categories, catById, searchQuery]);

  const totalFiltered = grouped.reduce((s, g) => s + g.rules.length, 0);

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

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search rules by pattern or category..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-rules"
        />
        {searchQuery && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {totalFiltered} result{totalFiltered === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {grouped.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            {searchQuery
              ? "No rules match your search."
              : "No mapping rules yet. Categorize a transaction on the Chase page and a rule will be created automatically."}
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
                    editingId === rule.id ? (
                      <div key={rule.id} className="flex flex-col gap-2 px-4 py-3 bg-muted/20" data-testid={`rule-edit-${rule.id}`}>
                        <Input
                          value={editPattern}
                          onChange={(e) => setEditPattern(e.target.value)}
                          className="h-7 text-xs font-mono"
                          autoFocus
                        />
                        <div className="flex items-center gap-2">
                          <Select value={editMatchType} onValueChange={setEditMatchType}>
                            <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="contains">Contains</SelectItem>
                              <SelectItem value="exact">Exact</SelectItem>
                              <SelectItem value="starts_with">Starts With</SelectItem>
                            </SelectContent>
                          </Select>
                          <Select value={editCategoryId} onValueChange={setEditCategoryId}>
                            <SelectTrigger className="h-7 text-xs flex-[2]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {categories?.map(cat => (
                                <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => saveEdit(rule.id)}
                            disabled={!editPattern || !editCategoryId || updateRule.isPending}
                            data-testid={`rule-save-${rule.id}`}
                          >
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={cancelEdit}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ) : (
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
                          onClick={() => startEdit(rule)}
                          data-testid={`rule-edit-btn-${rule.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                        </Button>
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
                    )
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
