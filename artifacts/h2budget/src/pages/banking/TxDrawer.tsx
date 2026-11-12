import type { ReactNode } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListCategorizationReviewQueryKey,
  getListCategoriesQueryKey,
  getListTransactionsQueryKey,
  useListCategories,
  useListTransactions,
  useUpdateTransaction,
  type ListTransactionsParams,
  type Transaction,
} from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { BucketLegend } from "@/components/bucket-legend";
import { CategoryPicker } from "@/components/category-picker";
import { toast } from "@/hooks/use-toast";
import { formatDisplayAmount } from "@/lib/amountDisplay";
import { bucketPatchOf } from "@/lib/bucketPatch";
import { ruleActionMessage } from "@/lib/ruleActionMessage";
import { btnLink, fieldLabel } from "@/ui";
import { StatusBadge } from "@/components/next/StatusBadge";
import { getNeedsYouQueryKey } from "./needsYouApi";
import { dayWords } from "./words";

/**
 * ⭐ ONE BANK ROW, OPENED IN PLACE. Banking never sends the household away to
 * look at a row: a click on a Needs-you row or on a row in the "Not in the
 * plan" lists opens this drawer over the page. It shows the whole row (date,
 * name, account ••mask, pending or posted, amount), its category picker and
 * its four bucket marks, writes them with the same PATCH the Chase register
 * sends, and keeps a small "Open in register" link for everything else
 * (rename, split, dates, delete).
 *
 * The row itself is read with ONE bounded request: its own day, at most 100
 * rows (CLAUDE.md §2), only while the drawer is open.
 */

export type DrawerRow = {
  id: string;
  date: string;
  name: string;
  amount: string;
  pending: boolean;
  /** "Cedar Hollow Bank Checking ••1234": the account, with its digits. */
  accountLabel: string;
  /** The register at this row, when the one route rule knows it. */
  registerHref?: string | null;
};

const MIN = 60_000;

export function TxDrawer({
  row,
  onOpenChange,
  hrefOfTx,
  children,
}: {
  row: DrawerRow | null;
  onOpenChange: (open: boolean) => void;
  /** The one route rule, once the full row (its account and source) is in. */
  hrefOfTx?: (tx: Transaction) => string | null;
  /** The row's own answer (Needs you puts OK and Change here). */
  children?: ReactNode;
}) {
  const open = row != null;
  const qc = useQueryClient();
  const params: ListTransactionsParams = { from: row?.date ?? "", to: row?.date ?? "", limit: 100 };
  const day = useListTransactions(params, {
    query: { queryKey: getListTransactionsQueryKey(params), staleTime: MIN, gcTime: 10 * MIN, enabled: open && !!row?.date },
  });
  const categories = useListCategories({ query: { queryKey: getListCategoriesQueryKey(), staleTime: 10 * MIN, gcTime: 30 * MIN } });
  const update = useUpdateTransaction();
  const tx: Transaction | null = row ? (day.data?.find((t) => t.id === row.id) ?? null) : null;
  const registerHref = (tx && hrefOfTx?.(tx)) || row?.registerHref || null;
  const catName = (id: string | null | undefined) => (id ? (categories.data?.find((c) => c.id === id)?.name ?? null) : null);

  const after = () => {
    void qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    void qc.invalidateQueries({ queryKey: getNeedsYouQueryKey() });
    void qc.invalidateQueries({ queryKey: getListCategorizationReviewQueryKey() });
  };

  const setCategory = async (categoryId: string | null) => {
    if (!tx) return;
    try {
      const updated = await update.mutateAsync({ id: tx.id, data: { categoryId } });
      after();
      // Every hand pick teaches H2 this merchant (the server learns from it; Transfer and Ignore are never learned).
      const said = ruleActionMessage(updated.ruleAction);
      const name = catName(categoryId);
      toast({ title: name ? `Filed under ${name}` : "Categorized", description: said ?? "H2 remembers this merchant for next time." });
    } catch (e) {
      toast({ title: "Couldn't categorize", description: (e as Error).message, variant: "destructive" });
    }
  };

  const setBucket = async (bucket: BucketKey, next: boolean) => {
    if (!tx) return;
    try {
      await update.mutateAsync({ id: tx.id, data: bucketPatchOf(tx, bucket, next) });
      after();
    } catch (e) {
      toast({ title: "Couldn't save that", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md" data-testid="tx-drawer">
        {row ? (
          <>
            <div className="space-y-1 pr-8">
              <SheetTitle className="break-words" data-testid="tx-drawer-name">{tx?.displayName || row.name}</SheetTitle>
              <SheetDescription className="text-label text-neutral-600" data-testid="tx-drawer-meta">
                {dayWords(row.date)} · {row.accountLabel}
              </SheetDescription>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <StatusBadge state={row.pending ? "pending" : "confirmed"} data-testid="tx-drawer-state">{row.pending ? "Pending" : "Posted"}</StatusBadge>
              <span className="fig text-kpi font-semibold text-foreground" data-testid="tx-drawer-amount">
                {formatDisplayAmount(Number(row.amount))}
              </span>
            </div>
            {tx && tx.description && tx.description !== (tx.displayName || row.name) ? (
              <p className="text-micro text-neutral-500" data-testid="tx-drawer-bank-words">The bank says: {tx.description}</p>
            ) : null}

            {children ? <div className="border-t border-brand-line pt-3">{children}</div> : null}

            <div className="space-y-3 border-t border-brand-line pt-3">
              {tx ? (
                <>
                  <div className="space-y-1">
                    <div className={fieldLabel}>Category</div>
                    <CategoryPicker
                      value={tx.categoryId ?? null}
                      categories={categories.data}
                      description={tx.description}
                      onChange={(id) => void setCategory(id)}
                      testId="tx-drawer-category"
                      triggerClassName="w-full"
                    />
                  </div>
                  {!tx.isTransfer ? (
                    <div className="space-y-1.5" data-testid="tx-drawer-buckets">
                      <div className={fieldLabel}>Counts toward</div>
                      <BucketBubbles
                        wordy
                        disabled={update.isPending}
                        flags={{ weekly: tx.weeklyAllowance, monthly: tx.monthlyAllowance, unplanned: tx.unplannedAllowance, reimbursable: tx.reimbursable }}
                        onToggle={(b, next) => void setBucket(b, next)}
                      />
                      <BucketLegend />
                    </div>
                  ) : (
                    <p className="text-label text-neutral-600">A transfer between accounts: it counts toward no allowance.</p>
                  )}
                </>
              ) : day.isError ? (
                <p className="text-label text-neutral-700" role="alert">
                  This row did not load.{" "}
                  <button type="button" className={btnLink} onClick={() => void day.refetch()}>Try again</button>
                </p>
              ) : day.data ? (
                <p className="text-label text-neutral-600" data-testid="tx-drawer-missing">H2 could not find this row on its day. Open it in the register.</p>
              ) : (
                <div className="skeleton h-20 w-full rounded-card" aria-busy="true" />
              )}
            </div>

            {registerHref ? (
              <Link href={registerHref} className="press mt-auto text-label font-medium text-brand-navy hover:underline" data-testid="tx-drawer-register">
                Open in register →
              </Link>
            ) : null}
          </>
        ) : (
          <SheetTitle className="sr-only">Transaction</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  );
}
