import { useQueryClient } from "@tanstack/react-query";
import {
  getListLearnedRulesQueryKey,
  listLearnedRules,
  useApplyLearnedRuleRetroactively,
  useUndoCategoryDecision,
  type LearnedRule,
  type ReviewResolution,
} from "@workspace/api-client-react/features";
import { toastWithActions } from "@/components/ui/action-toast";
import { toast } from "@/hooks/use-toast";
import { filedWords } from "@/lib/reviewQueue";

/** Find the learned rule an answer just wrote, to apply it to similar charges. */
export function findRule(rules: readonly LearnedRule[], categoryId: string, description: string): LearnedRule | null {
  const text = description.toLowerCase();
  const mine = rules.filter((r) => !r.disabled && r.categoryId === categoryId && r.signature && text.includes(r.signature.toLowerCase()));
  return (mine.find((r) => r.scope === "merchant") ?? mine[0]) ?? null;
}

/**
 * What a category answer says afterwards (Review › Categories and Banking's
 * Needs you share it): "Filed under X. H2 will remember Y." with Undo (puts the
 * old category back through the decision's own undo) and, when the server
 * reports similar unlocked charges, "Apply to N similar" (moves nothing until
 * pressed).
 */
export function useCategoryFollowUps() {
  const qc = useQueryClient();
  const undoDecision = useUndoCategoryDecision();
  const applyRule = useApplyLearnedRuleRetroactively();

  return async (
    item: { description: string },
    res: ReviewResolution,
    category: { id: string; name: string },
    onUndone?: () => void,
  ): Promise<void> => {
    const undo = res.userDecisionId
      ? {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await undoDecision.mutateAsync({ id: res.userDecisionId! });
                onUndone?.();
                toast({ title: "Put back." });
              } catch {
                toast({ title: "Couldn't undo that. The new category stays.", variant: "destructive" });
              }
            })();
          },
        }
      : null;
    const similar = res.retroactiveCandidates?.count ?? 0;
    let rule: LearnedRule | null = null;
    if (similar > 0) {
      try {
        const rules = await qc.fetchQuery({
          queryKey: getListLearnedRulesQueryKey(),
          queryFn: ({ signal }) => listLearnedRules({ signal }),
          staleTime: 0,
        });
        rule = findRule(rules, category.id, item.description);
      } catch {
        rule = null;
      }
    }
    const applyBtn =
      rule && similar > 0
        ? {
            label: `Apply to ${similar} similar`,
            onClick: () => {
              void (async () => {
                try {
                  const done = await applyRule.mutateAsync({ id: rule!.id });
                  toast({ title: done.updated === 1 ? "Filed 1 similar charge." : `Filed ${done.updated} similar charges.` });
                } catch {
                  toast({ title: "Couldn't apply that to the similar charges.", variant: "destructive" });
                }
              })();
            },
          }
        : null;
    const title = filedWords(category.name, item.description);
    if (undo && applyBtn) toastWithActions({ title, actions: [undo, applyBtn] });
    else if (undo || applyBtn) toastWithActions({ title, actions: [(undo ?? applyBtn)!] });
    else toast({ title });
  };
}
