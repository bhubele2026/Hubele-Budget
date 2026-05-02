import { useState } from "react";
import { useListMappingRules, useCreateMappingRule, useDeleteMappingRule, useListCategories, getListMappingRulesQueryKey } from "@workspace/api-client-react";
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

  if (rulesLoading || catsLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  const getCategoryName = (id: string | null | undefined) => {
    if (!id) return "None";
    return categories?.find(c => c.id === id)?.name || "Unknown";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Mapping Rules</h1>
        <p className="text-muted-foreground mt-1">Auto-categorize transactions based on description patterns.</p>
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

      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-12 gap-4 p-4 border-b border-border bg-muted/30 font-medium text-sm text-muted-foreground">
            <div className="col-span-3">Match Type</div>
            <div className="col-span-5">Pattern</div>
            <div className="col-span-3">Category</div>
            <div className="col-span-1"></div>
          </div>
          <div className="divide-y divide-border">
            {rules?.map(rule => (
              <div key={rule.id} className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-muted/10">
                <div className="col-span-3 text-sm capitalize">{rule.matchType.replace('_', ' ')}</div>
                <div className="col-span-5 font-mono text-sm bg-muted/50 px-2 py-1 rounded w-max">{rule.pattern}</div>
                <div className="col-span-3 text-sm font-medium">{getCategoryName(rule.categoryId)}</div>
                <div className="col-span-1 flex justify-end">
                  <Button variant="ghost" size="icon" onClick={() => handleDeleteRule(rule.id)}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
            {rules?.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">No mapping rules created yet.</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
