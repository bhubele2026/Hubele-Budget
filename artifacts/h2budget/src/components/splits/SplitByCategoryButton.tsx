import { Suspense, lazy, useState } from "react";
import type { Transaction } from "@workspace/api-client-react";
import { btnLink } from "@/ui";

// The dialog and its `features` hooks load on first press, not with the page.
const SplitByCategoryDialog = lazy(() => import("./SplitByCategoryDialog"));

/**
 * (F4) "Split by category" on a Chase or Amex row. `splitCount` (Chase rows
 * carry it) turns the label into the row's state, "Split ×N". The Allowances
 * page has its own, different split across weekly buckets.
 */
export function SplitByCategoryButton({
  tx,
  categories,
  splitCount,
  idSuffix = "",
}: {
  tx: Transaction;
  categories: readonly { id: string; name: string }[];
  splitCount?: number;
  /** Distinguishes the phone list's copy of the button from the desktop list's. */
  idSuffix?: string;
}) {
  const [opened, setOpened] = useState(false);
  const [open, setOpen] = useState(false);
  const n = splitCount ?? 0;
  return (
    <>
      <button
        type="button"
        className={btnLink}
        onClick={() => {
          setOpened(true);
          setOpen(true);
        }}
        aria-label={`Split ${tx.displayName || tx.description} by category`}
        title="Divide this charge between budget categories"
        data-testid={`button-split-category${idSuffix}-${tx.id}`}
      >
        {n > 0 ? `Split ×${n}` : "Split"}
      </button>
      {opened && (
        <Suspense fallback={null}>
          <SplitByCategoryDialog tx={tx} categories={categories} open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  );
}
