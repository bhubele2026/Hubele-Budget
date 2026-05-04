import type { RepointedRuleSample } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatCurrency, formatDate } from "@/lib/utils";

export type RuleMatchesPreviewState = {
  pattern: string;
  candidateCount: number;
  sampleTransactions: RepointedRuleSample[];
  toCategoryName: string;
};

export type RuleMatchesPreviewDialogProps = {
  state: RuleMatchesPreviewState | null;
  onOpenChange: (open: boolean) => void;
  onApply: () => void;
  applyDisabled?: boolean;
};

function parseSigned(amount: string | number): number {
  return Number(amount) || 0;
}

/**
 * Shared "Show matches" preview dialog used by both:
 *   * The Transactions/Chase page after a quick-categorize repoints an
 *     existing seed mapping rule (the toast surfaces a "Show matches"
 *     link that opens this dialog).
 *   * The Mapping Rules page when editing a rule's category — the inline
 *     preview's "Show matches" affordance opens the same dialog so the
 *     user gets a consistent UX whichever entry point they used.
 *
 * Renders a most-recent-first list of the affected transactions and an
 * Apply button that fires the supplied `onApply` callback (which in turn
 * triggers POST /api/transactions/recategorize-by-pattern from whichever
 * page mounted the dialog).
 */
export function RuleMatchesPreviewDialog({
  state,
  onOpenChange,
  onApply,
  applyDisabled,
}: RuleMatchesPreviewDialogProps) {
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent
        className="sm:max-w-[480px]"
        data-testid="dialog-rule-matches-preview"
      >
        <DialogHeader>
          <DialogTitle>
            {state
              ? `Move ${state.candidateCount} past payment${state.candidateCount === 1 ? "" : "s"} into ${state.toCategoryName}?`
              : ""}
          </DialogTitle>
          <DialogDescription>
            {state
              ? `These transactions still match "${state.pattern}" and sit in the rule's previous category. Confirm to move them all into ${state.toCategoryName}.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {state && state.sampleTransactions.length > 0 && (
          <div
            className="max-h-[320px] overflow-y-auto rounded-md border divide-y divide-border"
            data-testid="list-rule-matches"
          >
            {state.sampleTransactions.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                data-testid={`row-rule-match-${s.id}`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">
                    {s.description}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDate(s.occurredOn)}
                  </div>
                </div>
                <span
                  className={cn(
                    "tabular-nums whitespace-nowrap",
                    parseSigned(s.amount) > 0 && "text-emerald-700",
                    parseSigned(s.amount) < 0 && "text-foreground",
                  )}
                >
                  {formatCurrency(s.amount)}
                </span>
              </div>
            ))}
          </div>
        )}
        {state &&
          state.sampleTransactions.length < state.candidateCount && (
            <p className="text-xs text-muted-foreground">
              Showing the {state.sampleTransactions.length} most-recent of{" "}
              {state.candidateCount} matches. Apply will move all{" "}
              {state.candidateCount}.
            </p>
          )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="button-rule-matches-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={onApply}
            disabled={applyDisabled}
            data-testid="button-rule-matches-apply"
          >
            Move {state?.candidateCount ?? 0} transaction
            {state?.candidateCount === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
