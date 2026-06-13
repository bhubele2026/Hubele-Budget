import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateTransaction,
  useUpdateTransaction,
  getListTransactionsQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import {
  SUB_BUCKETS,
  type SubBucket,
  useWeeklyBucketLabels,
} from "@/lib/weeklyBuckets";

type Part = { amount: string; weeklyBucket: SubBucket };

/**
 * Split one purchase across weekly allowance buckets (e.g. a store run that
 * was part alcohol, part groceries). Implemented WITHOUT a schema change: the
 * original row is reshaped into the first part and the remaining parts become
 * new manual rows. Every total already counts those rows, so no aggregation
 * needs to know about "splits". Children are created FIRST so a failure can
 * never leave money unaccounted for.
 */
export function SplitTransactionDialog({
  tx,
  open,
  onOpenChange,
}: {
  tx: Transaction | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const subLabels = useWeeklyBucketLabels();
  const createTx = useCreateTransaction();
  const updateTx = useUpdateTransaction();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const total = tx ? Math.abs(Number(tx.amount) || 0) : 0;
  const isExpense = tx ? Number(tx.amount) < 0 : true;
  const startBucket: SubBucket = (
    SUB_BUCKETS as readonly string[]
  ).includes(tx?.weeklyBucket ?? "")
    ? (tx!.weeklyBucket as SubBucket)
    : "groceries";

  const [parts, setParts] = useState<Part[]>([
    { amount: total.toFixed(2), weeklyBucket: startBucket },
    { amount: "0.00", weeklyBucket: "alcohol" },
  ]);

  // Re-seed when a different transaction opens.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (tx && seededFor !== tx.id) {
    setSeededFor(tx.id);
    setParts([
      { amount: total.toFixed(2), weeklyBucket: startBucket },
      { amount: "0.00", weeklyBucket: "alcohol" },
    ]);
  }

  const sum = parts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const remaining = Math.round((total - sum) * 100) / 100;
  const valid =
    Math.abs(remaining) < 0.01 &&
    parts.length >= 2 &&
    parts.every((p) => Number(p.amount) > 0);

  const signed = (amt: string) =>
    (isExpense ? "-" : "") + Math.abs(Number(amt) || 0).toFixed(2);

  const setPart = (i: number, patch: Partial<Part>) =>
    setParts((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const addPart = () =>
    setParts((prev) => [...prev, { amount: "0.00", weeklyBucket: "misc" }]);
  const removePart = (i: number) =>
    setParts((prev) => prev.filter((_, idx) => idx !== i));

  const apply = async () => {
    if (!tx || !valid) return;
    setSaving(true);
    try {
      // Children first (parts 2..N) — never lose money on a partial failure.
      for (const p of parts.slice(1)) {
        await createTx.mutateAsync({
          data: {
            occurredOn: tx.occurredOn,
            description: tx.displayName || tx.description,
            amount: signed(p.amount),
            categoryId: tx.categoryId ?? null,
            weeklyAllowance: true,
            weeklyBucket: p.weeklyBucket,
            account: tx.account ?? null,
            source: "manual",
            notes: `Split from ${tx.displayName || tx.description}`,
          },
        });
      }
      // Reshape the original into the first part — pin it to the weekly
      // bucket and clear the other allowance flags so it isn't counted twice.
      await updateTx.mutateAsync({
        id: tx.id,
        data: {
          amount: signed(parts[0].amount),
          weeklyAllowance: true,
          weeklyBucket: parts[0].weeklyBucket,
          monthlyAllowance: false,
          unplannedAllowance: false,
        },
      });
      qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      toast({ title: `Split into ${parts.length}` });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Couldn't split",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Split transaction</DialogTitle>
          <DialogDescription>
            {tx?.displayName || tx?.description} ·{" "}
            <span className="tabular-nums">{formatCurrency(total)}</span> —
            divide it across weekly buckets.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">$</span>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={p.amount}
                onChange={(e) => setPart(i, { amount: e.target.value })}
                className="h-8 w-28 tabular-nums"
                data-testid={`split-amount-${i}`}
              />
              <Select
                value={p.weeklyBucket}
                onValueChange={(v) => setPart(i, { weeklyBucket: v as SubBucket })}
              >
                <SelectTrigger className="h-8 flex-1 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUB_BUCKETS.map((s) => (
                    <SelectItem key={s} value={s} className="text-sm">
                      {subLabels[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {parts.length > 2 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => removePart(i)}
                  aria-label="Remove part"
                >
                  <Trash2 className="w-4 h-4 text-muted-foreground" />
                </Button>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={addPart}
          >
            <Plus className="w-3.5 h-3.5 mr-1" /> Add part
          </Button>
        </div>

        <div
          className={`text-sm tabular-nums ${
            Math.abs(remaining) < 0.01 ? "text-muted-foreground" : "text-destructive"
          }`}
        >
          {Math.abs(remaining) < 0.01
            ? "Splits add up. ✓"
            : `${formatCurrency(Math.abs(remaining))} ${remaining > 0 ? "left to allocate" : "over"}`}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!valid || saving}>
            {saving ? "Splitting…" : "Split it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
