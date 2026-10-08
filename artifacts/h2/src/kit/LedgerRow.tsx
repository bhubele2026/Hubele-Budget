import { centsValue, fmtMoney } from "@/lib/money";
import { cx } from "@/lib/cx";

/**
 * One charge on the ledger: what it was, the amount in mono, the day, the
 * category as a READ-ONLY chip (Activity makes it editable later), and the
 * word "pending" while the bank has not settled it. Negative amounts are
 * spending and read "-$14"; money in reads "+$1,200".
 */
export function LedgerRow({
  name,
  amount,
  when,
  category,
  pending = false,
  "data-testid": testId,
}: {
  name: string;
  amount: number | null;
  when?: string;
  category?: string | null;
  pending?: boolean;
  "data-testid"?: string;
}) {
  const face = amount == null ? "—" : amount > 0 ? `+${fmtMoney(amount)}` : fmtMoney(amount);
  return (
    <li className="flex items-start justify-between gap-4 border-t border-rule py-3 first:border-t-0" data-testid={testId}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate type-body text-ink">{name}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 type-caption text-ink-3">
          {when && <span>{when}</span>}
          {pending && <span data-testid="row-pending">pending</span>}
          <span
            className={cx(
              "rounded-1 border px-2 py-0.5 text-ink-2",
              category ? "border-rule-strong" : "border-dashed border-rule-strong",
            )}
            data-testid="row-category"
          >
            {category ?? "Not filed"}
          </span>
        </span>
      </div>
      {amount == null ? (
        <span className="shrink-0 type-figure-sm text-ink-3">—</span>
      ) : (
        <data value={centsValue(amount)} className="shrink-0 type-figure-sm text-ink">
          {face}
        </data>
      )}
    </li>
  );
}
