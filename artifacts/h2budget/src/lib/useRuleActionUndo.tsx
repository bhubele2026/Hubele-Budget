import {
  useDeleteMappingRule,
  useUpdateMappingRule,
  getListMappingRulesQueryKey,
  type RuleAction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ToastAction, type ToastActionElement } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";

/**
 * Builds the "Undo" affordance shown alongside a "Categorized" toast when
 * the auto-learn flow on PATCH /transactions/:id created or repointed a
 * mapping rule. Undo only reverts the rule itself — the transaction's own
 * categoryId is left at the user's manual pick, so undoing a wrong rule
 * doesn't also un-categorize the row that triggered it.
 *
 * Behavior by ruleAction.kind:
 *  - `created` / `created_priority_bump` → DELETE the just-created rule
 *    (uses `ruleId`).
 *  - `repointed` → PATCH the rule back to its previous categoryId
 *    (uses `ruleId` + `previousCategoryId`). When `previousCategoryId`
 *    is null (rule was unaimed) we still PATCH the rule back to null
 *    so it stops auto-routing into the user's freshly chosen category.
 *  - Any other kind, or missing ruleId, returns `null` so the caller
 *    can omit the action prop entirely.
 */
export function useRuleActionUndo() {
  const deleteRule = useDeleteMappingRule();
  const updateRule = useUpdateMappingRule();
  const qc = useQueryClient();
  const { toast } = useToast();

  function buildUndoAction(
    action: RuleAction | undefined,
  ): ToastActionElement | null {
    if (!action) return null;
    const invalidateRules = () =>
      qc.invalidateQueries({ queryKey: getListMappingRulesQueryKey() });

    if (
      (action.kind === "created" ||
        action.kind === "created_priority_bump") &&
      action.ruleId
    ) {
      const ruleId = action.ruleId;
      return (
        <ToastAction
          altText="Undo rule"
          data-testid="action-undo-rule"
          onClick={() => {
            deleteRule.mutate(
              { id: ruleId },
              {
                onSuccess: () => {
                  invalidateRules();
                  toast({ title: "Removed the new rule" });
                },
                onError: (e) => {
                  toast({
                    title: "Couldn't undo rule",
                    description: (e as Error).message,
                    variant: "destructive",
                  });
                },
              },
            );
          }}
        >
          Undo
        </ToastAction>
      );
    }

    if (action.kind === "repointed" && action.ruleId) {
      const ruleId = action.ruleId;
      const prev = action.previousCategoryId ?? null;
      // The orval-generated RuleAction widens `pattern` to optional/
      // nullable across all kinds, but for `repointed` the server
      // always populates it. Bail on the unexpected null/undefined
      // case rather than firing a malformed PATCH.
      const pattern = action.pattern;
      if (!pattern) return null;
      return (
        <ToastAction
          altText="Undo rule"
          data-testid="action-undo-rule"
          onClick={() => {
            updateRule.mutate(
              {
                id: ruleId,
                // PATCH /mapping-rules/:id requires `pattern`. We echo
                // the existing pattern back so the rule stays the same
                // shape and only its categoryId is restored to the
                // pre-PATCH value.
                data: { pattern, categoryId: prev },
              },
              {
                onSuccess: () => {
                  invalidateRules();
                  toast({ title: "Restored the previous rule" });
                },
                onError: (e) => {
                  toast({
                    title: "Couldn't undo rule",
                    description: (e as Error).message,
                    variant: "destructive",
                  });
                },
              },
            );
          }}
        >
          Undo
        </ToastAction>
      );
    }

    return null;
  }

  return buildUndoAction;
}
