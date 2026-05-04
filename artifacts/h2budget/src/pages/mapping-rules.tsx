import { useMemo, useState } from "react";
import {
  useListMappingRules,
  useCreateMappingRule,
  useUpdateMappingRule,
  useDeleteMappingRule,
  useReorderMappingRules,
  useTestMappingRules,
  useListCategories,
  getListMappingRulesQueryKey,
} from "@workspace/api-client-react";
import type { MappingRule, Category } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function MappingRulesPage() {
  const { data: rules, isLoading: rulesLoading } = useListMappingRules();
  const { data: categories, isLoading: catsLoading } = useListCategories();

  const createRule = useCreateMappingRule();
  const updateRule = useUpdateMappingRule();
  const deleteRule = useDeleteMappingRule();
  const reorderRules = useReorderMappingRules();
  const testRules = useTestMappingRules();

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState("contains");
  const [categoryId, setCategoryId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [testInput, setTestInput] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPattern, setEditPattern] = useState("");
  const [editMatchType, setEditMatchType] = useState("contains");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editPriority, setEditPriority] = useState<string>("");

  const invalidateRules = () =>
    queryClient.invalidateQueries({ queryKey: getListMappingRulesQueryKey() });

  const handleAddRule = () => {
    if (!pattern || !categoryId) return;
    // New manually-added rules go above any auto-learned ones (which top out
    // around priority 100) so the user's intent always wins. Reordering
    // afterwards rewrites priorities anyway.
    const topPriority = (rules ?? []).reduce(
      (m, r) => Math.max(m, r.priority),
      100,
    );
    createRule.mutate(
      {
        data: {
          pattern,
          matchType,
          categoryId,
          priority: topPriority + 10,
        },
      },
      {
        onSuccess: () => {
          invalidateRules();
          setPattern("");
          toast({ title: "Rule added" });
        },
      },
    );
  };

  const handleDeleteRule = (id: string) => {
    deleteRule.mutate(
      { id },
      {
        onSuccess: () => {
          invalidateRules();
          toast({ title: "Rule deleted" });
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
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = (id: string) => {
    if (!editPattern || !editCategoryId) return;
    const priorityNum = Number.parseInt(editPriority, 10);
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
          invalidateRules();
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

  const sorted = useMemo(() => {
    return [...(rules ?? [])].sort((a, b) => b.priority - a.priority);
  }, [rules]);

  const moveRule = (id: string, direction: -1 | 1) => {
    const idx = sorted.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= sorted.length) return;
    const nextOrder = [...sorted];
    const [item] = nextOrder.splice(idx, 1);
    nextOrder.splice(nextIdx, 0, item!);
    reorderRules.mutate(
      { data: { orderedIds: nextOrder.map((r) => r.id) } },
      {
        onSuccess: () => invalidateRules(),
        onError: (e) => {
          toast({
            title: "Couldn't reorder",
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

  const handleRunTest = () => {
    if (!testInput.trim()) return;
    testRules.mutate({ data: { description: testInput } });
  };

  const matchedIds = useMemo(() => {
    const data = testRules.data;
    if (!data) return new Set<string>();
    return new Set(data.matches.map((m) => m.rule.id));
  }, [testRules.data]);

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
            <div className="divide-y divide-border">
              {filtered.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground text-sm">
                  No rules match your search.
                </div>
              ) : (
                filtered.map((rule) => {
                  const idxInFull = sorted.findIndex((r) => r.id === rule.id);
                  const isFirst = idxInFull === 0;
                  const isLast = idxInFull === sorted.length - 1;
                  const cat = rule.categoryId
                    ? catById.get(rule.categoryId)
                    : null;
                  const isMatched = matchedIds.has(rule.id);
                  const isWinner = winningId === rule.id;
                  const reorderDisabled =
                    reorderRules.isPending || !!searchQuery;
                  return editingId === rule.id ? (
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
                            <SelectItem value="contains">Contains</SelectItem>
                            <SelectItem value="exact">Exact</SelectItem>
                            <SelectItem value="starts_with">
                              Starts With
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={editCategoryId}
                          onValueChange={setEditCategoryId}
                        >
                          <SelectTrigger className="h-8 text-xs flex-[2] min-w-[160px]">
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
                            onChange={(e) => setEditPriority(e.target.value)}
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
                    </div>
                  ) : (
                    <div
                      key={rule.id}
                      className={`flex items-center gap-2 px-4 py-2 hover:bg-muted/30 ${
                        isWinner
                          ? "bg-emerald-50 dark:bg-emerald-950/30"
                          : isMatched
                            ? "bg-amber-50 dark:bg-amber-950/20"
                            : ""
                      }`}
                      data-testid={`rule-row-${rule.id}`}
                    >
                      <div className="flex flex-col">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-6"
                          disabled={isFirst || reorderDisabled}
                          onClick={() => moveRule(rule.id, -1)}
                          data-testid={`rule-up-${rule.id}`}
                          title={
                            searchQuery
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
                          onClick={() => moveRule(rule.id, 1)}
                          data-testid={`rule-down-${rule.id}`}
                          title={
                            searchQuery
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
                          cat ? "" : "italic text-muted-foreground"
                        }`}
                        data-testid={`rule-category-${rule.id}`}
                      >
                        {cat?.name ?? "Uncategorized"}
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
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
