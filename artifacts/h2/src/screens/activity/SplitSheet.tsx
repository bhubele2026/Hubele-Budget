import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetTransactionSplitsQueryKey, useReplaceTransactionSplits, type Category } from "@workspace/api-client-react";
import type { LedgerRow } from "@workspace/api-client-react/ledger";
import { Button } from "@/kit/Button";
import { Sheet } from "@/kit/Sheet";
import { shortDate } from "@/lib/dates";
import { cx } from "@/lib/cx";
import { useToast } from "@/kit/Toast";
import { chargeCents, formatCents, parseCents, signedAmount, splitState, type SplitPart } from "./splitMath";

const MAX_PARTS = 20;

/**
 * ⭐ THE SPLIT SHEET — one charge across several categories. Rows of category
 * and amount; the line under them says how much is left to assign and Save
 * stays off until it reads $0.00. Amounts are typed as plain magnitudes; the
 * charge's own sign is put back when it is sent.
 *
 * Cents show here because this is a detail sheet. The server re-checks the
 * parts against the charge and is the authority.
 */
export function SplitSheet({
  row,
  categories,
  open,
  onOpenChange,
  onSaved,
}: {
  row: LedgerRow;
  categories: readonly Category[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (transactionId: string, parts: number) => void;
}) {
  const total = chargeCents(row.amount);
  const [parts, setParts] = useState<SplitPart[]>(() => [
    { categoryId: row.categoryId ?? "", amount: formatCents(total) },
    { categoryId: "", amount: "" },
  ]);
  const state = useMemo(() => splitState(total, parts), [total, parts]);
  const save = useReplaceTransactionSplits();
  const qc = useQueryClient();
  const toast = useToast();

  const setPart = (i: number, patch: Partial<SplitPart>) =>
    setParts((ps) => ps.map((p, at) => (at === i ? { ...p, ...patch } : p)));

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
        id: row.id,
        data: {
          splits: parts.map((p) => ({
            categoryId: p.categoryId,
            amount: signedAmount(row.amount, Math.abs(parseCents(p.amount) ?? 0)),
          })),
        },
      });
      void qc.invalidateQueries({ queryKey: getGetTransactionSplitsQueryKey(row.id) });
      onSaved?.(row.id, parts.length);
      toast.show({ message: `Split into ${parts.length}.` });
      onOpenChange(false);
    } catch {
      toast.show({ message: "Couldn't split that charge. Nothing changed.", tone: "error" });
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Split charge"
      description={`${row.displayName || row.description} · ${shortDate(row.occurredOn)} · $${formatCents(total)}`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" data-testid="split-form">
        <ul className="flex flex-col gap-3">
          {parts.map((p, i) => (
            <li key={i} className="flex items-center gap-2" data-testid="split-part">
              <select
                aria-label={`Category for part ${i + 1}`}
                value={p.categoryId}
                onChange={(e) => setPart(i, { categoryId: e.target.value })}
                className="h-10 min-w-0 flex-1 rounded-1 border border-rule-strong bg-paper-0 px-2 type-body text-ink"
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
                className="h-10 w-28 rounded-1 border border-rule-strong bg-paper-0 px-2 text-right tnum text-ink"
              />
              {parts.length > 2 && (
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={`Remove part ${i + 1}`}
                  onClick={() => setParts((ps) => ps.filter((_, at) => at !== i))}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-4 border-t border-rule pt-3">
          <Button
            variant="link"
            size="sm"
            disabled={parts.length >= MAX_PARTS}
            onClick={() => setParts((ps) => [...ps, { categoryId: "", amount: state.remainingCents > 0 ? formatCents(state.remainingCents) : "" }])}
          >
            Add a part
          </Button>
          <p
            className={cx("type-label", state.balanced ? "text-moss-ink" : state.remainingCents < 0 ? "text-clay" : "text-ink")}
            aria-live="polite"
            data-testid="split-remainder"
            data-balanced={state.balanced ? "" : undefined}
          >
            {remainder.words} <span className="tnum">{remainder.figure}</span>
          </p>
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!state.ready || save.isPending} data-testid="split-save">
            {save.isPending ? "Saving…" : "Save split"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
