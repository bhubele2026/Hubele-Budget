import { useEffect, useState } from "react";
import { type Transaction } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency, cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { parseSigned } from "./transactionsShared";

/**
 * Task #454 — Inline amount editor surfaced as the row's amount label.
 * Clicking the amount opens a small popover with a numeric input that
 * routes through `handleQuickAmount` (same `updateTx` PATCH path as
 * the Edit dialog). Sign / currency formatting is preserved by
 * `normalizeAmount` so an expense stays an expense and an income
 * stays an income — only the magnitude changes. Submitting an
 * unchanged value is a no-op (no toast, no PATCH).
 */
export function InlineAmountEditor({
  tx,
  onSave,
  onFlipKind,
  disabled,
}: {
  tx: Transaction;
  onSave: (raw: string) => Promise<boolean>;
  onFlipKind?: () => Promise<boolean>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const initial = Math.abs(parseSigned(tx.amount)).toFixed(2);
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    if (open) setDraft(Math.abs(parseSigned(tx.amount)).toFixed(2));
  }, [open, tx.amount]);
  const submit = async () => {
    const ok = await onSave(draft);
    if (ok) setOpen(false);
  };
  const isCurrentlyIncome = parseSigned(tx.amount) >= 0;
  const flip = async () => {
    if (!onFlipKind) return;
    const ok = await onFlipKind();
    if (ok) setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "font-medium tabular-nums whitespace-nowrap cursor-pointer rounded px-1 -mx-1 hover:bg-muted/40 transition-colors",
            parseSigned(tx.amount) > 0
              ? "text-[hsl(var(--positive))]"
              : "text-foreground",
          )}
          title="Edit amount"
          aria-label="Edit amount"
          data-testid={`amount-${tx.id}`}
        >
          {formatCurrency(tx.amount)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="end">
        <div className="space-y-2">
          <label
            htmlFor={`inline-amount-input-${tx.id}`}
            className="text-xs text-muted-foreground"
          >
            New amount
          </label>
          <Input
            id={`inline-amount-input-${tx.id}`}
            data-testid={`input-inline-amount-${tx.id}`}
            type="number"
            step="0.01"
            min="0"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
            autoFocus
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              data-testid={`button-cancel-inline-amount-${tx.id}`}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={disabled}
              data-testid={`button-save-inline-amount-${tx.id}`}
            >
              Save
            </Button>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {isCurrentlyIncome
              ? "Positive (income) — sign preserved."
              : "Negative (expense) — sign preserved."}
          </div>
          {onFlipKind && (
            <div className="border-t pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void flip()}
                disabled={disabled}
                data-testid={`button-flip-kind-${tx.id}`}
                title={
                  isCurrentlyIncome
                    ? "Flip to expense"
                    : "Flip to income"
                }
              >
                {isCurrentlyIncome ? "Mark as expense" : "Mark as income"}
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
