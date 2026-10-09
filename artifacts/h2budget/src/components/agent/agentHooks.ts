import { useQueryClient } from "@tanstack/react-query";
import {
  getListAgentActionsQueryKey,
  getListAgentFindingsQueryKey,
  useListAgentActions,
  useListAgentFindings,
} from "@workspace/api-client-react/features";
import { AGENT_CACHE, findingsParams, trailParams } from "@/lib/agentTrail";

/**
 * (F3) The agent trail and the open findings, from the `features` client, under
 * one key and one set of options each. Only lazy chunks import this file: the
 * Review › Categories page and the dashboard's below-the-fold chunk.
 */
export const useAgentTrail = () =>
  useListAgentActions(trailParams, { query: { queryKey: getListAgentActionsQueryKey(trailParams), ...AGENT_CACHE } });

export const useOpenFindings = () =>
  useListAgentFindings(findingsParams, { query: { queryKey: getListAgentFindingsQueryKey(findingsParams), ...AGENT_CACHE } });

/** After a write that moves the trail or the findings (and the queue behind them): ask again. */
export function useRefreshAgent(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: getListAgentActionsQueryKey().slice(0, 1) });
    void qc.invalidateQueries({ queryKey: getListAgentFindingsQueryKey().slice(0, 1) });
  };
}
