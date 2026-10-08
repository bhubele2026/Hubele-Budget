import { useCallback } from "react";
import { useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import {
  getListLearnedRulesQueryKey,
  listLearnedRules,
  useApplyLearnedRuleRetroactively,
  useUncategorizeTransactionsByIds,
  useUndoCategoryDecision,
  useUpdateTransaction,
  type Category,
  type LearnedRule,
  type UpdateTransactionResponse,
} from "@workspace/api-client-react";
import { isBankLedgerListKey } from "@/data/mutationInvalidation";
import type { LedgerPage, LedgerRow } from "@workspace/api-client-react/ledger";
import { useToast } from "@/kit/Toast";
import { invalidateActivity } from "@/data/activityData";
import { titleCase } from "./words";

/** The two fields a ledger row may carry that the generated type does not name yet. */
export type RowExtras = { categoryProvisional?: boolean; splitCount?: number };
export const isProvisional = (row: LedgerRow): boolean => (row as LedgerRow & RowExtras).categoryProvisional === true;

type Cached = LedgerPage | InfiniteData<LedgerPage> | undefined;

function mapRow(old: Cached, id: string, patch: Partial<LedgerRow> & RowExtras): Cached {
  const fix = (page: LedgerPage): LedgerPage => ({
    ...page,
    rows: page.rows.map((r) => (r.id === id ? ({ ...r, ...patch } as LedgerRow) : r)),
  });
  if (!old) return old;
  if ("pages" in old) return { ...old, pages: old.pages.map(fix) };
  return fix(old);
}

/** Change one row in every cached ledger list; returns a function that puts the old lists back. */
export function patchLedgerCaches(qc: QueryClient, id: string, patch: Partial<LedgerRow> & RowExtras): () => void {
  const before = qc.getQueriesData<Cached>({ predicate: (q) => isBankLedgerListKey(q.queryKey) });
  qc.setQueriesData<Cached>({ predicate: (q) => isBankLedgerListKey(q.queryKey) }, (old) => mapRow(old, id, patch));
  return () => {
    for (const [key, data] of before) qc.setQueryData(key, data);
  };
}

/**
 * ⭐ FILE A CHARGE BY HAND — and let H2 learn from it, visibly.
 *
 * The chip changes at once (optimistic) and rolls back, with a notice, if the
 * server says no. The notice names the merchant H2 will now remember and offers
 * Undo; when the server reports similar unlocked charges it also offers "Apply
 * to N similar", which moves nothing until it is pressed.
 *
 * ⚠️ API GAPS THIS WORKS AROUND (see the S2 review note):
 *  - `PATCH /transactions/:id` does not return the decision id. If a later API
 *    adds `decisionId`, Undo uses `POST /category-decisions/:id/undo`; until
 *    then it puts the previous category back (or clears it).
 *  - It does not return the learned rule id either. "Apply to N similar" finds
 *    the rule in `GET /learned-rules` by the row's merchant signature and the
 *    category just chosen, then asks the server to apply it.
 */
export function useFiling() {
  const qc = useQueryClient();
  const toast = useToast();
  const update = useUpdateTransaction();
  const undoDecision = useUndoCategoryDecision();
  const uncategorize = useUncategorizeTransactionsByIds();
  const apply = useApplyLearnedRuleRetroactively();

  return useCallback(
    async (row: LedgerRow, category: Category): Promise<boolean> => {
      if (row.categoryId === category.id && !isProvisional(row)) return true;
      const prevId = row.categoryId ?? null;
      const prevProvisional = isProvisional(row);
      const merchant = titleCase(row.displayName || row.description);
      const rollback = patchLedgerCaches(qc, row.id, { categoryId: category.id, categoryProvisional: false });

      let res: UpdateTransactionResponse & { decisionId?: string; learnedRuleId?: string };
      try {
        res = await update.mutateAsync({ id: row.id, data: { categoryId: category.id } });
      } catch {
        rollback();
        toast.show({ message: "Couldn't file that charge. It's back as it was.", tone: "error" });
        return false;
      }
      invalidateActivity(qc);

      const undo = async () => {
        const restore = patchLedgerCaches(qc, row.id, { categoryId: prevId, categoryProvisional: prevProvisional });
        try {
          if (res.decisionId) await undoDecision.mutateAsync({ id: res.decisionId });
          else if (prevId) await update.mutateAsync({ id: row.id, data: { categoryId: prevId } });
          else await uncategorize.mutateAsync({ data: { ids: [row.id], fromCategoryId: category.id } });
          invalidateActivity(qc);
          toast.show({ message: "Put back." });
        } catch {
          restore();
          patchLedgerCaches(qc, row.id, { categoryId: category.id, categoryProvisional: false });
          toast.show({ message: "Couldn't undo that. The new category stays.", tone: "error" });
        }
      };

      const similar = res.retroactiveCandidates?.count ?? 0;
      const applySimilar = async () => {
        try {
          let ruleId = res.learnedRuleId ?? null;
          if (!ruleId) {
            const rules: LearnedRule[] = await qc.fetchQuery({
              queryKey: getListLearnedRulesQueryKey(),
              queryFn: ({ signal }) => listLearnedRules({ signal }),
              staleTime: 0,
            });
            const sig = row.merchantSignature;
            const mine = rules.filter((r) => !r.disabled && r.categoryId === category.id && (!sig || r.signature === sig));
            ruleId = (mine.find((r) => r.scope === "merchant") ?? mine[0])?.id ?? null;
          }
          if (!ruleId) throw new Error("rule not found");
          const done = await apply.mutateAsync({ id: ruleId });
          toast.show({ message: done.updated === 1 ? "Filed 1 similar charge." : `Filed ${done.updated} similar charges.` });
        } catch {
          toast.show({ message: "Couldn't apply that to the similar charges.", tone: "error" });
        }
      };

      toast.show({
        message: `Filed under ${category.name}. H2 will remember ${merchant}.`,
        actions: [
          { label: "Undo", onPress: undo },
          ...(similar > 0 ? [{ label: `Apply to ${similar} similar`, onPress: applySimilar }] : []),
        ],
      });
      return true;
    },
    [qc, toast, update, undoDecision, uncategorize, apply],
  );
}
