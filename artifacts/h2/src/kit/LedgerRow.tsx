import type { ReactNode } from "react";
import { centsValue, fmtMoney } from "@/lib/money";
import { cx } from "@/lib/cx";

/**
 * One charge on the ledger: what it was, the amount in mono, the day, the
 * category chip, and the word "pending" while the bank has not settled it.
 * Negative amounts are spending and read "-$14"; money in reads "+$1,200".
 *
 * Today hands it a `category` name and gets a read-only chip. Activity hands
 * it a `chip` (the editable CategoryChip), the account `mask`, a `trailing`
 * control (the row menu) and `below` (a split's parts).
 */
export function LedgerRow({
  name,
  amount,
  when,
  category,
  pending = false,
  chip,
  mask,
  trailing,
  below,
  "data-testid": testId,
}: {
  name: string;
  amount: number | null;
  when?: string;
  category?: string | null;
  pending?: boolean;
  chip?: ReactNode;
  mask?: string | null;
  trailing?: ReactNode;
  below?: ReactNode;
  "data-testid"?: string;
}) {
  const face = amount == null ? "—" : amount > 0 ? `+${fmtMoney(amount)}` : fmtMoney(amount);
  return (
    <li className="border-t border-rule py-3 first:border-t-0" data-testid={testId}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate type-body text-ink">{name}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 type-caption text-ink-3">
            {when && <span>{when}</span>}
            {pending && <span data-testid="row-pending">pending</span>}
            {mask && <span data-testid="row-mask">••{mask}</span>}
            {chip ?? (
              <span
                className={cx(
                  "rounded-1 border px-2 py-0.5 text-ink-2",
                  category ? "border-rule-strong" : "border-dashed border-rule-strong",
                )}
                data-testid="row-category"
              >
                {category ?? "Not filed"}
              </span>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-start gap-1">
          {amount == null ? (
            <span className="type-figure-sm text-ink-3">—</span>
          ) : (
            <data value={centsValue(amount)} className="type-figure-sm text-ink">
              {face}
            </data>
          )}
          {trailing}
        </div>
      </div>
      {below}
    </li>
  );
}
