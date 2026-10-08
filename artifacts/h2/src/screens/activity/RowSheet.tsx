import { useQueryClient } from "@tanstack/react-query";
import {
  getGetTransactionSplitsQueryKey,
  useDeleteTransactionSplits,
  useGetTransactionSplits,
  useUpdateTransaction,
  type Category,
} from "@workspace/api-client-react";
import type { LedgerRow } from "@workspace/api-client-react/ledger";
import { Button } from "@/kit/Button";
import { Sheet } from "@/kit/Sheet";
import { useToast } from "@/kit/Toast";
import { longDate } from "@/lib/dates";
import { toAmount } from "@/lib/money";
import { isProvisional } from "./useFiling";
import { formatCents, parseCents } from "./splitMath";

function filedHow(row: LedgerRow, catName: string | null): string {
  if (!catName) return "Not filed yet.";
  if (isProvisional(row)) return "H2's pick, waiting for you to confirm it.";
  if (row.categoryLockedByUser) return "Filed by you.";
  if (row.matchedRuleId) return "Matches a hand-written rule.";
  return "Filed by H2.";
}

/**
 * The row's menu and its details, in one sheet: Split, Mark reimbursable, and
 * every field the ledger holds for the charge. Cents show here (detail sheet).
 * There is no per-charge decision history on the API yet, so "How it was
 * filed" reads from the row's own flags.
 */
export function RowSheet({
  row,
  categories,
  accountLabel,
  open,
  onOpenChange,
  onSplit,
}: {
  row: LedgerRow;
  categories: readonly Category[];
  accountLabel: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSplit: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const update = useUpdateTransaction();
  const clearSplits = useDeleteTransactionSplits();
  const names = new Map(categories.map((c) => [c.id, c.name] as const));
  const catName = row.categoryId ? (names.get(row.categoryId) ?? null) : null;
  const splits = useGetTransactionSplits(row.id, {
    query: { queryKey: getGetTransactionSplitsQueryKey(row.id), enabled: open, staleTime: 60_000, gcTime: 5 * 60_000 },
  });
  const parts = splits.data?.splits ?? [];
  const amount = toAmount(row.amount);
  const cents = parseCents(row.amount);

  const toggleReimbursable = async () => {
    try {
      await update.mutateAsync({ id: row.id, data: { reimbursable: !row.reimbursable } });
      toast.show({ message: row.reimbursable ? "No longer marked reimbursable." : "Marked reimbursable." });
      onOpenChange(false);
    } catch {
      toast.show({ message: "Couldn't change that. Nothing changed.", tone: "error" });
    }
  };

  const removeSplit = async () => {
    try {
      await clearSplits.mutateAsync({ id: row.id });
      void qc.invalidateQueries({ queryKey: getGetTransactionSplitsQueryKey(row.id) });
      toast.show({ message: "Split removed." });
    } catch {
      toast.show({ message: "Couldn't remove the split. Nothing changed.", tone: "error" });
    }
  };

  const fields: [string, string][] = [
    ["Date", longDate(row.occurredOn)],
    ["Amount", cents == null ? "—" : `${cents < 0 ? "-" : amount != null && amount > 0 ? "+" : ""}$${formatCents(Math.abs(cents))}`],
    ["Bank description", row.description],
    ["Account", accountLabel ?? "—"],
    ["Category", catName ?? "Not filed"],
    ["How it was filed", filedHow(row, catName)],
    ["Status", row.pending ? "Pending at the bank" : "Posted"],
    ["Reimbursable", row.reimbursable ? (row.reimbursed ? "Yes, reimbursed" : "Yes") : "No"],
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={row.displayName || row.description} description="Details">
      <div className="flex flex-col gap-6" data-testid="row-sheet">
        <div className="flex flex-wrap gap-3">
          <Button variant="quiet" onClick={onSplit} data-testid="row-split">
            Split…
          </Button>
          <Button variant="quiet" onClick={toggleReimbursable} disabled={update.isPending} data-testid="row-reimbursable">
            {row.reimbursable ? "Not reimbursable" : "Mark reimbursable"}
          </Button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 type-body" data-testid="row-details">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-2">{k}</dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        {parts.length > 0 && (
          <section data-testid="row-splits">
            <h3 className="mb-1 type-section text-ink-2">Split ×{parts.length}</h3>
            <ul>
              {parts.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-4 border-t border-rule py-2 first:border-t-0 type-body">
                  <span>{names.get(p.categoryId) ?? "Unknown category"}</span>
                  <span className="tnum">{p.amount}</span>
                </li>
              ))}
            </ul>
            {splits.data?.invalid && (
              <p className="mt-2 type-caption text-ink-2">The charge changed since it was split. It counts whole until the parts are rebalanced.</p>
            )}
            <div className="mt-3">
              <Button variant="quiet" size="sm" onClick={removeSplit} disabled={clearSplits.isPending}>
                Remove split
              </Button>
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
