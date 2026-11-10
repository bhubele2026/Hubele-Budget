import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AvalancheWeekPayResult } from "@workspace/api-client-react";
// The lazy `features` module: only lazy chunks (the home page's below-the-fold
// box, the Debt page) press "We paid it", so these hooks never ride on the
// landing chunk.
import {
  getGetAvalancheWeeklyQueryKey,
  usePayAvalancheWeek,
  useUndoAvalancheWeekPay,
} from "@workspace/api-client-react/features";
import { getGetAvalancheExtraQueryKey, getListDebtsQueryKey } from "@workspace/api-client-react";
import { invalidateForecastFamily } from "@/lib/invalidateForecast";
import { weekPayErrorWords } from "@/lib/avalancheWeekPay";

/**
 * ⭐ (AVAL-W) "We paid it" and its Undo — ONE hook for the home page's box and
 * the Debt page's weekly panel.
 *
 * A success runs through the app's central rule (`App.tsx`'s `mutationCache`,
 * `lib/mutationInvalidation.ts`: the spine behind the home tiles, the cash
 * signal, the weekly plan). On top, exactly what a logged debt payment marks
 * stale on the Debt page (`pages/avalanche.tsx`, `useCreateDebtPayment`): the
 * debts, the avalanche extra and the whole forecast family. The answer carries
 * the fresh weekly plan, so the box flips to "Paid" on the frame the server
 * answers instead of after a refetch.
 *
 * A refusal shows the server's own words and re-reads the plan (someone may
 * have answered the week elsewhere).
 */
export function useAvalancheWeekPay() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const onSuccess = (res: AvalancheWeekPayResult) => {
    setError(null);
    qc.setQueryData(getGetAvalancheWeeklyQueryKey(), res.plan);
    void qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetAvalancheExtraQueryKey() });
    invalidateForecastFamily(qc);
  };
  const onError = (e: unknown) => {
    setError(weekPayErrorWords(e));
    void qc.invalidateQueries({ queryKey: getGetAvalancheWeeklyQueryKey() });
  };
  const payM = usePayAvalancheWeek({ mutation: { onSuccess, onError } });
  const undoM = useUndoAvalancheWeekPay({ mutation: { onSuccess, onError } });
  return {
    pay: (date: string) => {
      setError(null);
      payM.mutate({ data: { date } });
    },
    undo: (id: string) => {
      setError(null);
      undoM.mutate({ id });
    },
    paying: payM.isPending,
    undoing: undoM.isPending,
    error,
  };
}

export type AvalancheWeekPayControls = ReturnType<typeof useAvalancheWeekPay>;
