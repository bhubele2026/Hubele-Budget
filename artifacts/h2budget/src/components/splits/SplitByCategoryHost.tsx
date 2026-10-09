import { Suspense, lazy } from "react";
import type { Transaction } from "@workspace/api-client-react";

// The dialog and its `features` hooks load the first time a split is opened,
// not with the page.
const SplitByCategoryDialog = lazy(() => import("./SplitByCategoryDialog"));

/**
 * (F4) Hosts the "Split by category" dialog for a ledger page. The page keeps
 * `tx` in state (set from the row's detail: Chase's edit dialog, Amex's
 * merchant popover) and clears it on close. Nothing renders until a charge is
 * chosen. The Allowances page has its own, different split across weekly
 * buckets.
 */
export function SplitByCategoryHost({
  tx,
  categories,
  onClose,
}: {
  tx: Transaction | null;
  categories: readonly { id: string; name: string }[];
  onClose: () => void;
}) {
  if (!tx) return null;
  return (
    <Suspense fallback={null}>
      <SplitByCategoryDialog tx={tx} categories={categories} open onOpenChange={(o) => !o && onClose()} />
    </Suspense>
  );
}
