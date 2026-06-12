import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Transaction } from "@workspace/api-client-react";

/**
 * Timezone-safe shift of an ISO date string (`occurredOn` is a `date`
 * column, i.e. YYYY-MM-DD with no time component). We anchor at UTC noon
 * via `Date.UTC` so DST / local-offset parsing can never roll the day
 * forward or back — `new Date("2026-06-07")` would parse as midnight UTC
 * and render as the previous day west of GMT.
 */
export function shiftISODate(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Per-row date editing used on the Transactions/bank and Amex pages.
 *
 * Two affordances:
 *   - A one-tap **‹1d** button that bumps `occurredOn` back a single day.
 *     This is the common fix for the "paid Saturday, posted Sunday" slip
 *     that pushes a charge into the *next* Sun→Sat allowance week and
 *     inflates the new week's spend. Tap twice for a two-day slip.
 *   - A calendar popover to move the row to any arbitrary date.
 *
 * `onMove` performs the PATCH and returns whether it succeeded (so the
 * popover only closes on success). The weekly allowance buckets on
 * `occurredOn`, so moving the date re-files the spend into the right week.
 */
export function RowDateControls({
  tx,
  onMove,
  disabled,
}: {
  tx: Transaction;
  onMove: (nextISO: string) => Promise<boolean>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(tx.occurredOn.slice(0, 10));
  useEffect(() => {
    if (open) setDraft(tx.occurredOn.slice(0, 10));
  }, [open, tx.occurredOn]);
  const submit = async () => {
    const ok = await onMove(draft);
    if (ok) setOpen(false);
  };
  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        title="Move back a day (e.g. Sunday → Saturday so it counts in the right week)"
        data-testid={`button-bump-date-back-${tx.id}`}
        className="h-8 px-1.5 text-muted-foreground"
        onClick={() => void onMove(shiftISODate(tx.occurredOn, -1))}
      >
        <ChevronLeft className="w-4 h-4 -mr-1" />
        <span className="text-[11px] tabular-nums">1d</span>
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            title="Move to a different day"
            data-testid={`button-inline-date-${tx.id}`}
          >
            <CalendarDays className="w-4 h-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-3" align="end">
          <div className="space-y-2">
            <label
              htmlFor={`inline-date-input-${tx.id}`}
              className="text-xs text-muted-foreground"
            >
              Move to
            </label>
            <Input
              id={`inline-date-input-${tx.id}`}
              data-testid={`input-inline-date-${tx.id}`}
              type="date"
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
                data-testid={`button-cancel-inline-date-${tx.id}`}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={disabled}
                data-testid={`button-save-inline-date-${tx.id}`}
              >
                Save
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
