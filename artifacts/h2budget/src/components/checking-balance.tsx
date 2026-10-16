import type { ReactNode } from "react";
import { formatCurrency, cn } from "@/lib/utils";
import { CHECKING_WORDS } from "@/lib/checkingWords";

/**
 * ⭐ (C1) THE CHECKING BALANCE, ONE PRESENTATION — docs/contracts/checking-balance.md.
 *
 *   Checking today            (the label, everywhere)
 *   $3,374.60                 (the figure: the reading rolled forward; "—" with no reading)
 *   Calculated · bank read $0.00 Oct 15, 7:02 AM · +2 rows since     } the note
 *   Details                   (the existing "Why this number?" popover) }
 *
 * This file is the FACE (label + figure) and nothing else: it is on the landing path (the Dashboard
 * Banking tile), which has a byte budget. The NOTE — the calculated line and Details — is
 * `checking-balance-note.tsx`; pages use `<CheckingBalanceFull>` from there, the tile loads the note as
 * its own chunk (as it does the balance check), under a line-high placeholder.
 *
 * Words and layout only: every figure and half is the server's. Nothing here computes money.
 */
export type CheckingBalanceSize = "tile" | "cell" | "kpi";

const FIGURE: Record<CheckingBalanceSize, string> = {
  tile: "text-kpi",
  cell: "text-kpi",
  kpi: "text-title",
};

export function CheckingBalance({
  figure,
  older,
  size,
  note,
  figureTestId,
  className,
}: {
  figure: string | number | null | undefined;
  /** "Earlier reading (…) — updating…": the figure is grey, never "current". */
  older?: string | null;
  size: CheckingBalanceSize;
  note?: ReactNode;
  figureTestId?: string;
  className?: string;
}) {
  const n = figure == null || figure === "" ? NaN : Number(figure);
  return (
    <div className={cn("min-w-0", className)} data-testid="checking-balance" data-size={size}>
      <div className="text-micro font-semibold uppercase tracking-wider text-neutral-600" data-testid="checking-balance-label">
        {CHECKING_WORDS}
      </div>
      <div
        className={cn(
          "mt-1 whitespace-nowrap font-mono font-semibold tabular-nums",
          FIGURE[size],
          older ? "text-neutral-500" : n < 0 ? "text-bad-ink" : "text-brand-navy",
        )}
        data-testid={figureTestId ?? "checking-balance-figure"}
      >
        {Number.isFinite(n) ? formatCurrency(n) : "—"}
      </div>
      {note}
    </div>
  );
}
