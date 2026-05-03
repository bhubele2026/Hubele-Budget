import { useMemo, useState } from "react";
import {
  useListTransactions,
  useListCategories,
  useUpdateTransaction,
  useCreateMappingRule,
  getListTransactionsQueryKey,
  getListMappingRulesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Wand2, Check, CreditCard, Landmark } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { CategoryPicker } from "@/components/category-picker";

type RuleSeed = {
  txnId: string;
  description: string;
  categoryId: string;
};

export default function ReviewPage() {
  const { data: txns, isLoading } = useListTransactions({
    uncategorized: true,
    excludeTransfers: true,
    limit: 5000,
  });
  const { data: categories, isLoading: catsLoading } = useListCategories();
  const updateTxn = useUpdateTransaction();
  const createRule = useCreateMappingRule();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [bulkCategory, setBulkCategory] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ruleSeed, setRuleSeed] = useState<RuleSeed | null>(null);
  const [rulePattern, setRulePattern] = useState("");
  const [ruleMatchType, setRuleMatchType] = useState("contains");
  const [ruleApplyExisting, setRuleApplyExisting] = useState(true);

  const queue = txns ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return queue;
    const q = search.toLowerCase();
    return queue.filter((t) => (t.description || "").toLowerCase().includes(q));
  }, [queue, search]);

  const allSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.id));

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((t) => t.id)));
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  };

  const assignOne = async (
    txnId: string,
    categoryId: string | null,
    rememberPattern?: string | null,
  ) => {
    if (!categoryId) return;
    try {
      await updateTxn.mutateAsync({
        id: txnId,
        data: {
          categoryId,
          ...(rememberPattern ? { rememberPattern } : {}),
        },
      });
      invalidate();
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(txnId);
        return next;
      });
      toast({
        title: rememberPattern ? "Categorized & remembered" : "Categorized",
        description: rememberPattern
          ? `Future "${rememberPattern}" transactions will auto-categorize.`
          : undefined,
      });
    } catch (e) {
      toast({
        title: "Couldn't categorize",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleBulkAssign = async () => {
    if (!bulkCategory || selected.size === 0) return;
    const ids = Array.from(selected);
    try {
      await Promise.all(
        ids.map((id) =>
          updateTxn.mutateAsync({ id, data: { categoryId: bulkCategory } }),
        ),
      );
      toast({ title: `Assigned ${ids.length} transactions` });
      setSelected(new Set());
      invalidate();
    } catch (err) {
      toast({
        title: "Bulk assign failed",
        description: String(err),
        variant: "destructive",
      });
    }
  };

  const openRuleDialog = (txn: { id: string; description: string | null }) => {
    const desc = (txn.description || "").trim();
    const firstToken = desc.split(/\s+/)[0] || desc;
    setRuleSeed({ txnId: txn.id, description: desc, categoryId: bulkCategory || "" });
    setRulePattern(firstToken.toUpperCase());
    setRuleMatchType("contains");
    setRuleApplyExisting(true);
  };

  const submitRule = async () => {
    if (!ruleSeed || !rulePattern || !ruleSeed.categoryId) return;
    try {
      await createRule.mutateAsync({
        data: {
          pattern: rulePattern,
          matchType: ruleMatchType,
          categoryId: ruleSeed.categoryId,
          priority: 10,
        },
      });
      qc.invalidateQueries({ queryKey: getListMappingRulesQueryKey() });

      if (ruleApplyExisting && queue) {
        const p = rulePattern.toLowerCase();
        const matches = queue.filter((t) => {
          const d = (t.description || "").toLowerCase();
          if (ruleMatchType === "exact") return d === p;
          if (ruleMatchType === "starts_with") return d.startsWith(p);
          return d.includes(p);
        });
        await Promise.all(
          matches.map((t) =>
            updateTxn.mutateAsync({
              id: t.id,
              data: { categoryId: ruleSeed.categoryId },
            }),
          ),
        );
        toast({
          title: "Rule created",
          description: `Auto-assigned ${matches.length} matching transactions.`,
        });
      } else {
        toast({ title: "Rule created" });
      }
      invalidate();
      setRuleSeed(null);
    } catch (err) {
      toast({
        title: "Could not create rule",
        description: String(err),
        variant: "destructive",
      });
    }
  };

  if (isLoading || catsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const sourceMeta = (source: string | null | undefined) => {
    const s = (source || "").toLowerCase();
    if (s.includes("amex")) {
      return {
        label: "Amex",
        icon: CreditCard,
        className: "border-blue-200 text-blue-700 bg-blue-50",
      } as const;
    }
    if (s.startsWith("plaid")) {
      return {
        label: s.replace("plaid:", "") || "Bank",
        icon: Landmark,
        className: "border-emerald-200 text-emerald-700 bg-emerald-50",
      } as const;
    }
    return {
      label: s || "manual",
      icon: Landmark,
      className: "border-slate-200 text-slate-700 bg-slate-50",
    } as const;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Review</h1>
        <p className="text-muted-foreground mt-1" data-testid="text-review-count">
          {queue.length} uncategorized transaction{queue.length === 1 ? "" : "s"} waiting for a category — every source, newest first.
        </p>
      </div>

      <Card>
        <CardContent className="p-4 flex flex-col md:flex-row gap-3 md:items-center">
          <Input
            placeholder="Search description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="md:max-w-xs"
            data-testid="input-search"
          />
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <Select value={bulkCategory} onValueChange={setBulkCategory}>
              <SelectTrigger className="w-56" data-testid="select-bulk-category">
                <SelectValue placeholder="Choose category..." />
              </SelectTrigger>
              <SelectContent>
                {(categories ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={handleBulkAssign}
              disabled={!bulkCategory || selected.size === 0 || updateTxn.isPending}
              data-testid="button-bulk-assign"
            >
              Assign {selected.size > 0 ? `(${selected.size})` : ""}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-12 gap-3 p-3 border-b border-border bg-muted/30 font-medium text-xs text-muted-foreground">
            <div className="col-span-1 flex items-center">
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                data-testid="checkbox-select-all"
              />
            </div>
            <div className="col-span-2">Date</div>
            <div className="col-span-4">Description</div>
            <div className="col-span-2 text-right">Amount</div>
            <div className="col-span-3 text-right">Category</div>
          </div>
          <div className="divide-y divide-border">
            {filtered.length === 0 && (
              <div className="p-8 text-center text-muted-foreground" data-testid="text-empty-state">
                {queue.length === 0
                  ? "Nothing to review — every transaction has a category. Nice."
                  : "No uncategorized transactions match your search."}
              </div>
            )}
            {filtered.map((t) => {
              const amt = parseFloat(t.amount);
              const isExpense = amt < 0;
              const meta = sourceMeta(t.source);
              const Icon = meta.icon;
              return (
                <div
                  key={t.id}
                  className="grid grid-cols-12 gap-3 p-3 items-center hover:bg-muted/10"
                  data-testid={`row-txn-${t.id}`}
                >
                  <div className="col-span-1">
                    <Checkbox
                      checked={selected.has(t.id)}
                      onCheckedChange={() => toggle(t.id)}
                      data-testid={`checkbox-${t.id}`}
                    />
                  </div>
                  <div className="col-span-2 text-sm">{t.occurredOn}</div>
                  <div className="col-span-4 text-sm">
                    <div className="font-medium truncate">{t.description}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="outline" className={`text-[10px] ${meta.className}`}>
                        <Icon className="w-3 h-3 mr-1" />
                        {meta.label}
                      </Badge>
                      {t.member && (
                        <span className="text-[11px] text-muted-foreground">
                          {t.member}
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className={`col-span-2 text-right font-mono text-sm ${isExpense ? "text-destructive" : "text-green-600 dark:text-green-400"}`}
                  >
                    {formatCurrency(t.amount)}
                  </div>
                  <div className="col-span-3 flex items-center justify-end gap-2">
                    <CategoryPicker
                      value={t.categoryId ?? null}
                      categories={categories ?? []}
                      description={t.description ?? ""}
                      onChange={(catId, pattern) => assignOne(t.id, catId, pattern)}
                      testId={`picker-${t.id}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Create rule from this transaction"
                      onClick={() => openRuleDialog(t)}
                      data-testid={`button-rule-${t.id}`}
                    >
                      <Wand2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!ruleSeed} onOpenChange={(o) => !o && setRuleSeed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create rule from transaction</DialogTitle>
            <DialogDescription>
              Future transactions matching this pattern will be auto-categorized.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">
              Source description:
              <div className="mt-1 font-mono bg-muted/50 px-2 py-1 rounded">
                {ruleSeed?.description}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Match type</label>
              <Select value={ruleMatchType} onValueChange={setRuleMatchType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">Contains</SelectItem>
                  <SelectItem value="starts_with">Starts with</SelectItem>
                  <SelectItem value="exact">Exact match</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Pattern</label>
              <Input
                value={rulePattern}
                onChange={(e) => setRulePattern(e.target.value)}
                data-testid="input-rule-pattern"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Category</label>
              <Select
                value={ruleSeed?.categoryId || ""}
                onValueChange={(v) =>
                  setRuleSeed((prev) => (prev ? { ...prev, categoryId: v } : prev))
                }
              >
                <SelectTrigger data-testid="select-rule-category">
                  <SelectValue placeholder="Choose category..." />
                </SelectTrigger>
                <SelectContent>
                  {(categories ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={ruleApplyExisting}
                onCheckedChange={(v) => setRuleApplyExisting(!!v)}
              />
              Also apply to existing uncategorized transactions
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRuleSeed(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitRule}
              disabled={!rulePattern || !ruleSeed?.categoryId || createRule.isPending}
              data-testid="button-save-rule"
            >
              <Check className="w-4 h-4 mr-1.5" />
              Create rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
