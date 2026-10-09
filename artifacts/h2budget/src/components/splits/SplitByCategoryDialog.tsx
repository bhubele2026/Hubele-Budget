import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetTransactionSplitsQueryKey,
  useDeleteTransactionSplits,
  useGetTransactionSplits,
  useReplaceTransactionSplits,
  type TransactionSplit,
} from "@workspace/api-client-react/features";
import { getListTransactionsQueryKey, type Transaction } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { shortDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { btn, btnLink, btnSecondary, input } from "@/ui";
import { MAX_PARTS, chargeCents, formatCents, parseCents, signedAmount, splitState, type SplitPart } from "@/lib/splitMath";

/**
 * ⭐ SPLIT BY CATEGORY — one charge across several budget categories. Rows of
 * category and amount; the line under them says how much is left to assign and
 * Save stays off until it reads $0.00 (Σ parts = the charge, to the cent).
 * Amounts are typed as plain magnitudes; the charge's own sign is put back
 * when they are sent. An existing split opens for editing; "Remove split"
 * puts the charge back whole. (F4; ported from h2's `SplitSheet`/`RowSheet`.)
 *
 * ⚠️ NOT THE ALLOWANCE-BUCKET SPLIT. Allowances can also split a purchase, but
 * across weekly buckets, by turning it into separate manual rows. This one
 * leaves the charge as one row and divides its amount between categories on
 * the server (`/transactions/{id}/splits`), so category totals follow the
 * parts. The two are labelled apart on screen.
 *
 * Cents show here because this is a detail dialog. The server re-checks the
 * parts against the charge and is the authority.
 */
type Cat = { id: string; name: string };

function Form({
  tx,
  categories,
  existing,
  onClose,
}: {
  tx: Transaction;
  categories: readonly Cat[];
  existing: readonly TransactionSplit[];
  onClose: () => void;
}) {
  const total = chargeCents(tx.amount);
  const [parts, setParts] = useState<SplitPart[]>(() =>
    existing.length >= 2
      ? existing.map((p) => ({ categoryId: p.categoryId, amount: formatCents(Math.abs(parseCents(p.amount) ?? 0)) }))
      : [
          { categoryId: tx.categoryId ?? "", amount: formatCents(total) },
          { categoryId: "", amount: "" },
        ],
  );
  const state = useMemo(() => splitState(total, parts), [total, parts]);
  const save = useReplaceTransactionSplits();
  const clear = useDeleteTransactionSplits();
  const qc = useQueryClient();

  const setPart = (i: number, patch: Partial<SplitPart>) => setParts((ps) => ps.map((p, at) => (at === i ? { ...p, ...patch } : p)));
  const settled = () => {
    void qc.invalidateQueries({ queryKey: getGetTransactionSplitsQueryKey(tx.id) });
    void qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/budget") });
  };

  const remainder =
    state.remainingCents === 0
      ? { words: "Balanced", figure: "$0.00" }
      : state.remainingCents > 0
        ? { words: "Left to assign", figure: `$${formatCents(state.remainingCents)}` }
        : { words: "Over by", figure: `$${formatCents(-state.remainingCents)}` };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!state.ready || save.isPending) return;
    try {
      await save.mutateAsync({
        id: tx.id,
        data: {
          splits: parts.map((p) => ({
            categoryId: p.categoryId,
            amount: signedAmount(tx.amount, Math.abs(parseCents(p.amount) ?? 0)),
          })),
        },
      });
      settled();
      toast({ title: `Split into ${parts.length}.` });
      onClose();
    } catch {
      toast({ title: "Couldn't split that charge. Nothing changed.", variant: "destructive" });
    }
  };

  const removeSplit = async () => {
    try {
      await clear.mutateAsync({ id: tx.id });
      settled();
      toast({ title: "Split removed." });
      onClose();
    } catch {
      toast({ title: "Couldn't remove the split. Nothing changed.", variant: "destructive" });
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="split-form">
      <ul className="flex list-none flex-col gap-3 p-0">
        {parts.map((p, i) => (
          <li key={i} className="flex items-center gap-2" data-testid="split-part">
            <select
              aria-label={`Category for part ${i + 1}`}
              value={p.categoryId}
              onChange={(e) => setPart(i, { categoryId: e.target.value })}
              className={cn(input, "min-w-0 flex-1")}
            >
              <option value="">Choose a category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              aria-label={`Amount for part ${i + 1}`}
              inputMode="decimal"
              value={p.amount}
              onChange={(e) => setPart(i, { amount: e.target.value })}
              placeholder="0.00"
              className={cn(input, "w-28 text-right font-mono tabular-nums")}
            />
            {parts.length > 2 && (
              <button type="button" className={btnLink} aria-label={`Remove part ${i + 1}`} onClick={() => setParts((ps) => ps.filter((_, at) => at !== i))}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-4 border-t border-brand-line pt-3">
        <button
          type="button"
          className={btnLink}
          disabled={parts.length >= MAX_PARTS}
          onClick={() => setParts((ps) => [...ps, { categoryId: "", amount: state.remainingCents > 0 ? formatCents(state.remainingCents) : "" }])}
          data-testid="split-add"
        >
          Add a part
        </button>
        <p
          className={cn("text-label font-medium", state.balanced ? "text-ok" : state.remainingCents < 0 ? "text-bad" : "text-brand-navy")}
          aria-live="polite"
          data-testid="split-remainder"
          data-balanced={state.balanced ? "" : undefined}
        >
          {remainder.words} <span className="font-mono tabular-nums">{remainder.figure}</span>
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>
          {existing.length > 0 && (
            <button type="button" className={btnLink} onClick={() => void removeSplit()} disabled={clear.isPending} data-testid="split-remove">
              Remove split
            </button>
          )}
        </span>
        <span className="flex gap-3">
          <button type="button" className={btnSecondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn} disabled={!state.ready || save.isPending} data-testid="split-save">
            {save.isPending ? "Saving…" : "Save split"}
          </button>
        </span>
      </div>
    </form>
  );
}

export default function SplitByCategoryDialog({
  tx,
  categories,
  open,
  onOpenChange,
}: {
  tx: Transaction;
  categories: readonly Cat[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const splits = useGetTransactionSplits(tx.id, {
    query: { queryKey: getGetTransactionSplitsQueryKey(tx.id), enabled: open, staleTime: 0, gcTime: 5 * 60_000 },
  });
  const ready = splits.data !== undefined || splits.isError;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="split-dialog">
        <DialogHeader>
          <DialogTitle>Split by category</DialogTitle>
          <DialogDescription>
            {tx.displayName || tx.description} · {shortDate(tx.occurredOn)} · ${formatCents(chargeCents(tx.amount))}. This divides the charge between budget categories; it is not the allowance-bucket split on Allowances.
          </DialogDescription>
        </DialogHeader>
        {splits.data?.invalid && (
          <p className="text-micro text-neutral-600" data-testid="split-invalid">
            The charge changed since it was split. It counts whole until the parts are rebalanced.
          </p>
        )}
        {!ready ? (
          <p className="text-body text-neutral-500" aria-busy="true">
            Loading…
          </p>
        ) : (
          <Form tx={tx} categories={categories} existing={splits.data?.splits ?? []} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
