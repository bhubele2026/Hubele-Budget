import { useCallback, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRecategorizeTransactionsByPattern,
  useListMappingRules,
  getListTransactionsQueryKey,
  getGetBudgetMonthQueryKey,
  type RuleAction,
  type RepointedRule,
  type RepointedRuleSample,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MatchedRuleChip } from "@/components/matched-rule-chip";
import { formatCurrency, formatDate, cn } from "@/lib/utils";

function parseSigned(amount: string | number): number {
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Generic shape of a freshly-learned mapping rule that the user can
 * "apply to past charges". Used both for *repointed* seed rules
 * (`fromCategoryId` is the rule's old category — we only flip rows
 * still in it, preserving manual edits) and for *brand-new specific
 * rules* (`fromCategoryId === null` — we only flip rows that are
 * still uncategorized, again preserving manual edits).
 *
 * `sampleTransactions` and `toCategoryName` are optional preview
 * affordances — when present, the hook surfaces a "Show matches"
 * link on the toast that opens a dialog listing the rows that would
 * move (Task #187 preview UX). Repointed rules ship a server-side
 * sample list; created-rule prompts (Task #195) currently leave it
 * empty so the toast skips the link.
 */
export type BulkRecategorizeRule = {
  pattern: string;
  matchType: "contains" | "exact" | "starts_with";
  fromCategoryId: string | null;
  toCategoryId: string;
  candidateCount: number;
  sampleTransactions?: RepointedRuleSample[];
  toCategoryName?: string;
  // Task #199 — when present, the originating mapping rule is also
  // re-pointed back to its previous category on Undo so future
  // matching charges no longer auto-snap onto the user's accidental
  // pick. Created-rule prompts (Task #195) leave it undefined since
  // their Undo path is suppressed entirely (see undoBulkRecategorize).
  ruleId?: string;
};

/**
 * Build a `BulkRecategorizeRule` from a server-reported `RuleAction`
 * when the auto-learn flow created a brand-new specific mapping rule
 * (`kind === "created"` or `kind === "created_priority_bump"`). The
 * "apply to past" target is uncategorized rows matching the new
 * pattern, so `fromCategoryId` is `null`. Returns `null` for any
 * other rule-action shape (or when the candidate count is 0) so the
 * caller can drop the prompt.
 */
export function bulkRuleFromRuleAction(
  action: RuleAction | undefined,
  toCategoryName?: string,
): BulkRecategorizeRule | null {
  if (!action) return null;
  if (action.kind !== "created" && action.kind !== "created_priority_bump") {
    return null;
  }
  const { pattern, matchType, toCategoryId, candidateCount } = action;
  if (
    !pattern ||
    !matchType ||
    !toCategoryId ||
    typeof candidateCount !== "number" ||
    candidateCount <= 0
  ) {
    return null;
  }
  return {
    pattern,
    matchType,
    fromCategoryId: null,
    toCategoryId,
    candidateCount,
    toCategoryName,
  };
}

/**
 * Build a `BulkRecategorizeRule` from a server-reported
 * `RepointedRule`. Returns `null` when there are no remaining
 * candidates so the caller can drop the prompt.
 */
export function bulkRuleFromRepointed(
  rule: RepointedRule,
  toCategoryName?: string,
): BulkRecategorizeRule | null {
  if (rule.candidateCount <= 0) return null;
  return {
    pattern: rule.pattern,
    matchType: rule.matchType,
    fromCategoryId: rule.fromCategoryId,
    toCategoryId: rule.toCategoryId,
    candidateCount: rule.candidateCount,
    sampleTransactions: rule.sampleTransactions,
    toCategoryName,
    ruleId: rule.ruleId,
  };
}

/**
 * Provides `offerBulkRecategorize(rule)` — surfaces the "apply to
 * past charges?" toast prompt and, on accept, POSTs to
 * /transactions/recategorize-by-pattern + invalidates affected
 * caches. Includes a one-click Undo scoped to the exact ids the
 * bulk touched (so subsequent manual edits aren't trampled).
 *
 * Also returns `previewDialog` — a ReactNode the caller must render
 * once somewhere in its tree. When the rule carries
 * `sampleTransactions`, the toast shows a "Show matches" link that
 * opens this dialog so the user can sanity-check the list before
 * confirming (Task #187 preview UX).
 *
 * Used by both the Transactions and Amex pages — they share the
 * same UX and the same server endpoint, so the helper hook keeps
 * the prompt copy + invalidation strategy in one place.
 */
export function useBulkRecategorizePrompt(): {
  offerBulkRecategorize: (rule: BulkRecategorizeRule) => void;
  previewDialog: ReactNode;
} {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recategorizeBulk = useRecategorizeTransactionsByPattern();
  // Drives the MatchedRuleChip in the preview dialog rows so each
  // sample renders the same "rule: <pattern>" deep-link or "manually
  // categorized" hint as the Transactions / Amex / Dashboard surfaces
  // (Task #208). Loaded once at the hook level since the dialog
  // typically only opens once per prompt.
  const { data: mappingRules } = useListMappingRules();
  const [previewState, setPreviewState] = useState<BulkRecategorizeRule | null>(
    null,
  );

  const undoBulkRecategorize = useCallback(
    (rule: BulkRecategorizeRule, affectedIds: string[]) => {
      if (affectedIds.length === 0) return;
      // Swap from/to so we move the rows back to their original
      // category. The `ids` whitelist plus the server-side
      // categoryId == fromCategoryId (or IS NULL) filter makes this
      // safely skip anything the user has since re-edited.
      // Note: when we just bulk-flipped uncategorized rows onto
      // `toCategoryId`, the swapped fromCategoryId is `toCategoryId`
      // (a real category id) and the swapped toCategoryId would be
      // `null` — but the bulk endpoint requires a non-null
      // toCategoryId. Skip Undo in that case; the user can manually
      // un-categorize a row if they really want to.
      const swappedTo = rule.fromCategoryId;
      if (swappedTo === null) return;
      recategorizeBulk.mutate(
        {
          data: {
            pattern: rule.pattern,
            matchType: rule.matchType,
            fromCategoryId: rule.toCategoryId,
            toCategoryId: swappedTo,
            ids: affectedIds,
            // Task #199 — re-point the mapping rule back to its
            // previous category so future matching transactions
            // don't keep auto-flipping onto the user's mistaken
            // pick. Done unconditionally (the server ownership
            // filter makes a stale id a silent no-op) so the rule
            // still resets even if the user has already manually
            // re-edited every affected row.
            ...(rule.ruleId ? { ruleId: rule.ruleId } : {}),
          },
        },
        {
          onSuccess: (res) => {
            queryClient.invalidateQueries({
              queryKey: getListTransactionsQueryKey(),
            });
            for (const m of res.affectedMonths) {
              queryClient.invalidateQueries({
                queryKey: getGetBudgetMonthQueryKey(m),
              });
            }
            toast({
              title:
                res.updated === 0
                  ? "Nothing to undo"
                  : `Restored ${res.updated} transaction${res.updated === 1 ? "" : "s"}`,
            });
          },
          onError: (e) => {
            toast({
              title: "Couldn't undo",
              description: (e as Error).message,
              variant: "destructive",
            });
          },
        },
      );
    },
    [recategorizeBulk, queryClient, toast],
  );

  const applyBulkRecategorize = useCallback(
    (rule: BulkRecategorizeRule) => {
      recategorizeBulk.mutate(
        {
          data: {
            pattern: rule.pattern,
            matchType: rule.matchType,
            fromCategoryId: rule.fromCategoryId,
            toCategoryId: rule.toCategoryId,
          },
        },
        {
          onSuccess: (res) => {
            queryClient.invalidateQueries({
              queryKey: getListTransactionsQueryKey(),
            });
            for (const m of res.affectedMonths) {
              queryClient.invalidateQueries({
                queryKey: getGetBudgetMonthQueryKey(m),
              });
            }
            if (res.updated === 0) {
              toast({ title: "Nothing to update" });
              return;
            }
            // Surface a follow-up toast with one-click Undo scoped
            // to the exact ids the bulk touched. Skipped for the
            // uncategorized-sweep case because it would require a
            // null toCategoryId which the endpoint doesn't accept.
            const undoable = rule.fromCategoryId !== null;
            toast({
              title: `Re-categorized ${res.updated} past transaction${res.updated === 1 ? "" : "s"}`,
              ...(undoable
                ? {
                    action: (
                      <ToastAction
                        altText="Undo bulk recategorize"
                        data-testid="action-undo-bulk-recategorize"
                        onClick={() =>
                          undoBulkRecategorize(rule, res.affectedIds)
                        }
                      >
                        Undo
                      </ToastAction>
                    ),
                  }
                : {}),
            });
          },
          onError: (e) => {
            toast({
              title: "Couldn't apply to past",
              description: (e as Error).message,
              variant: "destructive",
            });
          },
        },
      );
    },
    [recategorizeBulk, queryClient, toast, undoBulkRecategorize],
  );

  const offerBulkRecategorize = useCallback(
    (rule: BulkRecategorizeRule) => {
      if (rule.candidateCount <= 0) return;
      const isUncategorizedSweep = rule.fromCategoryId === null;
      const toCategoryName = rule.toCategoryName ?? "this category";
      const n = rule.candidateCount;
      const samples = rule.sampleTransactions ?? [];
      // Title language differs slightly between the two prompt
      // shapes — repointed seed rules read "Move N past payments
      // into <category>?", brand-new rules read "Apply to past
      // too?" with a description spelling out the uncategorized
      // sweep semantics.
      const title = isUncategorizedSweep
        ? "Apply to past too?"
        : `Move ${n} past payment${n === 1 ? "" : "s"} into ${toCategoryName}?`;
      const description = isUncategorizedSweep
        ? `${n} older uncategorized "${rule.pattern}" charge${n === 1 ? "" : "s"} can move to this category.`
        : (
            <div className="flex flex-col gap-1">
              <span>
                Older "{rule.pattern}" transaction{n === 1 ? "" : "s"} still
                in the rule's previous category will be moved.
              </span>
              {samples.length > 0 && (
                <button
                  type="button"
                  className="self-start text-xs underline underline-offset-2 hover:text-foreground"
                  data-testid="link-show-rule-matches"
                  onClick={() => setPreviewState(rule)}
                >
                  Show {samples.length === n
                    ? n === 1
                      ? "the match"
                      : `all ${n} matches`
                    : `the first ${samples.length} of ${n} matches`}
                </button>
              )}
            </div>
          );
      toast({
        title,
        description,
        action: (
          <ToastAction
            altText="Apply to past charges"
            data-testid="action-apply-rule-past"
            onClick={() => applyBulkRecategorize(rule)}
          >
            Apply
          </ToastAction>
        ),
      });
    },
    [toast, applyBulkRecategorize],
  );

  const previewDialog = (
    <Dialog
      open={previewState !== null}
      onOpenChange={(open) => {
        if (!open) setPreviewState(null);
      }}
    >
      <DialogContent
        className="sm:max-w-[480px]"
        data-testid="dialog-rule-matches-preview"
      >
        <DialogHeader>
          <DialogTitle>
            {previewState
              ? `Move ${previewState.candidateCount} past payment${previewState.candidateCount === 1 ? "" : "s"} into ${previewState.toCategoryName ?? "this category"}?`
              : ""}
          </DialogTitle>
          <DialogDescription>
            {previewState
              ? `These transactions still match "${previewState.pattern}" and sit in the rule's previous category. Confirm to move them all into ${previewState.toCategoryName ?? "this category"}.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {previewState && (previewState.sampleTransactions ?? []).length > 0 && (
          <div
            className="max-h-[320px] overflow-y-auto rounded-md border divide-y divide-border"
            data-testid="list-rule-matches"
          >
            {(previewState.sampleTransactions ?? []).map((s) => (
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
                  <div className="mt-0.5">
                    <MatchedRuleChip
                      categoryId={previewState.fromCategoryId}
                      matchedRuleId={s.matchedRuleId}
                      rules={mappingRules}
                      testIdSuffix={`rule-match-${s.id}`}
                      variant="compact"
                    />
                  </div>
                </div>
                <span
                  className={cn(
                    "tabular-nums whitespace-nowrap",
                    parseSigned(s.amount) > 0 && "text-positive",
                    parseSigned(s.amount) < 0 && "text-foreground",
                  )}
                >
                  {formatCurrency(s.amount)}
                </span>
              </div>
            ))}
          </div>
        )}
        {previewState &&
          (previewState.sampleTransactions ?? []).length <
            previewState.candidateCount && (
            <p className="text-xs text-muted-foreground">
              Showing the {(previewState.sampleTransactions ?? []).length}{" "}
              most-recent of {previewState.candidateCount} matches. Apply
              will move all {previewState.candidateCount}.
            </p>
          )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => setPreviewState(null)}
            data-testid="button-rule-matches-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!previewState) return;
              applyBulkRecategorize(previewState);
              setPreviewState(null);
            }}
            disabled={recategorizeBulk.isPending}
            data-testid="button-rule-matches-apply"
          >
            Move {previewState?.candidateCount ?? 0} transaction
            {previewState?.candidateCount === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { offerBulkRecategorize, previewDialog };
}
