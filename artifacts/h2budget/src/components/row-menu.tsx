import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Transaction } from "@workspace/api-client-react";
import { shiftISODate } from "@/components/row-date-controls";

/**
 * The quiet per-row menu on the Amex and Chase ledgers. It holds the row's
 * less-used actions (move a day back, move to any day, edit, delete) so a
 * row shows one small button instead of four. A Radix menu: Enter / Space /
 * ArrowDown opens it, the arrows move, Enter chooses, Escape closes and
 * returns focus to the button. Nothing here is new behaviour: each item calls
 * the same handler the old inline buttons called.
 *
 * `onMove` omitted (a pending row, which Plaid restamps) leaves out the two
 * date items; with no items at all the menu does not render.
 */
export function RowMenu({
  tx,
  merchant,
  onMove,
  onEdit,
  onDelete,
  disabled,
}: {
  tx: Transaction;
  /** The row's merchant, for the button's accessible name. */
  merchant: string;
  onMove?: (nextISO: string) => void | Promise<boolean>;
  onEdit?: () => void;
  onDelete?: () => void;
  disabled?: boolean;
}) {
  const [dateOpen, setDateOpen] = useState(false);
  const [draft, setDraft] = useState(tx.occurredOn.slice(0, 10));
  useEffect(() => {
    if (dateOpen) setDraft(tx.occurredOn.slice(0, 10));
  }, [dateOpen, tx.occurredOn]);
  if (!onMove && !onEdit && !onDelete) return null;
  const submit = async () => {
    if (!onMove) return;
    const ok = await onMove(draft);
    if (ok) setDateOpen(false);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={disabled}
            aria-label={`More actions for ${merchant}`}
            title="More"
            data-testid={`button-row-menu-${tx.id}`}
          >
            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid={`row-menu-${tx.id}`}>
          {onMove && (
            <>
              <DropdownMenuItem
                data-testid={`button-bump-date-back-${tx.id}`}
                onSelect={() => void onMove(shiftISODate(tx.occurredOn, -1))}
              >
                <ChevronLeft className="h-4 w-4" /> Move back 1 day
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`button-inline-date-${tx.id}`}
                onSelect={() => setDateOpen(true)}
              >
                <CalendarDays className="h-4 w-4" /> Move to a day…
              </DropdownMenuItem>
            </>
          )}
          {onMove && (onEdit || onDelete) && <DropdownMenuSeparator />}
          {onEdit && (
            <DropdownMenuItem data-testid={`button-edit-tx-${tx.id}`} onSelect={() => onEdit()}>
              <Pencil className="h-4 w-4" /> Edit
            </DropdownMenuItem>
          )}
          {onDelete && (
            <DropdownMenuItem data-testid={`button-delete-tx-${tx.id}`} onSelect={() => onDelete()}>
              <Trash2 className="h-4 w-4 text-bad" /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onMove && (
        <Dialog open={dateOpen} onOpenChange={setDateOpen}>
          <DialogContent className="max-w-xs">
            <DialogHeader>
              <DialogTitle>Move to a day</DialogTitle>
              <DialogDescription>{merchant}</DialogDescription>
            </DialogHeader>
            <Input
              id={`inline-date-input-${tx.id}`}
              aria-label="Move to"
              data-testid={`input-inline-date-${tx.id}`}
              type="date"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDateOpen(false)}
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
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
